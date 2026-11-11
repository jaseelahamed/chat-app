require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const AGORA_APP_ID = (process.env.AGORA_APP_ID || '').trim();
const AGORA_APP_CERTIFICATE = (process.env.AGORA_APP_CERTIFICATE || '').trim();

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024, // 5 MB max payload for inline image/file shares
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST']
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.static(FRONTEND_DIR));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    onlineUsers: usersById.size,
    agoraConfigured: Boolean(AGORA_APP_ID && AGORA_APP_CERTIFICATE)
  });
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

// Default public channels
const DEFAULT_CHANNELS = [
  { id: 'channel:general', name: 'General', topic: 'Team-wide real-time chat & updates' },
  { id: 'channel:lounge', name: 'Lounge', topic: 'Casual hangouts, memes & quick syncs' },
  { id: 'channel:projects', name: 'Projects', topic: 'Collaborate on builds & brainstorms' }
];

const MAX_HISTORY_PER_ROOM = 100;

// Active users keyed by stable client userId
const usersById = new Map();       // userId -> { id, name, avatar, color, status, socketId, peerId }
const userIdBySocket = new Map();  // socketId -> userId
const roomHistory = new Map();     // roomId -> Array<Message>
const activeCalls = new Map();     // dmRoomId -> { callType, callerId, calleeId, connectedAt }

function getDmRoomId(userA, userB) {
  return `dm:${[userA, userB].sort().join(':')}`;
}

function getAgoraChannelName(userA, userB) {
  const hash = crypto.createHash('sha256').update(getDmRoomId(userA, userB)).digest('hex').slice(0, 20);
  return `pulse-${hash}-${Date.now().toString(36)}`;
}

function appendMessage(roomId, msg) {
  if (!roomHistory.has(roomId)) {
    roomHistory.set(roomId, []);
  }
  const list = roomHistory.get(roomId);
  list.push(msg);
  if (list.length > MAX_HISTORY_PER_ROOM) {
    list.shift();
  }
}

function findMessage(roomId, messageId) {
  const list = roomHistory.get(roomId);
  if (!list) return null;
  return list.find((m) => m.id === messageId) || null;
}

function serializeUsers() {
  return Array.from(usersById.values()).map((u) => ({
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    color: u.color,
    status: u.status
  }));
}

function broadcastPresence() {
  io.emit('presence:update', serializeUsers());
}

