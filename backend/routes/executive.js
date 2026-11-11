const express = require('express');
const {
  User,
  LedgerTransaction,
  WithdrawalRequest,
  BonusRule,
  CallSession
} = require('../db');
const {
  authenticateToken,
  requireAuth,
  requireRole,
  requireApprovedExecutive
} = require('../middleware/auth');
const {
  round2,
  newTxId,
  getPlatformSettings,
  createNotification
} = require('../services/billing');

function getDateRangeBounds(range, fromParam, toParam) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(now);

  switch (range) {
    case 'today':
      return { start: todayStart, end: Date.now() };
    case 'yesterday':
      return { start: todayStart - 86400000, end: todayStart - 1 };
    case 'week': {
      const day = now.getDay();
      const diff = (day === 0 ? 6 : day - 1) * 86400000;
      return { start: todayStart - diff, end: Date.now() };
    }
    case 'month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end: Date.now() };
    case 'prev_month':
      return {
        start: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
        end: new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1
      };
    case 'custom':
      return {
        start: fromParam ? Number(new Date(fromParam).getTime()) || 0 : 0,
        end: toParam ? Number(new Date(toParam).getTime()) || Date.now() : Date.now()
      };
    default:
      return { start: 0, end: Date.now() };
  }
}

function createExecutiveRouter({ onlineUsersById, onPresenceChanged }) {
  const router = express.Router();

  // Customer Discovery: list approved active executives (requires customer coin/package purchase)
  router.get('/executives', async (req, res) => {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const auth = await authenticateToken(token);
    if (!auth) {
      return res.status(401).json({ error: 'Please log in to view executives.' });
    }
    if (
      auth.user.role === 'customer' &&
      (auth.user.totalCoinsPurchased || 0) <= 0 &&
      (auth.user.coinBalance || 0) <= 0
    ) {
      return res.json({
        executives: [],
        locked: true,
        message: 'Purchase a coin package to view and connect with executives.'
      });
    }

    const q = String(req.query.q || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();
    const availabilityFilter = String(req.query.availability || '').trim().toLowerCase();

    const filter = {
      role: 'executive',
      approvalStatus: 'approved',
      accountStatus: 'active'
    };
    if (category && category !== 'all') {
      filter.category = category;
    }

    const [docs, settings] = await Promise.all([
      User.find(filter, { passwordHash: 0, sessions: 0, payoutDetails: 0, documents: 0 }).lean(),
      getPlatformSettings()
    ]);

    let executives = docs.map((doc) => {
      const live = onlineUsersById.get(doc.userId);
      const manual = doc.availability?.manualStatus || 'offline';
      let effectiveStatus = 'offline';
      if (live?.peerId) {
        effectiveStatus = 'busy';
      } else if (live && manual !== 'offline') {
        effectiveStatus = manual === 'busy' ? 'busy' : 'online';
      }

      return {
        id: doc.userId,
        name: doc.name,
        username: doc.username || '',
        avatar: doc.avatar,
        color: doc.color,
        bio: doc.bio || '',
        category: doc.category || 'Companion',
        languages: doc.languages || [],
        experience: doc.experience || '',
        ratingAvg: doc.ratingAvg || 5.0,
        ratingCount: doc.ratingCount || 0,
        status: effectiveStatus,
        services: {
          chat: doc.availability?.chatEnabled !== false,
          audio: doc.availability?.audioEnabled !== false,
          video: doc.availability?.videoEnabled !== false
        },
        pricing: {
          chatCoinPerMessage: settings.chatCoinPerMessage,
          audioCoinPerSecond: settings.audioCoinPerSecond,
          videoCoinPerSecond: settings.videoCoinPerSecond
        }
      };
    });

    if (q) {
      executives = executives.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q) ||
          e.bio.toLowerCase().includes(q)
      );
    }

    if (availabilityFilter === 'online' || availabilityFilter === 'available') {
      executives = executives.filter((e) => e.status === 'online');
    }

    const rank = { online: 0, busy: 1, offline: 2 };
    executives.sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));

    res.json({ executives });
  });

  // Single executive profile
  router.get('/executives/:id', async (req, res) => {
    const doc = await User.findOne(
      { userId: req.params.id, role: 'executive', approvalStatus: 'approved', accountStatus: 'active' },
      { passwordHash: 0, sessions: 0, payoutDetails: 0, documents: 0 }
    ).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Executive not found.' });
    }
    const settings = await getPlatformSettings();
    const live = onlineUsersById.get(doc.userId);
    res.json({
      executive: {
        id: doc.userId,
        name: doc.name,
        avatar: doc.avatar,
        color: doc.color,
        bio: doc.bio || '',
        category: doc.category,
        languages: doc.languages || [],
        experience: doc.experience || '',
        ratingAvg: doc.ratingAvg || 5.0,
        ratingCount: doc.ratingCount || 0,
        status: live?.peerId ? 'busy' : live && doc.availability?.manualStatus !== 'offline' ? 'online' : 'offline',
        services: {
          chat: doc.availability?.chatEnabled !== false,
          audio: doc.availability?.audioEnabled !== false,
          video: doc.availability?.videoEnabled !== false
        },
        pricing: {
          chatCoinPerMessage: settings.chatCoinPerMessage,
          audioCoinPerSecond: settings.audioCoinPerSecond,
          videoCoinPerSecond: settings.videoCoinPerSecond
        }
      }
    });
  });

  // Executive availability toggle
  router.put('/executive/availability', requireAuth, requireApprovedExecutive, async (req, res) => {
    if (req.user.availability?.adminRestricted) {
      return res.status(403).json({ error: 'Availability is restricted by Admin.' });
    }

    const current = req.user.availability || {};
    const manualStatus = ['available', 'busy', 'offline'].includes(req.body?.manualStatus)
      ? req.body.manualStatus
      : current.manualStatus || 'available';

    const availability = {
      manualStatus,
      chatEnabled: req.body?.chatEnabled !== undefined ? Boolean(req.body.chatEnabled) : current.chatEnabled !== false,
      audioEnabled: req.body?.audioEnabled !== undefined ? Boolean(req.body.audioEnabled) : current.audioEnabled !== false,
      videoEnabled: req.body?.videoEnabled !== undefined ? Boolean(req.body.videoEnabled) : current.videoEnabled !== false,
      adminRestricted: Boolean(current.adminRestricted)
    };

    await User.updateOne({ userId: req.user.userId }, { $set: { availability } });
    onPresenceChanged?.();
    res.json({ availability });
  });

  // Executive earnings dashboard
  router.get('/executive/earnings', requireAuth, requireRole('executive'), async (req, res) => {
    const range = String(req.query.range || 'all');
    const { start, end } = getDateRangeBounds(range, req.query.from, req.query.to);

    const txRows = await LedgerTransaction.find({
      userId: req.user.userId,
      kind: { $in: ['exec_chat_earning', 'exec_audio_earning', 'exec_video_earning', 'exec_bonus'] },
      createdAt: { $gte: start, $lte: end }
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    let chatInr = 0;
    let audioInr = 0;
    let videoInr = 0;
    let bonusInr = 0;
    let grossInr = 0;
    let platformCommissionInr = 0;

    for (const tx of txRows) {
      if (tx.kind === 'exec_chat_earning') chatInr += tx.amount;
      if (tx.kind === 'exec_audio_earning') audioInr += tx.amount;
      if (tx.kind === 'exec_video_earning') videoInr += tx.amount;
      if (tx.kind === 'exec_bonus') bonusInr += tx.amount;
      grossInr += tx.grossInr || tx.amount;
      platformCommissionInr += tx.platformCommissionInr || 0;
    }

    const calls = await CallSession.find({
      executiveId: req.user.userId,
      startedAt: { $gte: start, $lte: end }
    })
      .sort({ startedAt: -1 })
      .limit(50)
      .lean();

    const earnings = req.user.earnings || {};
    res.json({
      period: {
        range,
        chatInr: round2(chatInr),
        audioInr: round2(audioInr),
        videoInr: round2(videoInr),
        bonusInr: round2(bonusInr),
        grossInr: round2(grossInr),
        platformCommissionInr: round2(platformCommissionInr),
        netInr: round2(chatInr + audioInr + videoInr + bonusInr)
      },
      summary: {
        chatInr: round2(earnings.chatInr || 0),
        audioInr: round2(earnings.audioInr || 0),
        videoInr: round2(earnings.videoInr || 0),
        bonusInr: round2(earnings.bonusInr || 0),
        pendingInr: round2(earnings.pendingInr || 0),
        approvedInr: round2(earnings.approvedInr || 0),
        withdrawnInr: round2(earnings.withdrawnInr || 0),
        availableWithdrawalInr: round2(earnings.approvedInr || 0)
      },
      transactions: txRows,
      calls
    });
  });

  // Executive bonus rules & earned bonuses
  router.get('/executive/bonuses', requireAuth, requireRole('executive'), async (req, res) => {
    const [rules, earned] = await Promise.all([
      BonusRule.find({ isActive: true }).sort({ createdAt: -1 }).lean(),
      LedgerTransaction.find({ userId: req.user.userId, kind: 'exec_bonus' })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ]);

    res.json({ rules, earned });
  });

  // Executive withdrawal list & request
  router.get('/executive/withdrawals', requireAuth, requireRole('executive'), async (req, res) => {
    const [withdrawals, settings] = await Promise.all([
      WithdrawalRequest.find({ executiveId: req.user.userId }).sort({ createdAt: -1 }).limit(50).lean(),
      getPlatformSettings()
    ]);

    res.json({
      withdrawals,
      minWithdrawalInr: settings.minWithdrawalInr || 500,
      availableWithdrawalInr: round2(req.user.earnings?.approvedInr || 0)
    });
  });

  router.post('/executive/withdrawals', requireAuth, requireApprovedExecutive, async (req, res) => {
    const amountInr = round2(Number(req.body?.amountInr || 0));
    const payoutMethod = req.body?.payoutMethod === 'bank' ? 'bank' : 'upi';
    const settings = await getPlatformSettings();
    const minAmount = settings.minWithdrawalInr || 500;

    if (!Number.isFinite(amountInr) || amountInr < minAmount) {
      return res.status(400).json({ error: `Minimum withdrawal amount is ₹${minAmount}.` });
    }

    const payoutDetails = req.body?.payoutDetails || req.user.payoutDetails || {};
    if (payoutMethod === 'upi' && !String(payoutDetails.upiId || '').trim()) {
      return res.status(400).json({ error: 'UPI ID is required for UPI withdrawal.' });
    }
    if (
      payoutMethod === 'bank' &&
      (!String(payoutDetails.accountNumber || '').trim() || !String(payoutDetails.ifsc || '').trim())
    ) {
      return res.status(400).json({ error: 'Bank account number and IFSC are required.' });
    }

    // Atomic hold from approvedInr
    const updatedExec = await User.findOneAndUpdate(
      { userId: req.user.userId, 'earnings.approvedInr': { $gte: amountInr } },
      { $inc: { 'earnings.approvedInr': -amountInr } },
      { new: true }
    ).lean();

    if (!updatedExec) {
      return res.status(400).json({ error: 'Insufficient available withdrawal balance.' });
    }

    const withdrawalId = newTxId('wd');
    const withdrawal = await WithdrawalRequest.create({
      withdrawalId,
      executiveId: req.user.userId,
      amountInr,
      payoutMethod,
      payoutDetails,
      status: 'pending',
      createdAt: Date.now()
    });

    const balAfter = round2(updatedExec.earnings?.approvedInr || 0);
    await LedgerTransaction.create({
      txId: newTxId('tx'),
      idempotencyKey: `wd_hold:${withdrawalId}`,
      userId: req.user.userId,
      role: 'executive',
      kind: 'withdrawal_hold',
      currency: 'INR',
      amount: -amountInr,
      balanceBefore: round2(balAfter + amountInr),
      balanceAfter: balAfter,
      referenceType: 'withdrawal',
      referenceId: withdrawalId,
      note: `Withdrawal request (${payoutMethod.toUpperCase()})`,
      createdAt: Date.now()
    });

    await createNotification({
      userId: req.user.userId,
      category: 'withdrawal',
      title: 'Withdrawal Submitted',
      body: `Your withdrawal request for ₹${amountInr} is pending Admin approval.`
    });

    res.status(201).json({ withdrawal, availableWithdrawalInr: balAfter });
  });

  router.post('/executive/withdrawals/:id/cancel', requireAuth, requireRole('executive'), async (req, res) => {
    const wd = await WithdrawalRequest.findOneAndUpdate(
      { withdrawalId: req.params.id, executiveId: req.user.userId, status: 'pending' },
      { $set: { status: 'cancelled', processedAt: Date.now() } },
      { new: true }
    ).lean();

    if (!wd) {
      return res.status(400).json({ error: 'Only pending withdrawal requests can be cancelled.' });
    }

    const updatedExec = await User.findOneAndUpdate(
      { userId: req.user.userId },
      { $inc: { 'earnings.approvedInr': wd.amountInr } },
      { new: true }
    ).lean();

    const balAfter = round2(updatedExec?.earnings?.approvedInr || wd.amountInr);
    await LedgerTransaction.create({
      txId: newTxId('tx'),
      idempotencyKey: `wd_cancel:${wd.withdrawalId}`,
      userId: req.user.userId,
      role: 'executive',
      kind: 'withdrawal_refund',
      currency: 'INR',
      amount: wd.amountInr,
      balanceBefore: round2(balAfter - wd.amountInr),
      balanceAfter: balAfter,
      referenceType: 'withdrawal',
      referenceId: wd.withdrawalId,
      note: 'Withdrawal cancelled by executive',
      createdAt: Date.now()
    });

    res.json({ withdrawal: wd, availableWithdrawalInr: balAfter });
  });

  return router;
}

module.exports = { createExecutiveRouter };

