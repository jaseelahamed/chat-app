require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const { connectDatabase, isDatabaseReady, User, Message } = require('./db');

const AGORA_APP_ID = (process.env.AGORA_APP_ID || '').trim();
const AGORA_APP_CERTIFICATE = (process.env.AGORA_APP_CERTIFICATE || '').trim();
const AUTH_SECRET =
  (process.env.AUTH_SECRET || '').trim() ||
  AGORA_APP_CERTIFICATE ||
  'pulse-connect-auth-secret';

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024, // 5 MB max payload for inline image/file shares
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT']
  }
});

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

app.use((req, res, next) => {
  const reqOrigin = req.headers.origin;
  if (CORS_ORIGIN === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && CORS_ORIGIN.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(FRONTEND_DIR));

// Default public channels
const DEFAULT_CHANNELS = [
  { id: 'channel:general', name: 'General', topic: 'Team-wide real-time chat & updates' },
  { id: 'channel:lounge', name: 'Lounge', topic: 'Casual hangouts, memes & quick syncs' },
  { id: 'channel:projects', name: 'Projects', topic: 'Collaborate on builds & brainstorms' }
];

const MAX_HISTORY_PER_ROOM = 100;

// Live connection state keyed by userId
const onlineUsersById = new Map(); // userId -> { id, name, username, avatar, color, status, socketId, peerId }
const userIdBySocket = new Map();  // socketId -> userId
const activeCalls = new Map();     // dmRoomId -> { callType, callerId, calleeId, channel, connectedAt }

// ---------------- Auth Helpers ----------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = String(storedHash || '').split(':');
  if (!salt || !expectedHex) return false;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function signAuthToken(payload) {
  const body = {
    ...payload,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed.userId || (parsed.exp && parsed.exp < Date.now())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function serializeDbUser(doc, liveEntry) {
  return {
    id: doc.userId,
    name: doc.name,
    username: doc.username,
    avatar: doc.avatar,
    color: doc.color,
    status: liveEntry ? liveEntry.status : 'offline'
  };
}

async function buildAllUsersList() {
  if (!isDatabaseReady()) {
    return Array.from(onlineUsersById.values()).map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      avatar: u.avatar,
      color: u.color,
      status: u.status
    }));
  }

  const dbUsers = await User.find({}, { passwordHash: 0 }).sort({ name: 1 }).lean();
  const list = dbUsers.map((doc) => serializeDbUser(doc, onlineUsersById.get(doc.userId)));

  // Sort online/in-call users before offline users
  const rank = { 'in-call': 0, online: 1, offline: 2 };
  list.sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || a.name.localeCompare(b.name));
  return list;
}

async function broadcastPresence() {
  try {
    const users = await buildAllUsersList();
    io.emit('presence:update', users);
  } catch (err) {
    console.error('broadcastPresence failed:', err.message);
  }
}

function getDmRoomId(userA, userB) {
  return `dm:${[userA, userB].sort().join(':')}`;
}

function getAgoraChannelName(userA, userB) {
  const hash = crypto.createHash('sha256').update(getDmRoomId(userA, userB)).digest('hex').slice(0, 20);
  return `pulse-${hash}-${Date.now().toString(36)}`;
}

function formatMessageDoc(doc) {
  return {
    id: doc.id,
    roomId: doc.roomId,
    type: doc.type || 'text',
    callType: doc.callType,
    senderId: doc.senderId,
    senderName: doc.senderName,
    senderAvatar: doc.senderAvatar,
    senderColor: doc.senderColor,
    text: doc.text || '',
    attachment: doc.attachment && doc.attachment.dataUrl ? doc.attachment : null,
    replyTo: doc.replyTo && doc.replyTo.id ? doc.replyTo : null,
    reactions: doc.reactions || {},
    createdAt: doc.createdAt
  };
}

