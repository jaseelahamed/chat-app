const { BonusRule, LedgerTransaction, CallSession, User } = require('../db');
const { round2, newTxId, createNotification } = require('./billing');

function getPeriodWindow(period) {
  const now = new Date();
  if (period === 'daily') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return { start, key };
  }
  if (period === 'weekly') {
    const day = now.getDay();
    const diff = (day === 0 ? 6 : day - 1) * 86400000;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    monday.setTime(monday.getTime() - diff);
    const key = `W_${monday.getFullYear()}_${String(monday.getMonth() + 1).padStart(2, '0')}_${String(monday.getDate()).padStart(2, '0')}`;
    return { start: monday.getTime(), key };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return { start, key };
}

async function evaluateExecutiveBonuses(executiveId) {
  if (!executiveId) return;
  try {
    const [exec, rules] = await Promise.all([
      User.findOne({ userId: executiveId, role: 'executive', approvalStatus: 'approved' }).lean(),
      BonusRule.find({ isActive: true }).lean()
    ]);
    if (!exec || rules.length === 0) return;

    const now = Date.now();
    for (const rule of rules) {
      if (rule.startsAt && now < rule.startsAt) continue;
      if (rule.endsAt && now > rule.endsAt) continue;
      if (
        Array.isArray(rule.applicableCategories) &&
        rule.applicableCategories.length > 0 &&
        !rule.applicableCategories.includes(exec.category)
      ) {
        continue;
      }

      const { start, key } = getPeriodWindow(rule.period);
      const idempotencyKey = `auto_bonus:${rule.ruleId}:${executiveId}:${key}`;
      const alreadyCredited = await LedgerTransaction.exists({ idempotencyKey });
      if (alreadyCredited) continue;

      let progress = 0;
      let periodEarningsInr = 0;

      const earningRows = await LedgerTransaction.find({
        userId: executiveId,
        kind: { $in: ['exec_chat_earning', 'exec_audio_earning', 'exec_video_earning'] },
        createdAt: { $gte: start }
      }).lean();

      for (const row of earningRows) {
        periodEarningsInr += row.amount || 0;
        if (rule.metric === 'chats' && row.kind === 'exec_chat_earning') {
          progress += 1;
        }
      }

      if (rule.metric === 'earnings_inr') {
        progress = periodEarningsInr;
      } else if (rule.metric === 'audio_minutes' || rule.metric === 'video_minutes') {
        const callType = rule.metric === 'audio_minutes' ? 'audio' : 'video';
        const calls = await CallSession.find({
          executiveId,
          callType,
          isPaid: true,
          startedAt: { $gte: start }
        }).lean();
        const totalSeconds = calls.reduce((s, c) => s + (c.billedSeconds || 0), 0);
        progress = totalSeconds / 60;
      }

      if (progress < rule.targetValue) continue;

      let bonusAmount =
        rule.bonusType === 'percentage'
          ? round2((periodEarningsInr * rule.rewardValue) / 100)
          : round2(rule.rewardValue);
      if (rule.maxBonusInr > 0) {
        bonusAmount = Math.min(bonusAmount, rule.maxBonusInr);
      }
      if (bonusAmount <= 0) continue;

      const updatedExec = await User.findOneAndUpdate(
        { userId: executiveId },
        { $inc: { 'earnings.bonusInr': bonusAmount, 'earnings.approvedInr': bonusAmount } },
        { new: true }
      ).lean();

      const balAfter = round2(updatedExec?.earnings?.approvedInr || bonusAmount);
      await LedgerTransaction.create({
        txId: newTxId('tx'),
        idempotencyKey,
        userId: executiveId,
        role: 'executive',
        kind: 'exec_bonus',
        currency: 'INR',
        amount: bonusAmount,
        balanceBefore: round2(balAfter - bonusAmount),
        balanceAfter: balAfter,
        referenceType: 'bonus',
        referenceId: rule.ruleId,
        note: `Auto bonus: ${rule.name} (${key})`,
        createdAt: Date.now()
      });

      await createNotification({
        userId: executiveId,
        category: 'bonus',
        title: 'Target Bonus Earned!',
        body: `You hit "${rule.name}" and earned ₹${bonusAmount}!`
      });
    }
  } catch (err) {
    console.error('evaluateExecutiveBonuses error:', err.message);
  }
}

module.exports = { evaluateExecutiveBonuses };

