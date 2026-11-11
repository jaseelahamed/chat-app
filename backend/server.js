require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const {
  connectDatabase,
  isDatabaseReady,
  User,
  Message,
  CallSession,
  ChatConsent
} = require('./db');
const { authenticateToken } = require('./middleware/auth');
const {
  getPlatformSettings,
  createNotification,
  atomicDebitCustomerCoins,
  creditExecutiveForService
} = require('./services/billing');
const { evaluateExecutiveBonuses } = require('./services/bonuses');
const { createAuthRouter } = require('./routes/auth');
const { createWalletRouter } = require('./routes/wallet');
const { createExecutiveRouter } = require('./routes/executive');
const { createAdminRouter } = require('./routes/admin');

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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(express.static(FRONTEND_DIR));

function createRateLimiter({ windowMs = 60000, max = 60 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now > entry.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

const apiLimiter = createRateLimiter({ windowMs: 60000, max: 80 });
app.use('/auth', apiLimiter);
app.use('/wallet', apiLimiter);

const DEFAULT_CHANNELS = [
  { id: 'channel:general', name: 'General', topic: 'Team-wide real-time chat & updates' },
  { id: 'channel:lounge', name: 'Lounge', topic: 'Casual hangouts, memes & quick syncs' },
  { id: 'channel:projects', name: 'Projects', topic: 'Collaborate on builds & brainstorms' }
];

const MAX_HISTORY_PER_ROOM = 100;

// Live connection state keyed by userId
const onlineUsersById = new Map(); // userId -> { id, role, name, username, avatar, color, status, socketId, peerId }
const userIdBySocket = new Map();  // socketId -> userId
const activeCalls = new Map();     // dmRoomId -> { callId, callType, callerId, calleeId, customerId, executiveId, isPaid, coinRatePerSec, channel, connectedAt, billedSeconds, billingTimer }

function serializeDbUser(doc, liveEntry) {
  let status = 'offline';
  if (liveEntry) {
    status = liveEntry.peerId ? 'in-call' : 'online';
  }
  return {
    id: doc.userId,
    role: doc.role || 'customer',
    name: doc.name,
    username: doc.username || '',
    avatar: doc.avatar,
    color: doc.color,
    category: doc.category || 'Companion',
    approvalStatus: doc.approvalStatus || 'approved',
    status
  };
}

async function buildAllUsersList() {
  if (!isDatabaseReady()) {
    return Array.from(onlineUsersById.values()).map((u) => ({
      id: u.id,
      role: u.role,
      name: u.name,
      username: u.username,
      avatar: u.avatar,
      color: u.color,
      status: u.status
    }));
  }

  const dbUsers = await User.find(
    { accountStatus: 'active', role: { $ne: 'admin' } },
    { passwordHash: 0, sessions: 0, payoutDetails: 0, documents: 0 }
  )
    .sort({ name: 1 })
    .lean();

  const list = dbUsers.map((doc) => serializeDbUser(doc, onlineUsersById.get(doc.userId)));
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

function emitCoinsToUser(userId, coinBalance) {
  const online = onlineUsersById.get(userId);
  if (online) {
    io.to(online.socketId).emit('wallet:update', { coinBalance });
  }
}

function emitBroadcastNotifications(userIds, payload) {
  for (const uid of userIds) {
    const online = onlineUsersById.get(uid);
    if (online) {
      io.to(online.socketId).emit('notification:new', payload);
    }
  }
}

function getDmRoomId(userA, userB) {
  return `dm:${[userA, userB].sort().join(':')}`;
}

function getAgoraChannelName(userA, userB) {
  const hash = crypto.createHash('sha256').update(getDmRoomId(userA, userB)).digest('hex').slice(0, 20);
  return `pazhi-${hash}-${Date.now().toString(36)}`;
}

function formatMessageDoc(doc, viewerId = '') {
  const viewOnceHidden =
    Boolean(doc.viewOnce) &&
    doc.senderId !== viewerId &&
    Array.isArray(doc.viewedBy) &&
    doc.viewedBy.includes(viewerId);

  return {
    id: doc.id,
    roomId: doc.roomId,
    type: doc.type || 'text',
    callType: doc.callType,
    senderId: doc.senderId,
    senderName: doc.senderName,
    senderAvatar: doc.senderAvatar,
    senderColor: doc.senderColor,
    text: viewOnceHidden ? 'View Once message expired' : doc.text || '',
    attachment: viewOnceHidden
      ? null
      : doc.attachment && doc.attachment.dataUrl
      ? doc.attachment
      : null,
    replyTo: doc.replyTo && doc.replyTo.id ? doc.replyTo : null,
    reactions: doc.reactions || {},
    deliveryStatus: doc.deliveryStatus || 'sent',
    isPaid: Boolean(doc.isPaid),
    coinsCharged: doc.coinsCharged || 0,
    viewOnce: Boolean(doc.viewOnce),
    viewOnceOpened: viewOnceHidden,
    expiresAt: doc.expiresAt || null,
    createdAt: doc.createdAt
  };
}

async function loadUserChatHistory(userId) {
  const history = {};
  for (const ch of DEFAULT_CHANNELS) {
    history[ch.id] = [];
  }
  if (!isDatabaseReady()) return history;

  const now = Date.now();
  const notExpiredFilter = { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };

  await Promise.all(
    DEFAULT_CHANNELS.map(async (ch) => {
      const docs = await Message.find({ roomId: ch.id, ...notExpiredFilter })
        .sort({ createdAt: -1 })
        .limit(MAX_HISTORY_PER_ROOM)
        .lean();
      history[ch.id] = docs.reverse().map((d) => formatMessageDoc(d, userId));
    })
  );

  const dmDocs = await Message.find({
    targetType: 'dm',
    participants: userId,
    ...notExpiredFilter
  })
    .sort({ createdAt: 1 })
    .lean();

  for (const doc of dmDocs) {
    if (!history[doc.roomId]) history[doc.roomId] = [];
    const peerId = (doc.participants || []).find((p) => p !== userId) || '';
    history[doc.roomId].push({
      ...formatMessageDoc(doc, userId),
      dmPeerId: peerId
    });
  }

  return history;
}

// ---------------- Mount REST Routers ----------------
app.use(
  '/auth',
  createAuthRouter({
    onPresenceChanged: (updatedUser) => {
      if (updatedUser && onlineUsersById.has(updatedUser.userId)) {
        const live = onlineUsersById.get(updatedUser.userId);
        live.name = updatedUser.name;
        live.avatar = updatedUser.avatar;
        live.color = updatedUser.color;
      }
      broadcastPresence();
    }
  })
);

app.use(
  '/wallet',
  createWalletRouter({
    onCoinsUpdated: emitCoinsToUser
  })
);

app.use(
  '/',
  createExecutiveRouter({
    onlineUsersById,
    onPresenceChanged: broadcastPresence
  })
);

app.use(
  '/admin',
  createAdminRouter({
    onlineUsersById,
    onPresenceChanged: broadcastPresence,
    onCoinsUpdated: emitCoinsToUser,
    onNotificationBroadcast: emitBroadcastNotifications
  })
);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    onlineUsers: onlineUsersById.size,
    dbConnected: isDatabaseReady(),
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

// ---------------- Call Billing & Cleanup ----------------
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

function startCallBillingTicker(roomId, session) {
  if (!session.isPaid || !session.customerId || !session.executiveId || session.coinRatePerSec <= 0) {
    return;
  }
  if (session.billingTimer) return;

  session.billingTimer = setInterval(async () => {
    const active = activeCalls.get(roomId);
    if (!active || active.callId !== session.callId) {
      clearInterval(session.billingTimer);
      return;
    }

    const nextSec = active.billedSeconds + 1;
    const idempotencyKey = `call:${active.callId}:sec:${nextSec}`;
    const serviceType = active.callType === 'video' ? 'video' : 'audio';
    const debitKind = serviceType === 'video' ? 'video_debit' : 'audio_debit';

    try {
      const debit = await atomicDebitCustomerCoins({
        customerId: active.customerId,
        coins: active.coinRatePerSec,
        kind: debitKind,
        referenceType: 'call',
        referenceId: active.callId,
        counterpartyId: active.executiveId,
        idempotencyKey,
        note: `${serviceType} call sec ${nextSec}`
      });

      if (!debit.ok) {
        await createNotification({
          userId: active.customerId,
          category: 'wallet',
          title: 'Call Ended — Insufficient Balance',
          body: 'Your coin balance ran out during the call. Recharge to continue calling.'
        });
        clearCallPairing(active.customerId, active.executiveId, 'insufficient_balance', true);
        return;
      }

      active.billedSeconds = nextSec;
      active.totalCoinsCharged += debit.coinsCharged;

      const earn = await creditExecutiveForService({
        executiveId: active.executiveId,
        customerId: active.customerId,
        serviceType,
        coinsCharged: debit.coinsCharged,
        referenceType: 'call',
        referenceId: active.callId,
        idempotencyKey: `exec:${idempotencyKey}`,
        note: `${serviceType} call earning`
      });

      active.execEarnedInr += earn.execNetInr || 0;
      active.platformCommissionInr += earn.platformCommissionInr || 0;

      await CallSession.updateOne(
        { callId: active.callId },
        {
          $set: {
            billedSeconds: active.billedSeconds,
            totalCoinsCharged: active.totalCoinsCharged,
            execEarnedInr: Math.round(active.execEarnedInr * 100) / 100,
            platformCommissionInr: Math.round(active.platformCommissionInr * 100) / 100
          }
        }
      );

      const settings = await getPlatformSettings();
      const lowBalance = debit.remainingCoins <= (settings.lowBalanceWarningCoins || 30);

      const custOnline = onlineUsersById.get(active.customerId);
      if (custOnline) {
        io.to(custOnline.socketId).emit('call:billing-tick', {
          callId: active.callId,
          elapsedSeconds: nextSec,
          remainingCoins: debit.remainingCoins,
          ratePerSec: active.coinRatePerSec,
          lowBalance
        });
        io.to(custOnline.socketId).emit('wallet:update', { coinBalance: debit.remainingCoins });
      }

      const execOnline = onlineUsersById.get(active.executiveId);
      if (execOnline) {
        io.to(execOnline.socketId).emit('call:billing-tick', {
          callId: active.callId,
          elapsedSeconds: nextSec,
          earnedInr: Math.round(active.execEarnedInr * 100) / 100
        });
      }
    } catch (err) {
      console.error('Call billing tick error:', err.message);
    }
  }, 1000);
}

function clearCallPairing(userAId, userBId, reason = 'ended', notifyBoth = false) {
  const userA = onlineUsersById.get(userAId);
  const userB = onlineUsersById.get(userBId);
  const roomId = userAId && userBId ? getDmRoomId(userAId, userBId) : null;
  const session = roomId ? activeCalls.get(roomId) : null;
  if (roomId) activeCalls.delete(roomId);

  if (session?.billingTimer) {
    clearInterval(session.billingTimer);
    session.billingTimer = null;
  }

  if (session) {
    if (isDatabaseReady() && session.callId) {
      CallSession.updateOne(
        { callId: session.callId },
        {
          $set: {
            status: reason === 'cancelled' ? 'cancelled' : 'ended',
            endedAt: Date.now(),
            endReason: reason
          }
        }
      )
        .then(() => {
          if (session.isPaid && session.executiveId) {
            evaluateExecutiveBonuses(session.executiveId);
          }
        })
        .catch((err) => console.error('Finalize CallSession error:', err.message));
    }

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
    if (notifyBoth) {
      io.to(userA.socketId).emit('call:ended', { from: userBId, reason });
    }
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

      const auth = await authenticateToken(payload.token);
      if (!auth) {
        socket.emit('session:error', { message: 'Please log in to continue.' });
        return;
      }

      const userDoc = auth.user;
      const existing = onlineUsersById.get(userDoc.userId);
      if (existing && existing.socketId !== socket.id) {
        userIdBySocket.delete(existing.socketId);
      }

      const user = {
        id: userDoc.userId,
        role: userDoc.role || 'customer',
        name: userDoc.name,
        username: userDoc.username || '',
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

      const [users, history, settings] = await Promise.all([
        buildAllUsersList(),
        loadUserChatHistory(user.id),
        getPlatformSettings()
      ]);

      socket.emit('session:ready', {
        user: {
          id: user.id,
          role: user.role,
          name: user.name,
          username: user.username,
          avatar: user.avatar,
          color: user.color,
          status: user.status,
          coinBalance: userDoc.coinBalance || 0,
          bonusCoinBalance: userDoc.bonusCoinBalance || 0,
          approvalStatus: userDoc.approvalStatus || 'approved',
          earnings: userDoc.earnings || {}
        },
        channels: DEFAULT_CHANNELS,
        users,
        history,
        pricing: {
          chatCoinPerMessage: settings.chatCoinPerMessage,
          audioCoinPerSecond: settings.audioCoinPerSecond,
          videoCoinPerSecond: settings.videoCoinPerSecond
        }
      });

      broadcastPresence();
    } catch (err) {
      console.error('user:join error:', err);
      socket.emit('session:error', { message: 'Failed to load your session.' });
    }
  });

  // Customer grants/revokes executive chat initiation consent
  socket.on('chat:consent', async ({ executiveId, accepted }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !executiveId || !isDatabaseReady()) return;

    const consentKey = `${userId}:${executiveId}`;
    await ChatConsent.updateOne(
      { consentKey },
      {
        $set: {
          consentKey,
          customerId: userId,
          executiveId,
          accepted: Boolean(accepted),
          updatedAt: Date.now()
        }
      },
      { upsert: true }
    );

    const execOnline = onlineUsersById.get(executiveId);
    if (execOnline) {
      io.to(execOnline.socketId).emit('chat:consent-updated', {
        customerId: userId,
        accepted: Boolean(accepted)
      });
    }
  });

  // Load DM history on demand
  socket.on('dm:history', async ({ peerId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !peerId || !isDatabaseReady()) return;
    const roomId = getDmRoomId(userId, peerId);
    const now = Date.now();
    try {
      const docs = await Message.find({
        roomId,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
      })
        .sort({ createdAt: 1 })
        .limit(MAX_HISTORY_PER_ROOM)
        .lean();
      socket.emit('dm:history', {
        roomId,
        peerId,
        messages: docs.map((d) => ({ ...formatMessageDoc(d, userId), dmPeerId: peerId }))
      });
    } catch (err) {
      console.error('dm:history error:', err.message);
    }
  });

  // Real-time messaging (channel or DM, with paid billing for customer <-> executive DMs)
  socket.on('message:send', async (payload = {}) => {
    const senderId = userIdBySocket.get(socket.id);
    const sender = onlineUsersById.get(senderId);
    if (!sender) return;

    const { targetType, targetId, text, attachment, replyTo, viewOnce } = payload;
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

    const msgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message = {
      id: msgId,
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
      deliveryStatus: 'sent',
      isPaid: false,
      coinsCharged: 0,
      viewOnce: Boolean(viewOnce),
      expiresAt: null,
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
      return;
    }

    if (targetType === 'dm') {
      if (!targetId || targetId === sender.id) return;
      const roomId = getDmRoomId(sender.id, targetId);

      if (isDatabaseReady()) {
        const [senderDoc, targetDoc, settings] = await Promise.all([
          User.findOne({ userId: sender.id }).lean(),
          User.findOne({ userId: targetId }).lean(),
          getPlatformSettings()
        ]);

        if (!senderDoc || !targetDoc || targetDoc.accountStatus !== 'active') {
          socket.emit('message:error', { error: 'Recipient is unavailable.' });
          return;
        }

        if (
          (senderDoc.blockedUsers || []).includes(targetId) ||
          (targetDoc.blockedUsers || []).includes(sender.id)
        ) {
          socket.emit('message:error', { error: 'Messaging is blocked between these accounts.' });
          return;
        }

        if (settings.messageExpirySeconds > 0) {
          message.expiresAt = Date.now() + settings.messageExpirySeconds * 1000;
        }
        if (!settings.viewOnceEnabled) {
          message.viewOnce = false;
        }

        const isCustomerExecPair =
          (senderDoc.role === 'customer' && targetDoc.role === 'executive') ||
          (senderDoc.role === 'executive' && targetDoc.role === 'customer');

        if (isCustomerExecPair) {
          const customerDoc = senderDoc.role === 'customer' ? senderDoc : targetDoc;
          const executiveDoc = senderDoc.role === 'executive' ? senderDoc : targetDoc;

          if (executiveDoc.approvalStatus !== 'approved') {
            socket.emit('message:error', { error: 'Executive account is awaiting Admin approval.' });
            return;
          }

          if (senderDoc.role === 'executive') {
            const consent = await ChatConsent.findOne({
              consentKey: `${customerDoc.userId}:${executiveDoc.userId}`,
              accepted: true
            }).lean();
            const priorCustomerMsg = await Message.exists({
              roomId,
              senderId: customerDoc.userId
            });
            if (!consent && !priorCustomerMsg) {
              const custOnline = onlineUsersById.get(customerDoc.userId);
              if (custOnline) {
                io.to(custOnline.socketId).emit('chat:consent-request', {
                  executive: {
                    id: executiveDoc.userId,
                    name: executiveDoc.name,
                    avatar: executiveDoc.avatar
                  }
                });
              }
              socket.emit('message:error', {
                error: 'Customer consent is required before an executive can start a paid chat.'
              });
              return;
            }
          }

          let chargeCoins = settings.chatCoinPerMessage || 0;
          if (settings.freeMessagesEnabled && settings.freeMessageLimit > 0) {
            const sentCount = await Message.countDocuments({
              roomId,
              senderId: customerDoc.userId
            });
            if (sentCount < settings.freeMessageLimit) {
              chargeCoins = 0;
            }
          }

          if (chargeCoins > 0) {
            const debit = await atomicDebitCustomerCoins({
              customerId: customerDoc.userId,
              coins: chargeCoins,
              kind: 'chat_debit',
              referenceType: 'message',
              referenceId: msgId,
              counterpartyId: executiveDoc.userId,
              idempotencyKey: `msg:${msgId}`,
              note: `Paid chat message with ${executiveDoc.name}`
            });

            if (!debit.ok) {
              socket.emit('message:error', {
                error: 'Insufficient coin balance. Please recharge to send paid messages.',
                code: 'insufficient_balance',
                remainingCoins: debit.remainingCoins
              });
              return;
            }

            message.isPaid = true;
            message.coinsCharged = debit.coinsCharged;

            await creditExecutiveForService({
              executiveId: executiveDoc.userId,
              customerId: customerDoc.userId,
              serviceType: 'chat',
              coinsCharged: debit.coinsCharged,
              referenceType: 'message',
              referenceId: msgId,
              idempotencyKey: `exec:msg:${msgId}`,
              note: `Paid chat message from ${customerDoc.name}`
            });

            emitCoinsToUser(customerDoc.userId, debit.remainingCoins);
            evaluateExecutiveBonuses(executiveDoc.userId);
          }
        }

        const recipientOnline = onlineUsersById.get(targetId);
        message.deliveryStatus = recipientOnline ? 'delivered' : 'sent';

        await Message.create({
          ...message,
          roomId,
          targetType: 'dm',
          participants: [sender.id, targetId].sort()
        });
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

  socket.on('message:read', async ({ roomId, targetId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !roomId || !isDatabaseReady()) return;
    await Message.updateMany(
      { roomId, senderId: targetId, deliveryStatus: { $ne: 'read' } },
      { $set: { deliveryStatus: 'read' } }
    );
    const peer = onlineUsersById.get(targetId);
    if (peer) {
      io.to(peer.socketId).emit('message:read', { roomId, readerId: userId });
    }
  });

  socket.on('message:view-once', async ({ roomId, messageId }) => {
    const userId = userIdBySocket.get(socket.id);
    if (!userId || !roomId || !messageId || !isDatabaseReady()) return;
    await Message.updateOne(
      { id: messageId, roomId, viewOnce: true },
      { $addToSet: { viewedBy: userId } }
    );
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
    if (idx === -1) list.push(userId);
    else list.splice(idx, 1);

    if (list.length === 0) delete reactions[cleanEmoji];
    else reactions[cleanEmoji] = list;

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

  // -------------------- Agora Call Signaling & Per-Second Billing --------------------
  socket.on('call:request', async ({ to, callType }) => {
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
    const callId = `call_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    let isPaid = false;
    let customerId = null;
    let executiveId = null;
    let coinRatePerSec = 0;

    if (isDatabaseReady()) {
      const [callerDoc, calleeDoc, settings] = await Promise.all([
        User.findOne({ userId: caller.id }).lean(),
        User.findOne({ userId: callee.id }).lean(),
        getPlatformSettings()
      ]);

      if (
        (callerDoc?.blockedUsers || []).includes(callee.id) ||
        (calleeDoc?.blockedUsers || []).includes(caller.id)
      ) {
        socket.emit('call:unavailable', { to, reason: 'Calling is blocked for this account.' });
        return;
      }

      const isPair =
        (callerDoc?.role === 'customer' && calleeDoc?.role === 'executive') ||
        (callerDoc?.role === 'executive' && calleeDoc?.role === 'customer');

      if (isPair) {
        const custDoc = callerDoc.role === 'customer' ? callerDoc : calleeDoc;
        const execDoc = callerDoc.role === 'executive' ? callerDoc : calleeDoc;

        if (execDoc.approvalStatus !== 'approved') {
          socket.emit('call:unavailable', { to, reason: 'Executive is not approved yet.' });
          return;
        }
        if (normalizedType === 'audio' && execDoc.availability?.audioEnabled === false) {
          socket.emit('call:unavailable', { to, reason: 'Executive has disabled audio calls.' });
          return;
        }
        if (normalizedType === 'video' && execDoc.availability?.videoEnabled === false) {
          socket.emit('call:unavailable', { to, reason: 'Executive has disabled video calls.' });
          return;
        }

        coinRatePerSec =
          normalizedType === 'video' ? settings.videoCoinPerSecond || 2 : settings.audioCoinPerSecond || 1;
        if ((custDoc.coinBalance || 0) < coinRatePerSec) {
          socket.emit('call:unavailable', {
            to,
            reason: `Insufficient coins (${coinRatePerSec} coins/sec required). Please recharge.`
          });
          return;
        }

        isPaid = true;
        customerId = custDoc.userId;
        executiveId = execDoc.userId;
      }

      await CallSession.create({
        callId,
        roomId,
        channel,
        callType: normalizedType,
        callerId: caller.id,
        calleeId: callee.id,
        customerId,
        executiveId,
        isPaid,
        status: 'ringing',
        coinRatePerSec,
        startedAt: Date.now()
      });
    }

    activeCalls.set(roomId, {
      callId,
      callType: normalizedType,
      callerId: caller.id,
      calleeId: callee.id,
      customerId,
      executiveId,
      isPaid,
      coinRatePerSec,
      channel,
      connectedAt: null,
      billedSeconds: 0,
      totalCoinsCharged: 0,
      execEarnedInr: 0,
      platformCommissionInr: 0,
      billingTimer: null
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
      channel,
      isPaid,
      coinRatePerSec
    });
  });

  socket.on('call:accept', async ({ to }) => {
    const calleeId = userIdBySocket.get(socket.id);
    const caller = onlineUsersById.get(to);
    if (!calleeId || !caller) return;

    const roomId = getDmRoomId(calleeId, caller.id);
    const session = activeCalls.get(roomId);
    if (session) {
      session.connectedAt = Date.now();
      if (isDatabaseReady() && session.callId) {
        await CallSession.updateOne(
          { callId: session.callId },
          { $set: { status: 'active', connectedAt: session.connectedAt } }
        );
      }
      startCallBillingTicker(roomId, session);
    }

    io.to(caller.socketId).emit('call:accepted', {
      from: calleeId,
      channel: session?.channel || getAgoraChannelName(calleeId, caller.id),
      isPaid: Boolean(session?.isPaid),
      coinRatePerSec: session?.coinRatePerSec || 0
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
      if (session?.billingTimer) clearInterval(session.billingTimer);
      if (session) {
        if (isDatabaseReady() && session.callId) {
          CallSession.updateOne(
            { callId: session.callId },
            { $set: { status: 'rejected', endedAt: Date.now(), endReason: reason || 'declined' } }
          ).catch(() => {});
        }
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
    console.log(`\n  Pazhi backend server running at:`);
    console.log(`  -> Local:   http://localhost:${PORT}`);
    console.log(`  -> Network: http://${HOST}:${PORT}`);
    console.log(`  -> Serving frontend from: ${FRONTEND_DIR}\n`);
  });
}

startServer();