async function loadUserChatHistory(userId) {
  const history = {};
  for (const ch of DEFAULT_CHANNELS) {
    history[ch.id] = [];
  }

  if (!isDatabaseReady()) return history;

  // Load latest channel messages
  await Promise.all(
    DEFAULT_CHANNELS.map(async (ch) => {
      const docs = await Message.find({ roomId: ch.id })
        .sort({ createdAt: -1 })
        .limit(MAX_HISTORY_PER_ROOM)
        .lean();
      history[ch.id] = docs.reverse().map(formatMessageDoc);
    })
  );

  // Load all DM conversations involving this user
  const dmDocs = await Message.find({ targetType: 'dm', participants: userId })
    .sort({ createdAt: 1 })
    .lean();

  for (const doc of dmDocs) {
    if (!history[doc.roomId]) {
      history[doc.roomId] = [];
    }
    const peerId = (doc.participants || []).find((p) => p !== userId) || '';
    history[doc.roomId].push({
      ...formatMessageDoc(doc),
      dmPeerId: peerId
    });
  }

  return history;
}

// ---------------- REST Endpoints ----------------
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    onlineUsers: onlineUsersById.size,
    dbConnected: isDatabaseReady(),
    agoraConfigured: Boolean(AGORA_APP_ID && AGORA_APP_CERTIFICATE)
  });
});

app.post('/auth/register', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Database is not connected. Set MONGODB_URI on the backend.' });
  }

  try {
    const name = String(req.body?.name || '').trim().slice(0, 32);
    const rawUsername = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const avatar = String(req.body?.avatar || name[0]?.toUpperCase() || '⚡').slice(0, 8);
    const color = String(req.body?.color || 'linear-gradient(135deg, #6366f1, #8b5cf6)').slice(0, 96);

    if (!name) {
      return res.status(400).json({ error: 'Please enter your name.' });
    }
    if (!/^[a-z0-9._-]{3,24}$/.test(rawUsername)) {
      return res.status(400).json({
        error: 'Username must be 3–24 characters using letters, numbers, ".", "_", or "-".'
      });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }

    const existing = await User.findOne({ username: rawUsername }).lean();
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken.' });
    }

    const userDoc = await User.create({
      userId: crypto.randomUUID(),
      name,
      username: rawUsername,
      passwordHash: hashPassword(password),
      avatar,
      color
    });

    const user = {
      id: userDoc.userId,
      name: userDoc.name,
      username: userDoc.username,
      avatar: userDoc.avatar,
      color: userDoc.color
    };

    const token = signAuthToken({ userId: user.id, username: user.username });
    broadcastPresence();
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Username is already taken.' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Could not register account.' });
  }
});

