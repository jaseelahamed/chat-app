const express = require('express');
const crypto = require('crypto');
const {
  User,
  Message,
  PlatformSettings,
  CoinPackage,
  PaymentOrder,
  LedgerTransaction,
  CallSession,
  WithdrawalRequest,
  BonusRule,
  AuditLog,
  Report
} = require('../db');
const {
  hashPassword,
  requireAuth,
  requireRole,
  requirePermission
} = require('../middleware/auth');
const {
  round2,
  newTxId,
  getPlatformSettings,
  createNotification,
  writeAuditLog
} = require('../services/billing');

function createAdminRouter({ onlineUsersById, onPresenceChanged, onCoinsUpdated, onNotificationBroadcast }) {
  const router = express.Router();

  router.use(requireAuth, requireRole('admin'));

  // Dashboard statistics
  router.get('/dashboard', requirePermission('reports'), async (req, res) => {
    const days = Number(req.query.days || 0);
    const since = days > 0 ? Date.now() - days * 86400000 : 0;

    const [
      totalCustomers,
      totalExecutives,
      approvedExecutives,
      pendingExecutives,
      paidOrders,
      ledgerRows,
      pendingWithdrawals,
      activeCallsCount
    ] = await Promise.all([
      User.countDocuments({ role: 'customer', accountStatus: { $ne: 'deleted' } }),
      User.countDocuments({ role: 'executive', accountStatus: { $ne: 'deleted' } }),
      User.countDocuments({ role: 'executive', approvalStatus: 'approved', accountStatus: 'active' }),
      User.countDocuments({ role: 'executive', approvalStatus: 'pending' }),
      PaymentOrder.find({ status: 'paid', ...(since ? { createdAt: { $gte: since } } : {}) }).lean(),
      LedgerTransaction.find(since ? { createdAt: { $gte: since } } : {}).lean(),
      WithdrawalRequest.countDocuments({ status: { $in: ['pending', 'approved', 'processing'] } }),
      CallSession.countDocuments({ status: 'active' })
    ]);

    let onlineExecutives = 0;
    for (const u of onlineUsersById.values()) {
      if (u.role === 'executive') onlineExecutives++;
    }

    const totalCoinSalesInr = round2(paidOrders.reduce((s, o) => s + (o.amountInr || 0), 0));
    let chatRevenueInr = 0;
    let audioRevenueInr = 0;
    let videoRevenueInr = 0;
    let totalExecutiveEarningsInr = 0;
    let totalPlatformCommissionInr = 0;
    let bonusExpensesInr = 0;

    for (const tx of ledgerRows) {
      if (tx.kind === 'exec_chat_earning') {
        chatRevenueInr += tx.grossInr || 0;
        totalExecutiveEarningsInr += tx.amount || 0;
      } else if (tx.kind === 'exec_audio_earning') {
        audioRevenueInr += tx.grossInr || 0;
        totalExecutiveEarningsInr += tx.amount || 0;
      } else if (tx.kind === 'exec_video_earning') {
        videoRevenueInr += tx.grossInr || 0;
        totalExecutiveEarningsInr += tx.amount || 0;
      } else if (tx.kind === 'platform_commission') {
        totalPlatformCommissionInr += tx.amount || 0;
      } else if (tx.kind === 'exec_bonus') {
        bonusExpensesInr += tx.amount || 0;
      }
    }

    res.json({
      stats: {
        totalCustomers,
        totalExecutives,
        approvedExecutives,
        pendingExecutives,
        onlineExecutives,
        activeCallsCount,
        totalCoinSalesInr,
        chatRevenueInr: round2(chatRevenueInr),
        audioRevenueInr: round2(audioRevenueInr),
        videoRevenueInr: round2(videoRevenueInr),
        totalPlatformCommissionInr: round2(totalPlatformCommissionInr),
        totalExecutiveEarningsInr: round2(totalExecutiveEarningsInr),
        bonusExpensesInr: round2(bonusExpensesInr),
        pendingWithdrawals,
        paymentTransactions: paidOrders.length
      }
    });
  });

  // Customer Management
  router.get('/customers', requirePermission('customers'), async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const status = String(req.query.status || '').trim();
    const filter = { role: 'customer' };
    if (status) filter.accountStatus = status;

    let customers = await User.find(filter, { passwordHash: 0, sessions: 0 })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    if (q) {
      customers = customers.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.email || '').toLowerCase().includes(q) ||
          (c.mobile || '').includes(q) ||
          (c.username || '').toLowerCase().includes(q)
      );
    }

    res.json({ customers });
  });

  router.patch('/customers/:id/status', requirePermission('customers'), async (req, res) => {
    const accountStatus = String(req.body?.accountStatus || '');
    if (!['active', 'suspended', 'blocked', 'deactivated'].includes(accountStatus)) {
      return res.status(400).json({ error: 'Invalid accountStatus.' });
    }

    const updated = await User.findOneAndUpdate(
      { userId: req.params.id, role: 'customer' },
      { $set: { accountStatus }, ...(accountStatus !== 'active' ? { $inc: { tokenVersion: 1 } } : {}) },
      { new: true, projection: { passwordHash: 0 } }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Customer not found.' });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'customer_status_change',
      targetId: req.params.id,
      details: { accountStatus }
    });

    onPresenceChanged?.();
    res.json({ customer: updated });
  });

  router.post('/customers/:id/adjust-coins', requirePermission('finance'), async (req, res) => {
    const delta = Math.round(Number(req.body?.delta || 0));
    const reason = String(req.body?.reason || '').trim().slice(0, 200);
    if (!delta || !reason) {
      return res.status(400).json({ error: 'Non-zero coin delta and reason are required.' });
    }

    const filter = { userId: req.params.id, role: 'customer' };
    if (delta < 0) {
      filter.coinBalance = { $gte: Math.abs(delta) };
    }

    const updated = await User.findOneAndUpdate(
      filter,
      { $inc: { coinBalance: delta } },
      { new: true, projection: { passwordHash: 0 } }
    ).lean();

    if (!updated) {
      return res.status(400).json({ error: 'Customer not found or insufficient balance for deduction.' });
    }

    await LedgerTransaction.create({
      txId: newTxId('tx'),
      userId: updated.userId,
      role: 'customer',
      kind: 'admin_adjustment',
      currency: 'COINS',
      amount: delta,
      balanceBefore: updated.coinBalance - delta,
      balanceAfter: updated.coinBalance,
      referenceType: 'admin',
      referenceId: req.user.userId,
      note: reason,
      createdAt: Date.now()
    });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'admin_coin_adjustment',
      targetId: updated.userId,
      details: { delta, reason, balanceAfter: updated.coinBalance }
    });

    onCoinsUpdated?.(updated.userId, updated.coinBalance);
    res.json({ customer: updated });
  });

  // Executive Management & Approvals
  router.get('/executives', requirePermission('executives'), async (req, res) => {
    const approvalStatus = String(req.query.approvalStatus || '').trim();
    const filter = { role: 'executive' };
    if (approvalStatus) filter.approvalStatus = approvalStatus;

    const executives = await User.find(filter, { passwordHash: 0, sessions: 0 })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json({
      executives: executives.map((e) => ({
        ...e,
        isOnline: onlineUsersById.has(e.userId)
      }))
    });
  });

  router.patch('/executives/:id/approval', requirePermission('executives'), async (req, res) => {
    const approvalStatus = String(req.body?.approvalStatus || '');
    const approvalNote = String(req.body?.note || '').trim().slice(0, 300);
    if (!['approved', 'rejected', 'pending'].includes(approvalStatus)) {
      return res.status(400).json({ error: 'Invalid approvalStatus.' });
    }

    const updated = await User.findOneAndUpdate(
      { userId: req.params.id, role: 'executive' },
      { $set: { approvalStatus, approvalNote } },
      { new: true, projection: { passwordHash: 0 } }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Executive not found.' });

    await createNotification({
      userId: updated.userId,
      category: 'account',
      title: `Application ${approvalStatus.toUpperCase()}`,
      body:
        approvalStatus === 'approved'
          ? 'Your Executive account is approved! You can now go online and accept paid chats/calls.'
          : approvalNote || `Your application status changed to ${approvalStatus}.`
    });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'executive_approval',
      targetId: updated.userId,
      details: { approvalStatus, approvalNote }
    });

    onPresenceChanged?.();
    res.json({ executive: updated });
  });

  router.patch('/executives/:id/status', requirePermission('executives'), async (req, res) => {
    const updates = {};
    if (req.body?.accountStatus && ['active', 'suspended', 'blocked', 'deactivated'].includes(req.body.accountStatus)) {
      updates.accountStatus = req.body.accountStatus;
    }
    if (req.body?.adminRestricted !== undefined) {
      updates['availability.adminRestricted'] = Boolean(req.body.adminRestricted);
    }
    if (req.body?.category) {
      updates.category = String(req.body.category).trim().slice(0, 40);
    }

    const updated = await User.findOneAndUpdate(
      { userId: req.params.id, role: 'executive' },
      { $set: updates },
      { new: true, projection: { passwordHash: 0 } }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Executive not found.' });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'executive_update',
      targetId: updated.userId,
      details: updates
    });

    onPresenceChanged?.();
    res.json({ executive: updated });
  });

  // Coin Package Management
  router.get('/packages', requirePermission('finance'), async (_req, res) => {
    const packages = await CoinPackage.find().sort({ displayOrder: 1, priceInr: 1 }).lean();
    res.json({ packages });
  });

  router.post('/packages', requirePermission('finance'), async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const priceInr = Number(req.body?.priceInr);
    const coins = Math.round(Number(req.body?.coins));
    const bonusCoins = Math.round(Number(req.body?.bonusCoins || 0));
    if (!name || !Number.isFinite(priceInr) || priceInr <= 0 || !Number.isFinite(coins) || coins <= 0) {
      return res.status(400).json({ error: 'Valid name, priceInr, and coins are required.' });
    }

    const pkg = await CoinPackage.create({
      packageId: newTxId('pkg'),
      name,
      priceInr,
      coins,
      bonusCoins: Math.max(0, bonusCoins),
      isActive: req.body?.isActive !== false,
      isPromotional: Boolean(req.body?.isPromotional),
      displayOrder: Number(req.body?.displayOrder || 0)
    });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'package_create',
      targetId: pkg.packageId,
      details: { name, priceInr, coins, bonusCoins }
    });

    res.status(201).json({ package: pkg });
  });

  router.put('/packages/:packageId', requirePermission('finance'), async (req, res) => {
    const allowed = {};
    if (req.body?.name !== undefined) allowed.name = String(req.body.name).trim();
    if (req.body?.priceInr !== undefined) allowed.priceInr = Number(req.body.priceInr);
    if (req.body?.coins !== undefined) allowed.coins = Math.round(Number(req.body.coins));
    if (req.body?.bonusCoins !== undefined) allowed.bonusCoins = Math.max(0, Math.round(Number(req.body.bonusCoins)));
    if (req.body?.isActive !== undefined) allowed.isActive = Boolean(req.body.isActive);
    if (req.body?.isPromotional !== undefined) allowed.isPromotional = Boolean(req.body.isPromotional);
    if (req.body?.displayOrder !== undefined) allowed.displayOrder = Number(req.body.displayOrder);

    const updated = await CoinPackage.findOneAndUpdate(
      { packageId: req.params.packageId },
      { $set: allowed },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Package not found.' });
    res.json({ package: updated });
  });

  router.delete('/packages/:packageId', requirePermission('finance'), async (req, res) => {
    const deleted = await CoinPackage.deleteOne({ packageId: req.params.packageId });
    if (!deleted.deletedCount) return res.status(404).json({ error: 'Package not found.' });
    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'package_delete',
      targetId: req.params.packageId
    });
    res.json({ deleted: true });
  });

  // Service Pricing, Commissions & Platform Settings
  router.get('/settings', requirePermission('settings'), async (_req, res) => {
    const settings = await getPlatformSettings();
    res.json({ settings });
  });

  router.put('/settings', requirePermission('settings'), async (req, res) => {
    const previous = await getPlatformSettings();
    const allowed = {};
    const fields = [
      'platformName',
      'maintenanceMode',
      'chatCoinPerMessage',
      'freeMessagesEnabled',
      'freeMessageLimit',
      'audioCoinPerSecond',
      'videoCoinPerSecond',
      'coinToInrRate',
      'minWithdrawalInr',
      'messageExpirySeconds',
      'viewOnceEnabled',
      'lowBalanceWarningCoins',
      'termsText',
      'privacyText',
      'supportEmail'
    ];
    for (const f of fields) {
      if (req.body?.[f] !== undefined) allowed[f] = req.body[f];
    }
    if (req.body?.commissions && typeof req.body.commissions === 'object') {
      allowed.commissions = {
        chatExecPct: Number(req.body.commissions.chatExecPct ?? previous.commissions?.chatExecPct ?? 70),
        audioExecPct: Number(req.body.commissions.audioExecPct ?? previous.commissions?.audioExecPct ?? 70),
        videoExecPct: Number(req.body.commissions.videoExecPct ?? previous.commissions?.videoExecPct ?? 70)
      };
    }

    const updated = await PlatformSettings.findOneAndUpdate(
      { key: 'global' },
      { $set: allowed },
      { new: true, upsert: true }
    ).lean();

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'settings_update',
      targetId: 'global',
      details: { previous, updated: allowed }
    });

    res.json({ settings: updated });
  });

  // Withdrawal Management
  router.get('/withdrawals', requirePermission('withdrawals'), async (req, res) => {
    const status = String(req.query.status || '').trim();
    const filter = status ? { status } : {};
    const withdrawals = await WithdrawalRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();

    const execIds = [...new Set(withdrawals.map((w) => w.executiveId))];
    const execs = await User.find({ userId: { $in: execIds } }, { userId: 1, name: 1, email: 1, mobile: 1 }).lean();
    const execMap = new Map(execs.map((e) => [e.userId, e]));

    res.json({
      withdrawals: withdrawals.map((w) => ({
        ...w,
        executive: execMap.get(w.executiveId) || null
      }))
    });
  });

  router.patch('/withdrawals/:id', requirePermission('withdrawals'), async (req, res) => {
    const nextStatus = String(req.body?.status || '');
    const utr = String(req.body?.utr || '').trim().slice(0, 80);
    const rejectionReason = String(req.body?.rejectionReason || '').trim().slice(0, 300);

    if (!['approved', 'processing', 'completed', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid withdrawal status.' });
    }

    const wd = await WithdrawalRequest.findOne({ withdrawalId: req.params.id });
    if (!wd) return res.status(404).json({ error: 'Withdrawal request not found.' });
    if (['completed', 'rejected', 'cancelled'].includes(wd.status)) {
      return res.status(400).json({ error: `Withdrawal is already ${wd.status}.` });
    }

    const prevStatus = wd.status;
    wd.status = nextStatus;
    wd.processedBy = req.user.userId;
    wd.processedAt = Date.now();
    if (utr) wd.utr = utr;
    if (rejectionReason) wd.rejectionReason = rejectionReason;
    await wd.save();

    if (nextStatus === 'completed') {
      await User.updateOne(
        { userId: wd.executiveId },
        { $inc: { 'earnings.withdrawnInr': wd.amountInr } }
      );
      await LedgerTransaction.create({
        txId: newTxId('tx'),
        idempotencyKey: `wd_paid:${wd.withdrawalId}`,
        userId: wd.executiveId,
        role: 'executive',
        kind: 'withdrawal_paid',
        currency: 'INR',
        amount: -wd.amountInr,
        balanceBefore: 0,
        balanceAfter: 0,
        referenceType: 'withdrawal',
        referenceId: wd.withdrawalId,
        note: `Payout completed (UTR: ${utr || 'N/A'})`,
        createdAt: Date.now()
      });
    } else if (nextStatus === 'rejected') {
      const execAfter = await User.findOneAndUpdate(
        { userId: wd.executiveId },
        { $inc: { 'earnings.approvedInr': wd.amountInr } },
        { new: true }
      ).lean();
      const balAfter = round2(execAfter?.earnings?.approvedInr || wd.amountInr);
      await LedgerTransaction.create({
        txId: newTxId('tx'),
        idempotencyKey: `wd_reject:${wd.withdrawalId}`,
        userId: wd.executiveId,
        role: 'executive',
        kind: 'withdrawal_refund',
        currency: 'INR',
        amount: wd.amountInr,
        balanceBefore: round2(balAfter - wd.amountInr),
        balanceAfter: balAfter,
        referenceType: 'withdrawal',
        referenceId: wd.withdrawalId,
        note: `Withdrawal rejected: ${rejectionReason || 'No reason provided'}`,
        createdAt: Date.now()
      });
    }

    await createNotification({
      userId: wd.executiveId,
      category: 'withdrawal',
      title: `Withdrawal ${nextStatus.toUpperCase()}`,
      body:
        nextStatus === 'completed'
          ? `Your ₹${wd.amountInr} withdrawal is paid (UTR: ${utr || 'N/A'}).`
          : nextStatus === 'rejected'
          ? `Your ₹${wd.amountInr} withdrawal was rejected: ${rejectionReason || 'Returned to balance'}.`
          : `Your ₹${wd.amountInr} withdrawal is now ${nextStatus}.`
    });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'withdrawal_status_change',
      targetId: wd.withdrawalId,
      details: { prevStatus, nextStatus, utr, rejectionReason }
    });

    res.json({ withdrawal: wd });
  });

  // Payments & Refunds
  router.get('/payments', requirePermission('finance'), async (req, res) => {
    const status = String(req.query.status || '').trim();
    const filter = status ? { status } : {};
    const payments = await PaymentOrder.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ payments });
  });

  router.post('/payments/:orderId/refund', requirePermission('finance'), async (req, res) => {
    const reason = String(req.body?.reason || 'Admin refund').trim().slice(0, 200);
    const order = await PaymentOrder.findOneAndUpdate(
      { orderId: req.params.orderId, status: 'paid' },
      { $set: { status: 'refunded', refundedAt: Date.now(), refundReason: reason } },
      { new: true }
    ).lean();

    if (!order) {
      return res.status(400).json({ error: 'Only paid orders can be refunded.' });
    }

    const totalCoins = (order.coins || 0) + (order.bonusCoins || 0);
    const updatedUser = await User.findOneAndUpdate(
      { userId: order.userId, coinBalance: { $gte: totalCoins } },
      { $inc: { coinBalance: -totalCoins } },
      { new: true }
    ).lean();

    if (updatedUser) {
      await LedgerTransaction.create({
        txId: newTxId('tx'),
        idempotencyKey: `refund:${order.orderId}`,
        userId: order.userId,
        role: 'customer',
        kind: 'refund',
        currency: 'COINS',
        amount: -totalCoins,
        balanceBefore: updatedUser.coinBalance + totalCoins,
        balanceAfter: updatedUser.coinBalance,
        grossInr: -order.amountInr,
        referenceType: 'payment',
        referenceId: order.orderId,
        note: reason,
        createdAt: Date.now()
      });
      onCoinsUpdated?.(order.userId, updatedUser.coinBalance);
    }

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'payment_refund',
      targetId: order.orderId,
      details: { reason, amountInr: order.amountInr, coinsReversed: Boolean(updatedUser) }
    });

    res.json({ order, coinsReversed: Boolean(updatedUser) });
  });

  // Bonus Rules & Manual Awards
  router.get('/bonuses', requirePermission('finance'), async (_req, res) => {
    const rules = await BonusRule.find().sort({ createdAt: -1 }).lean();
    res.json({ rules });
  });

  router.post('/bonuses', requirePermission('finance'), async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const targetValue = Number(req.body?.targetValue);
    const rewardValue = Number(req.body?.rewardValue);
    if (!name || !targetValue || !rewardValue) {
      return res.status(400).json({ error: 'Name, targetValue, and rewardValue are required.' });
    }

    const rule = await BonusRule.create({
      ruleId: newTxId('bonus'),
      name,
      description: String(req.body?.description || ''),
      bonusType: req.body?.bonusType === 'percentage' ? 'percentage' : 'fixed',
      metric: req.body?.metric || 'chats',
      period: req.body?.period || 'daily',
      targetValue,
      rewardValue,
      maxBonusInr: Number(req.body?.maxBonusInr || 5000),
      applicableCategories: Array.isArray(req.body?.applicableCategories) ? req.body.applicableCategories : [],
      isActive: req.body?.isActive !== false
    });

    res.status(201).json({ rule });
  });

  router.post('/executives/:id/grant-bonus', requirePermission('finance'), async (req, res) => {
    const amountInr = round2(Number(req.body?.amountInr || 0));
    const note = String(req.body?.note || 'Performance bonus').trim().slice(0, 200);
    if (amountInr <= 0) {
      return res.status(400).json({ error: 'Bonus amount must be greater than 0.' });
    }

    const exec = await User.findOneAndUpdate(
      { userId: req.params.id, role: 'executive' },
      { $inc: { 'earnings.bonusInr': amountInr, 'earnings.approvedInr': amountInr } },
      { new: true }
    ).lean();

    if (!exec) return res.status(404).json({ error: 'Executive not found.' });

    const balAfter = round2(exec.earnings?.approvedInr || amountInr);
    await LedgerTransaction.create({
      txId: newTxId('tx'),
      userId: exec.userId,
      role: 'executive',
      kind: 'exec_bonus',
      currency: 'INR',
      amount: amountInr,
      balanceBefore: round2(balAfter - amountInr),
      balanceAfter: balAfter,
      referenceType: 'bonus',
      referenceId: req.user.userId,
      note,
      createdAt: Date.now()
    });

    await createNotification({
      userId: exec.userId,
      category: 'bonus',
      title: 'Bonus Credited!',
      body: `You earned a ₹${amountInr} bonus: ${note}`
    });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'manual_bonus_grant',
      targetId: exec.userId,
      details: { amountInr, note }
    });

    res.json({ earnings: exec.earnings });
  });

  // Monitoring, Reports, Audit Logs & Broadcast Notifications
  router.get('/monitoring/sessions', requirePermission('monitoring'), async (_req, res) => {
    const [activeCalls, recentCalls, reports] = await Promise.all([
      CallSession.find({ status: { $in: ['ringing', 'active'] } }).sort({ startedAt: -1 }).lean(),
      CallSession.find().sort({ startedAt: -1 }).limit(50).lean(),
      Report.find().sort({ createdAt: -1 }).limit(50).lean()
    ]);
    res.json({ activeCalls, recentCalls, reports });
  });

  router.get('/reports/transactions', requirePermission('reports'), async (req, res) => {
    const kind = String(req.query.kind || '').trim();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const filter = kind ? { kind } : {};
    const transactions = await LedgerTransaction.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ transactions });
  });

  router.get('/audit-logs', requirePermission('settings'), async (_req, res) => {
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ logs });
  });

  router.post('/notifications/broadcast', requirePermission('customers'), async (req, res) => {
    const targetRole = String(req.body?.targetRole || 'all'); // 'customer' | 'executive' | 'all'
    const title = String(req.body?.title || '').trim().slice(0, 80);
    const body = String(req.body?.body || '').trim().slice(0, 300);
    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required.' });
    }

    const filter = { accountStatus: 'active' };
    if (targetRole === 'customer' || targetRole === 'executive') {
      filter.role = targetRole;
    } else {
      filter.role = { $in: ['customer', 'executive'] };
    }

    const users = await User.find(filter, { userId: 1 }).lean();
    await Promise.all(
      users.map((u) =>
        createNotification({
          userId: u.userId,
          category: 'announcement',
          title,
          body
        })
      )
    );

    onNotificationBroadcast?.(users.map((u) => u.userId), { title, body });
    res.json({ sentCount: users.length });
  });

  router.post('/admins', requirePermission('settings'), async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : ['reports'];
    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: 'Name, email, and password (min 6 chars) are required.' });
    }

    const created = await User.create({
      userId: crypto.randomUUID(),
      role: 'admin',
      name,
      email,
      passwordHash: hashPassword(password),
      ageConfirmed18Plus: true,
      termsAccepted: true,
      privacyAccepted: true,
      approvalStatus: 'approved',
      adminPermissions: permissions
    });

    await writeAuditLog({
      actorId: req.user.userId,
      actorRole: 'admin',
      action: 'admin_created',
      targetId: created.userId,
      details: { email, permissions }
    });

    res.status(201).json({
      admin: { id: created.userId, name: created.name, email: created.email, permissions }
    });
  });

  return router;
}

module.exports = { createAdminRouter };