function formatCallDuration(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function recordCallLog(userAId, userBId, summaryText, callType = 'audio') {
  if (!userAId || !userBId) return;
  const roomId = getDmRoomId(userAId, userBId);
  const logMsg = {
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'call-log',
    callType,
    roomId,
    senderId: userAId,
    text: summaryText,
    reactions: {},
    createdAt: Date.now()
  };

  appendMessage(roomId, logMsg);
  const userA = usersById.get(userAId);
  const userB = usersById.get(userBId);
  if (userA) io.to(userA.socketId).emit('message:new', { ...logMsg, dmPeerId: userBId });
  if (userB) io.to(userB.socketId).emit('message:new', { ...logMsg, dmPeerId: userAId });
}

function clearCallPairing(userAId, userBId, reason = 'ended') {
  const userA = usersById.get(userAId);
  const userB = usersById.get(userBId);
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

io.on('connection', (socket) => {
  // User registers profile on connect
  socket.on('user:join', (payload = {}) => {
    const cleanName = String(payload.name || 'Guest').trim().slice(0, 32) || 'Guest';
    const userId = String(payload.id || socket.id).trim().slice(0, 64);
    const avatar = String(payload.avatar || cleanName[0]?.toUpperCase() || 'G').slice(0, 4);
    const color = String(payload.color || '#6366f1').slice(0, 48);

    // If same userId already connected on another socket, replace socket mapping cleanly
    const existing = usersById.get(userId);
    if (existing && existing.socketId !== socket.id) {
      userIdBySocket.delete(existing.socketId);
    }

    const user = {
      id: userId,
      name: cleanName,
      avatar,
      color,
      status: 'online',
      socketId: socket.id,
      peerId: null
    };

    usersById.set(userId, user);
    userIdBySocket.set(socket.id, userId);

    // Join default channels
    for (const ch of DEFAULT_CHANNELS) {
      socket.join(ch.id);
    }

    // Send initial bootstrap payload
    const initialHistory = {};
    for (const ch of DEFAULT_CHANNELS) {
      initialHistory[ch.id] = roomHistory.get(ch.id) || [];
    }

    socket.emit('session:ready', {
      user: {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        color: user.color,
        status: user.status
      },
      channels: DEFAULT_CHANNELS,
      users: serializeUsers(),
      history: initialHistory
    });

    broadcastPresence();
  });

  // Load DM history on demand
  socket.on('dm:history', ({ peerId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !peerId) return;
    const roomId = getDmRoomId(userId, peerId);
    socket.emit('dm:history', {
      roomId,
      peerId,
      messages: roomHistory.get(roomId) || []
    });
  });

  // Real-time messaging (channel or DM)
  socket.on('message:send', (payload = {}) => {
    const senderId = userIdBySocket.get(socket.id);
    const sender = usersById.get(senderId);
    if (!sender) return;

    const { targetType, targetId, text, attachment, replyTo } = payload;
    const trimmedText = typeof text === 'string' ? text.trim().slice(0, 4000) : '';

    if (!trimmedText && !attachment) return;

    // Basic validation on inline attachment
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
      replyTo: replyTo && typeof replyTo === 'object'
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

      message.roomId = targetId;
      appendMessage(targetId, message);
      io.to(targetId).emit('message:new', message);
    } else if (targetType === 'dm') {
      const recipient = usersById.get(targetId);
      const roomId = getDmRoomId(sender.id, targetId);
      message.roomId = roomId;
      message.dmPeerId = targetId;

      appendMessage(roomId, message);

      // Deliver to sender and recipient
      socket.emit('message:new', message);
      if (recipient && recipient.socketId !== socket.id) {
        io.to(recipient.socketId).emit('message:new', {
          ...message,
          dmPeerId: sender.id
        });
      }
    }
  });

  // Message emoji reaction toggle
  socket.on('message:react', ({ roomId, messageId, emoji, targetType, targetId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !roomId || !messageId || !emoji) return;
    const cleanEmoji = String(emoji).slice(0, 8);
    const msg = findMessage(roomId, messageId);
    if (!msg) return;

    if (!msg.reactions[cleanEmoji]) {
      msg.reactions[cleanEmoji] = [];
    }
    const idx = msg.reactions[cleanEmoji].indexOf(userId);
    if (idx === -1) {
      msg.reactions[cleanEmoji].push(userId);
    } else {
      msg.reactions[cleanEmoji].splice(idx, 1);
      if (msg.reactions[cleanEmoji].length === 0) {
        delete msg.reactions[cleanEmoji];
      }
    }

    const updatePayload = { roomId, messageId, reactions: msg.reactions };
    if (targetType === 'channel') {
      io.to(roomId).emit('message:reacted', updatePayload);
    } else if (targetType === 'dm') {
      socket.emit('message:reacted', updatePayload);
      const peer = usersById.get(targetId);
      if (peer && peer.socketId !== socket.id) {
        io.to(peer.socketId).emit('message:reacted', updatePayload);
      }
    }
  });

  // Delete own message
  socket.on('message:delete', ({ roomId, messageId, targetType, targetId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !roomId || !messageId) return;
    const list = roomHistory.get(roomId);
    if (!list) return;

    const index = list.findIndex((m) => m.id === messageId && m.senderId === userId);
    if (index === -1) return;

    list.splice(index, 1);
    const payload = { roomId, messageId };
    if (targetType === 'channel') {
      io.to(roomId).emit('message:deleted', payload);
    } else if (targetType === 'dm') {
      socket.emit('message:deleted', payload);
      const peer = usersById.get(targetId);
      if (peer && peer.socketId !== socket.id) {
        io.to(peer.socketId).emit('message:deleted', payload);
      }
    }
  });

  // Typing indicators
  socket.on('typing:state', ({ targetType, targetId, isTyping }) => {
    const senderId = userIdBySocket.get(socket.id);
    const sender = usersById.get(senderId);
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
      const peer = usersById.get(targetId);
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
    const caller = usersById.get(callerId);
    const callee = usersById.get(to);

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

    // Reserve pending call state so a third user cannot barge in while ringing
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
    const caller = usersById.get(to);
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
    const callee = usersById.get(calleeId);
    const caller = usersById.get(to);

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
    const peer = usersById.get(to);
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

    const user = usersById.get(userId);
    if (!user || user.socketId !== socket.id) return;

    if (user.peerId) {
      const peerId = user.peerId;
      clearCallPairing(userId, peerId, 'disconnected');
    }

    usersById.delete(userId);
    broadcastPresence();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Pulse Connect server running at:`);
  console.log(`  -> Local:   http://localhost:${PORT}`);
  console.log(`  -> Network: http://${HOST}:${PORT}`);
  console.log(`  -> Serving frontend from: ${FRONTEND_DIR}\n`);
});