app.post('/auth/login', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Database is not connected. Set MONGODB_URI on the backend.' });
  }

  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const userDoc = await User.findOne({ username }).lean();
    if (!userDoc || !verifyPassword(password, userDoc.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = {
      id: userDoc.userId,
      name: userDoc.name,
      username: userDoc.username,
      avatar: userDoc.avatar,
      color: userDoc.color
    };
    const token = signAuthToken({ userId: user.id, username: user.username });
    res.json({ token, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

app.put('/auth/profile', async (req, res) => {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Database is not connected.' });
  }

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const claims = verifyAuthToken(token);
  if (!claims) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const name = String(req.body?.name || '').trim().slice(0, 32);
    const avatar = String(req.body?.avatar || '').slice(0, 8);
    const color = String(req.body?.color || '').slice(0, 96);
    if (!name) {
      return res.status(400).json({ error: 'Name cannot be empty.' });
    }

    const updated = await User.findOneAndUpdate(
      { userId: claims.userId },
      { $set: { name, ...(avatar ? { avatar } : {}), ...(color ? { color } : {}) } },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const live = onlineUsersById.get(updated.userId);
    if (live) {
      live.name = updated.name;
      live.avatar = updated.avatar;
      live.color = updated.color;
    }

    await broadcastPresence();
    res.json({
      user: {
        id: updated.userId,
        name: updated.name,
        username: updated.username,
        avatar: updated.avatar,
        color: updated.color
      }
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Could not update profile.' });
  }
});

app.get('/agora/token', (req, res) => {
  if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
    return res.status(500).json({
      error: 'AGORA_APP_ID and AGORA_APP_CERTIFICATE must be set on the backend.'
    });
  }

  const rawChannel = String(req.query.channel || '').trim();
  if (!rawChannel || rawChannel.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(rawChannel)) {
    return res.status(400).json({ error: 'Invalid or missing channel name.' });
  }

  const parsedUid = Number(req.query.uid);
  const uid =
    Number.isInteger(parsedUid) && parsedUid > 0 && parsedUid <= 2147483647
      ? parsedUid
      : Math.floor(1 + Math.random() * 2147483646);

  const expireSeconds = 3600;
  const token = RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_APP_CERTIFICATE,
    rawChannel,
    uid,
    RtcRole.PUBLISHER,
    expireSeconds,
    expireSeconds
  );

  res.json({
    appId: AGORA_APP_ID,
    channel: rawChannel,
    uid,
    token
  });
});

// ---------------- Call Helpers ----------------
function formatCallDuration(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

async function recordCallLog(userAId, userBId, summaryText, callType = 'audio') {
  if (!userAId || !userBId) return;
  const roomId = getDmRoomId(userAId, userBId);
  const logMsg = {
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    roomId,
    targetType: 'dm',
    participants: [userAId, userBId].sort(),
    type: 'call-log',
    callType,
    senderId: userAId,
    text: summaryText,
    reactions: {},
    createdAt: Date.now()
  };

  if (isDatabaseReady()) {
    Message.create(logMsg).catch((err) => console.error('Save call-log error:', err.message));
  }

  const userA = onlineUsersById.get(userAId);
  const userB = onlineUsersById.get(userBId);
  if (userA) io.to(userA.socketId).emit('message:new', { ...logMsg, dmPeerId: userBId });
  if (userB) io.to(userB.socketId).emit('message:new', { ...logMsg, dmPeerId: userAId });
}

function clearCallPairing(userAId, userBId, reason = 'ended') {
  const userA = onlineUsersById.get(userAId);
  const userB = onlineUsersById.get(userBId);
  const roomId = userAId && userBId ? getDmRoomId(userAId, userBId) : null;
  const session = roomId ? activeCalls.get(roomId) : null;
  if (roomId) activeCalls.delete(roomId);

  if (session) {
    const label = session.callType === 'video' ? '📹 Video call' : '📞 Voice call';
    if (reason === 'cancelled') {
      recordCallLog(session.callerId, session.calleeId, `${label} · Missed`, session.callType);
    } else if (session.connectedAt) {
      const dur = formatCallDuration(Date.now() - session.connectedAt);
      recordCallLog(session.callerId, session.calleeId, `${label} · ${dur}`, session.callType);
    } else {
      recordCallLog(session.callerId, session.calleeId, `${label} ended`, session.callType);
    }
  }

  if (userA) {
    userA.status = 'online';
    userA.peerId = null;
  }
  if (userB) {
    userB.status = 'online';
    userB.peerId = null;
    io.to(userB.socketId).emit('call:ended', { from: userAId, reason });
  }
  broadcastPresence();
}

// ---------------- Socket Events ----------------
io.on('connection', (socket) => {
  socket.on('user:join', async (payload = {}) => {
    try {
      if (!isDatabaseReady()) {
        socket.emit('session:error', {
          message: 'Database is not connected yet. Set MONGODB_URI on the backend.'
        });
        return;
      }

      const claims = verifyAuthToken(payload.token);
      if (!claims) {
        socket.emit('session:error', { message: 'Please log in to continue.' });
        return;
      }

      const userDoc = await User.findOne({ userId: claims.userId }, { passwordHash: 0 }).lean();
      if (!userDoc) {
        socket.emit('session:error', { message: 'Account not found. Please log in again.' });
        return;
      }

      const existing = onlineUsersById.get(userDoc.userId);
      if (existing && existing.socketId !== socket.id) {
        userIdBySocket.delete(existing.socketId);
      }

      const user = {
        id: userDoc.userId,
        name: userDoc.name,
        username: userDoc.username,
        avatar: userDoc.avatar,
        color: userDoc.color,
        status: existing?.peerId ? 'in-call' : 'online',
        socketId: socket.id,
        peerId: existing?.peerId || null
      };

      onlineUsersById.set(user.id, user);
      userIdBySocket.set(socket.id, user.id);

      for (const ch of DEFAULT_CHANNELS) {
        socket.join(ch.id);
      }

      const [users, history] = await Promise.all([
        buildAllUsersList(),
        loadUserChatHistory(user.id)
      ]);

      socket.emit('session:ready', {
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          avatar: user.avatar,
          color: user.color,
          status: user.status
        },
        channels: DEFAULT_CHANNELS,
        users,
        history
      });

      broadcastPresence();
    } catch (err) {
      console.error('user:join error:', err);
      socket.emit('session:error', { message: 'Failed to load your session.' });
    }
  });

  // Load DM history on demand
  socket.on('dm:history', async ({ peerId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !peerId || !isDatabaseReady()) return;
    const roomId = getDmRoomId(userId, peerId);
    try {
      const docs = await Message.find({ roomId }).sort({ createdAt: 1 }).limit(MAX_HISTORY_PER_ROOM).lean();
      socket.emit('dm:history', {
        roomId,
        peerId,
        messages: docs.map((d) => ({ ...formatMessageDoc(d), dmPeerId: peerId }))
      });
    } catch (err) {
      console.error('dm:history error:', err.message);
    }
  });

  // Real-time messaging (channel or DM)
  socket.on('message:send', async (payload = {}) => {
    const senderId = userIdBySocket.get(socket.id);
    const sender = onlineUsersById.get(senderId);
    if (!sender) return;

    const { targetType, targetId, text, attachment, replyTo } = payload;
    const trimmedText = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    if (!trimmedText && !attachment) return;

    let safeAttachment = null;
    if (attachment && typeof attachment === 'object' && typeof attachment.dataUrl === 'string') {
      if (attachment.dataUrl.length <= 4.5 * 1024 * 1024) {
        safeAttachment = {
          name: String(attachment.name || 'file').slice(0, 120),
          type: String(attachment.type || 'application/octet-stream').slice(0, 100),
          size: Number(attachment.size) || 0,
          dataUrl: attachment.dataUrl
        };
      }
    }

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: sender.id,
      senderName: sender.name,
      senderAvatar: sender.avatar,
      senderColor: sender.color,
      text: trimmedText,
      attachment: safeAttachment,
      replyTo:
        replyTo && typeof replyTo === 'object'
          ? {
              id: String(replyTo.id || '').slice(0, 64),
              senderName: String(replyTo.senderName || '').slice(0, 32),
              text: String(replyTo.text || '').slice(0, 120)
            }
          : null,
      reactions: {},
      createdAt: Date.now()
    };

    if (targetType === 'channel') {
      const validChannel = DEFAULT_CHANNELS.some((c) => c.id === targetId);
      if (!validChannel) return;

      const dbPayload = {
        ...message,
        roomId: targetId,
        targetType: 'channel',
        participants: []
      };
      if (isDatabaseReady()) {
        await Message.create(dbPayload).catch((err) => console.error('Save channel msg error:', err.message));
      }

      io.to(targetId).emit('message:new', { ...message, roomId: targetId });
    } else if (targetType === 'dm') {
      if (!targetId || targetId === sender.id) return;
      const roomId = getDmRoomId(sender.id, targetId);
      const dbPayload = {
        ...message,
        roomId,
        targetType: 'dm',
        participants: [sender.id, targetId].sort()
      };
      if (isDatabaseReady()) {
        await Message.create(dbPayload).catch((err) => console.error('Save DM msg error:', err.message));
      }

      socket.emit('message:new', { ...message, roomId, dmPeerId: targetId });
      const recipient = onlineUsersById.get(targetId);
      if (recipient && recipient.socketId !== socket.id) {
        io.to(recipient.socketId).emit('message:new', {
          ...message,
          roomId,
          dmPeerId: sender.id
        });
      }
    }
  });

  // Message emoji reaction toggle
  socket.on('message:react', async ({ roomId, messageId, emoji, targetType, targetId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !roomId || !messageId || !emoji || !isDatabaseReady()) return;

    const cleanEmoji = String(emoji).slice(0, 8);
    const msg = await Message.findOne({ id: messageId, roomId }).lean();
    if (!msg) return;

    const reactions = { ...(msg.reactions || {}) };
    const list = Array.isArray(reactions[cleanEmoji]) ? [...reactions[cleanEmoji]] : [];
    const idx = list.indexOf(userId);
    if (idx === -1) {
      list.push(userId);
    } else {
      list.splice(idx, 1);
    }

    if (list.length === 0) {
      delete reactions[cleanEmoji];
    } else {
      reactions[cleanEmoji] = list;
    }

    await Message.updateOne({ id: messageId, roomId }, { $set: { reactions } });

    const updatePayload = { roomId, messageId, reactions };
    if (targetType === 'channel') {
      io.to(roomId).emit('message:reacted', updatePayload);
    } else if (targetType === 'dm') {
      socket.emit('message:reacted', updatePayload);
      const peer = onlineUsersById.get(targetId);
      if (peer && peer.socketId !== socket.id) {
        io.to(peer.socketId).emit('message:reacted', updatePayload);
      }
    }
  });

  // Delete own message
  socket.on('message:delete', async ({ roomId, messageId, targetType, targetId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !roomId || !messageId || !isDatabaseReady()) return;

    const result = await Message.deleteOne({ id: messageId, roomId, senderId: userId });
    if (!result.deletedCount) return;

    const payload = { roomId, messageId };
    if (targetType === 'channel') {
      io.to(roomId).emit('message:deleted', payload);
    } else if (targetType === 'dm') {
      socket.emit('message:deleted', payload);
      const peer = onlineUsersById.get(targetId);
      if (peer && peer.socketId !== socket.id) {
        io.to(peer.socketId).emit('message:deleted', payload);
      }
    }
  });

  // Typing indicators
  socket.on('typing:state', ({ targetType, targetId, isTyping }) => {
    const senderId = userIdBySocket.get(socket.id);
    const sender = onlineUsersById.get(senderId);
    if (!sender) return;

    const payload = {
      userId: sender.id,
      userName: sender.name,
      targetType,
      targetId,
      isTyping: Boolean(isTyping)
    };

    if (targetType === 'channel') {
      socket.to(targetId).emit('typing:state', { ...payload, roomId: targetId });
    } else if (targetType === 'dm') {
      const peer = onlineUsersById.get(targetId);
      if (peer && peer.socketId !== socket.id) {
        io.to(peer.socketId).emit('typing:state', {
          ...payload,
          roomId: getDmRoomId(sender.id, targetId)
        });
      }
    }
  });

  // -------------------- Agora Call Signaling --------------------
  socket.on('call:request', ({ to, callType }) => {
    const callerId = userIdBySocket.get(socket.id);
    const caller = onlineUsersById.get(callerId);
    const callee = onlineUsersById.get(to);

    if (!caller || caller.status === 'in-call' || caller.peerId) return;
    if (!callee) {
      socket.emit('call:unavailable', { to, reason: 'User is offline' });
      return;
    }
    if (callee.id === caller.id) return;

    if (callee.status === 'in-call' || callee.peerId) {
      socket.emit('call:busy', { to: callee.id, name: callee.name });
      return;
    }

    const normalizedType = callType === 'video' ? 'video' : 'audio';
    const roomId = getDmRoomId(caller.id, callee.id);
    const channel = getAgoraChannelName(caller.id, callee.id);
    activeCalls.set(roomId, {
      callType: normalizedType,
      callerId: caller.id,
      calleeId: callee.id,
      channel,
      connectedAt: null
    });

    caller.status = 'in-call';
    caller.peerId = callee.id;
    callee.status = 'in-call';
    callee.peerId = caller.id;
    broadcastPresence();

    io.to(callee.socketId).emit('call:incoming', {
      from: {
        id: caller.id,
        name: caller.name,
        avatar: caller.avatar,
        color: caller.color
      },
      callType: normalizedType,
      channel
    });
  });

  socket.on('call:accept', ({ to }) => {
    const calleeId = userIdBySocket.get(socket.id);
    const caller = onlineUsersById.get(to);
    if (!calleeId || !caller) return;

    const roomId = getDmRoomId(calleeId, caller.id);
    const session = activeCalls.get(roomId);
    if (session) {
      session.connectedAt = Date.now();
    }

    io.to(caller.socketId).emit('call:accepted', {
      from: calleeId,
      channel: session?.channel || getAgoraChannelName(calleeId, caller.id)
    });
  });

  socket.on('call:reject', ({ to, reason }) => {
    const calleeId = userIdBySocket.get(socket.id);
    const callee = onlineUsersById.get(calleeId);
    const caller = onlineUsersById.get(to);

    if (calleeId && to) {
      const roomId = getDmRoomId(calleeId, to);
      const session = activeCalls.get(roomId);
      activeCalls.delete(roomId);
      if (session) {
        const label = session.callType === 'video' ? '📹 Video call' : '📞 Voice call';
        recordCallLog(
          session.callerId,
          session.calleeId,
          reason === 'busy' ? `${label} · Busy` : `${label} · Declined`,
          session.callType
        );
      }
    }

    if (callee) {
      callee.status = 'online';
      callee.peerId = null;
    }
    if (caller) {
      caller.status = 'online';
      caller.peerId = null;
      io.to(caller.socketId).emit('call:rejected', {
        from: calleeId,
        reason: reason || 'declined'
      });
    }
    broadcastPresence();
  });

  socket.on('call:cancel', ({ to }) => {
    const callerId = userIdBySocket.get(socket.id);
    clearCallPairing(callerId, to, 'cancelled');
  });

  socket.on('call:end', ({ to }) => {
    const userId = userIdBySocket.get(socket.id);
    clearCallPairing(userId, to, 'ended');
  });

  socket.on('call:media-state', ({ to, micEnabled, camEnabled, screenSharing }) => {
    const userId = userIdBySocket.get(socket.id);
    const peer = onlineUsersById.get(to);
    if (!userId || !peer) return;
    io.to(peer.socketId).emit('call:media-state', {
      from: userId,
      micEnabled,
      camEnabled,
      screenSharing
    });
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    const userId = userIdBySocket.get(socket.id);
    userIdBySocket.delete(socket.id);
    if (!userId) return;

    const user = onlineUsersById.get(userId);
    if (!user || user.socketId !== socket.id) return;

    if (user.peerId) {
      const peerId = user.peerId;
      clearCallPairing(userId, peerId, 'disconnected');
    }

    onlineUsersById.delete(userId);
    broadcastPresence();
  });
});

async function startServer() {
  await connectDatabase();
  server.listen(PORT, HOST, () => {
    console.log(`\n  Pulse Connect server running at:`);
    console.log(`  -> Local:   http://localhost:${PORT}`);
    console.log(`  -> Network: http://${HOST}:${PORT}`);
    console.log(`  -> Serving frontend from: ${FRONTEND_DIR}\n`);
  });
}

startServer();
