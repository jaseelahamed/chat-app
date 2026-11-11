const crypto = require('crypto');
const {
  User,
  PlatformSettings,
  CoinPackage,
  PaymentOrder,
  LedgerTransaction,
  Notification,
  AuditLog
} = require('../db');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function newTxId(prefix = 'tx') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function getPlatformSettings() {
  let settings = await PlatformSettings.findOne({ key: 'global' }).lean();
  if (!settings) {
    settings = await PlatformSettings.create({ key: 'global', platformName: 'Pazhi' });
    settings = settings.toObject();
  }
  return settings;
}

async function createNotification({ userId, category = 'system', title, body, metadata = {} }) {
  if (!userId) return null;
  try {
    return await Notification.create({
      notificationId: newTxId('notif'),
      userId,
      category,
      title,
      body,
      metadata,
      createdAt: Date.now()
    });
  } catch (err) {
    console.error('Notification create error:', err.message);
    return null;
  }
}

async function writeAuditLog({ actorId, actorRole, action, targetId = '', details = {} }) {
  try {
    return await AuditLog.create({
      logId: newTxId('audit'),
      actorId,
      actorRole,
      action,
      targetId,
      details,
      createdAt: Date.now()
    });
  } catch (err) {
    console.error('AuditLog write error:', err.message);
    return null;
  }
}

async function atomicDebitCustomerCoins({
  customerId,
  coins,
  kind,
  referenceType,
  referenceId,
  counterpartyId = '',
  idempotencyKey = '',
  note = ''
}) {
  if (coins <= 0) {
    const user = await User.findOne({ userId: customerId }, { coinBalance: 1 }).lean();
    return { ok: true, coinsCharged: 0, remainingCoins: user?.coinBalance || 0 };
  }

  if (idempotencyKey) {
    const existing = await LedgerTransaction.findOne({ idempotencyKey }).lean();
    if (existing) {
      const user = await User.findOne({ userId: customerId }, { coinBalance: 1 }).lean();
      return { ok: true, duplicate: true, coinsCharged: 0, remainingCoins: user?.coinBalance || 0 };
    }
  }

  const updated = await User.findOneAndUpdate(
    { userId: customerId, accountStatus: 'active', coinBalance: { $gte: coins } },
    { $inc: { coinBalance: -coins } },
    { new: true }
  ).lean();

  if (!updated) {
    const current = await User.findOne({ userId: customerId }, { coinBalance: 1 }).lean();
    return {
      ok: false,
      reason: 'insufficient_balance',
      remainingCoins: current?.coinBalance || 0
    };
  }

  const balanceAfter = updated.coinBalance;
  const balanceBefore = balanceAfter + coins;

  await LedgerTransaction.create({
    txId: newTxId('tx'),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    userId: customerId,
    role: 'customer',
    kind,
    currency: 'COINS',
    amount: -coins,
    balanceBefore,
    balanceAfter,
    referenceType,
    referenceId,
    counterpartyId,
    note,
    createdAt: Date.now()
  });

  return {
    ok: true,
    coinsCharged: coins,
    remainingCoins: balanceAfter
  };
}

async function creditExecutiveForService({
  executiveId,
  customerId,
  serviceType, // 'chat' | 'audio' | 'video'
  coinsCharged,
  referenceType,
  referenceId,
  idempotencyKey = '',
  note = ''
}) {
  if (!executiveId || coinsCharged <= 0) {
    return { grossInr: 0, execNetInr: 0, platformCommissionInr: 0 };
  }

  if (idempotencyKey) {
    const existing = await LedgerTransaction.findOne({ idempotencyKey }).lean();
    if (existing) {
      return {
        duplicate: true,
        grossInr: existing.grossInr || 0,
        execNetInr: existing.executiveNetInr || 0,
        platformCommissionInr: existing.platformCommissionInr || 0
      };
    }
  }

  const settings = await getPlatformSettings();
  const grossInr = round2(coinsCharged * (settings.coinToInrRate || 1));

  const pctMap = {
    chat: settings.commissions?.chatExecPct ?? 70,
    audio: settings.commissions?.audioExecPct ?? 70,
    video: settings.commissions?.videoExecPct ?? 70
  };
  const execPct = pctMap[serviceType] ?? 70;
  const execNetInr = round2((grossInr * execPct) / 100);
  const platformCommissionInr = round2(grossInr - execNetInr);

  const fieldMap = {
    chat: 'earnings.chatInr',
    audio: 'earnings.audioInr',
    video: 'earnings.videoInr'
  };
  const kindMap = {
    chat: 'exec_chat_earning',
    audio: 'exec_audio_earning',
    video: 'exec_video_earning'
  };

  const execAfter = await User.findOneAndUpdate(
    { userId: executiveId },
    {
      $inc: {
        [fieldMap[serviceType]]: execNetInr,
        'earnings.approvedInr': execNetInr
      }
    },
    { new: true }
  ).lean();

  const balAfter = round2(execAfter?.earnings?.approvedInr || execNetInr);
  const balBefore = round2(balAfter - execNetInr);

  await LedgerTransaction.create({
    txId: newTxId('tx'),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    userId: executiveId,
    role: 'executive',
    kind: kindMap[serviceType],
    currency: 'INR',
    amount: execNetInr,
    balanceBefore: balBefore,
    balanceAfter: balAfter,
    grossInr,
    platformCommissionInr,
    executiveNetInr: execNetInr,
    referenceType,
    referenceId,
    counterpartyId: customerId,
    note,
    createdAt: Date.now()
  });

  if (platformCommissionInr > 0) {
    await LedgerTransaction.create({
      txId: newTxId('tx'),
      userId: 'platform',
      role: 'platform',
      kind: 'platform_commission',
      currency: 'INR',
      amount: platformCommissionInr,
      balanceBefore: 0,
      balanceAfter: platformCommissionInr,
      grossInr,
      platformCommissionInr,
      executiveNetInr: execNetInr,
      referenceType,
      referenceId,
      counterpartyId: executiveId,
      note: `${serviceType} commission (${100 - execPct}%)`,
      createdAt: Date.now()
    });
  }

  return { grossInr, execNetInr, platformCommissionInr };
}

async function creditOrderCoinsIdempotent({ orderId, gatewayPaymentId = '' }) {
  const paidOrder = await PaymentOrder.findOneAndUpdate(
    { orderId, status: 'pending' },
    {
      $set: {
        status: 'paid',
        gatewayPaymentId: gatewayPaymentId || orderId,
        creditedAt: Date.now()
      }
    },
    { new: true }
  ).lean();

  if (!paidOrder) {
    const existing = await PaymentOrder.findOne({ orderId }).lean();
    if (!existing) {
      return { ok: false, error: 'Order not found.' };
    }
    if (existing.status === 'paid') {
      const user = await User.findOne({ userId: existing.userId }, { coinBalance: 1, bonusCoinBalance: 1 }).lean();
      return {
        ok: true,
        duplicate: true,
        order: existing,
        coinBalance: user?.coinBalance || 0,
        bonusCoinBalance: user?.bonusCoinBalance || 0
      };
    }
    return { ok: false, error: `Order is ${existing.status}.` };
  }

  const totalToCredit = (paidOrder.coins || 0) + (paidOrder.bonusCoins || 0);
  const updatedUser = await User.findOneAndUpdate(
    { userId: paidOrder.userId },
    {
      $inc: {
        coinBalance: totalToCredit,
        bonusCoinBalance: paidOrder.bonusCoins || 0,
        totalCoinsPurchased: paidOrder.coins || 0
      }
    },
    { new: true }
  ).lean();

  const balanceAfter = updatedUser?.coinBalance || totalToCredit;
  const balanceBefore = balanceAfter - totalToCredit;

  await LedgerTransaction.create({
    txId: newTxId('tx'),
    idempotencyKey: `purchase:${paidOrder.orderId}`,
    userId: paidOrder.userId,
    role: 'customer',
    kind: 'coin_purchase',
    currency: 'COINS',
    amount: paidOrder.coins,
    balanceBefore,
    balanceAfter: balanceBefore + paidOrder.coins,
    grossInr: paidOrder.amountInr,
    referenceType: 'payment',
    referenceId: paidOrder.orderId,
    note: `Purchased ${paidOrder.packageName || paidOrder.packageId} (₹${paidOrder.amountInr})`,
    createdAt: Date.now()
  });

  if (paidOrder.bonusCoins > 0) {
    await LedgerTransaction.create({
      txId: newTxId('tx'),
      idempotencyKey: `bonus:${paidOrder.orderId}`,
      userId: paidOrder.userId,
      role: 'customer',
      kind: 'bonus_credit',
      currency: 'COINS',
      amount: paidOrder.bonusCoins,
      balanceBefore: balanceBefore + paidOrder.coins,
      balanceAfter,
      referenceType: 'payment',
      referenceId: paidOrder.orderId,
      note: `Bonus coins from ${paidOrder.packageName || paidOrder.packageId}`,
      createdAt: Date.now()
    });
  }

  await CoinPackage.updateOne(
    { packageId: paidOrder.packageId },
    { $inc: { salesCount: 1, totalRevenueInr: paidOrder.amountInr } }
  );

  await createNotification({
    userId: paidOrder.userId,
    category: 'wallet',
    title: 'Coins Credited',
    body: `${totalToCredit} coins (${paidOrder.coins} + ${paidOrder.bonusCoins} bonus) added to your wallet.`,
    metadata: { orderId: paidOrder.orderId, amountInr: paidOrder.amountInr }
  });

  return {
    ok: true,
    order: paidOrder,
    coinBalance: balanceAfter,
    bonusCoinBalance: updatedUser?.bonusCoinBalance || 0
  };
}

module.exports = {
  round2,
  newTxId,
  getPlatformSettings,
  createNotification,
  writeAuditLog,
  atomicDebitCustomerCoins,
  creditExecutiveForService,
  creditOrderCoinsIdempotent
};

