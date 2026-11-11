const express = require('express');
const crypto = require('crypto');
const {
  CoinPackage,
  PaymentOrder,
  LedgerTransaction,
  CallSession
} = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  newTxId,
  getPlatformSettings,
  creditOrderCoinsIdempotent,
  createNotification
} = require('../services/billing');

function createWalletRouter({ onCoinsUpdated }) {
  const router = express.Router();

  const RAZORPAY_KEY_ID = (process.env.RAZORPAY_KEY_ID || '').trim();
  const RAZORPAY_KEY_SECRET = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  const RAZORPAY_WEBHOOK_SECRET = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();

  function hasRazorpayKeys() {
    return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
  }

  // Public/Customer: active coin packages & pricing preview
  router.get('/packages', async (_req, res) => {
    const [packages, settings] = await Promise.all([
      CoinPackage.find({ isActive: true }).sort({ displayOrder: 1, priceInr: 1 }).lean(),
      getPlatformSettings()
    ]);

    res.json({
      packages,
      pricing: {
        chatCoinPerMessage: settings.chatCoinPerMessage,
        audioCoinPerSecond: settings.audioCoinPerSecond,
        videoCoinPerSecond: settings.videoCoinPerSecond
      },
      paymentMode: hasRazorpayKeys() ? 'razorpay' : 'sandbox'
    });
  });

  // Customer wallet summary
  router.get('/balance', requireAuth, requireRole('customer'), async (req, res) => {
    res.json({
      coinBalance: req.user.coinBalance || 0,
      bonusCoinBalance: req.user.bonusCoinBalance || 0,
      totalCoinsPurchased: req.user.totalCoinsPurchased || 0,
      withdrawable: false
    });
  });

  // Customer transaction & usage history
  router.get('/transactions', requireAuth, requireRole('customer'), async (req, res) => {
    const typeFilter = req.query.type ? String(req.query.type) : '';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const query = { userId: req.user.userId };
    if (typeFilter) {
      query.kind = typeFilter;
    }

    const [ledger, payments, calls] = await Promise.all([
      LedgerTransaction.find(query).sort({ createdAt: -1 }).limit(limit).lean(),
      PaymentOrder.find({ userId: req.user.userId }).sort({ createdAt: -1 }).limit(50).lean(),
      CallSession.find({ customerId: req.user.userId }).sort({ startedAt: -1 }).limit(50).lean()
    ]);

    res.json({ ledger, payments, calls });
  });

  // Create coin recharge order (Razorpay or Sandbox test mode)
  router.post('/recharge/create-order', requireAuth, requireRole('customer'), async (req, res) => {
    try {
      const packageId = String(req.body?.packageId || '').trim();
      const provider = String(req.body?.provider || (hasRazorpayKeys() ? 'razorpay' : 'sandbox'));

      const pkg = await CoinPackage.findOne({ packageId, isActive: true }).lean();
      if (!pkg) {
        return res.status(404).json({ error: 'Selected coin package is unavailable.' });
      }

      const orderId = newTxId('ord');
      let gatewayOrderId = orderId;
      let mode = 'sandbox';

      if (hasRazorpayKeys() && provider !== 'sandbox') {
        mode = 'razorpay';
        const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
        const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`
          },
          body: JSON.stringify({
            amount: Math.round(pkg.priceInr * 100),
            currency: 'INR',
            receipt: orderId,
            notes: {
              userId: req.user.userId,
              packageId: pkg.packageId
            }
          })
        });
        const rzpData = await rzpRes.json().catch(() => ({}));
        if (!rzpRes.ok || !rzpData.id) {
          return res.status(502).json({ error: rzpData.error?.description || 'Razorpay order creation failed.' });
        }
        gatewayOrderId = rzpData.id;
      }

      const order = await PaymentOrder.create({
        orderId,
        gatewayOrderId,
        userId: req.user.userId,
        packageId: pkg.packageId,
        packageName: pkg.name,
        amountInr: pkg.priceInr,
        coins: pkg.coins,
        bonusCoins: pkg.bonusCoins || 0,
        provider: mode === 'razorpay' ? 'razorpay' : ['gpay', 'phonepe', 'upi'].includes(provider) ? provider : 'sandbox',
        status: 'pending',
        createdAt: Date.now()
      });

      res.status(201).json({
        mode,
        keyId: mode === 'razorpay' ? RAZORPAY_KEY_ID : null,
        order
      });
    } catch (err) {
      console.error('Create order error:', err);
      res.status(500).json({ error: 'Could not create recharge order.' });
    }
  });

  // Verify payment & credit coins atomically (server-authoritative)
  router.post('/recharge/verify', requireAuth, requireRole('customer'), async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();
      const razorpayOrderId = String(req.body?.razorpay_order_id || '').trim();
      const razorpayPaymentId = String(req.body?.razorpay_payment_id || '').trim();
      const razorpaySignature = String(req.body?.razorpay_signature || '').trim();
      const simulateStatus = String(req.body?.simulateStatus || '').trim();

      const order = await PaymentOrder.findOne({
        $or: [{ orderId }, ...(razorpayOrderId ? [{ gatewayOrderId: razorpayOrderId }] : [])],
        userId: req.user.userId
      }).lean();

      if (!order) {
        return res.status(404).json({ error: 'Payment order not found.' });
      }

      if (simulateStatus === 'failed' || simulateStatus === 'cancelled') {
        await PaymentOrder.updateOne(
          { orderId: order.orderId, status: 'pending' },
          { $set: { status: simulateStatus } }
        );
        await createNotification({
          userId: req.user.userId,
          category: 'wallet',
          title: 'Payment Not Completed',
          body: `Your ₹${order.amountInr} recharge (${order.packageName}) was ${simulateStatus}.`
        });
        return res.status(400).json({ error: `Payment ${simulateStatus}.`, status: simulateStatus });
      }

      if (hasRazorpayKeys() && order.provider === 'razorpay') {
        if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
          return res.status(400).json({ error: 'Missing Razorpay payment signature fields.' });
        }
        const expected = crypto
          .createHmac('sha256', RAZORPAY_KEY_SECRET)
          .update(`${razorpayOrderId}|${razorpayPaymentId}`)
          .digest('hex');

        const sigBuf = Buffer.from(razorpaySignature);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
          await PaymentOrder.updateOne({ orderId: order.orderId, status: 'pending' }, { $set: { status: 'failed' } });
          return res.status(400).json({ error: 'Payment signature verification failed.' });
        }
      } else if (hasRazorpayKeys() && order.provider !== 'razorpay') {
        return res.status(400).json({ error: 'Sandbox verification is disabled when Razorpay keys are active.' });
      }

      const creditResult = await creditOrderCoinsIdempotent({
        orderId: order.orderId,
        gatewayPaymentId: razorpayPaymentId || `sandbox_pay_${Date.now()}`
      });

      if (!creditResult.ok) {
        return res.status(400).json({ error: creditResult.error });
      }

      onCoinsUpdated?.(
        req.user.userId,
        creditResult.coinBalance,
        (req.user.totalCoinsPurchased || 0) + (creditResult.order?.coins || 0)
      );
      res.json({
        success: true,
        duplicate: Boolean(creditResult.duplicate),
        coinBalance: creditResult.coinBalance,
        bonusCoinBalance: creditResult.bonusCoinBalance,
        order: creditResult.order
      });
    } catch (err) {
      console.error('Verify recharge error:', err);
      res.status(500).json({ error: 'Payment verification error.' });
    }
  });

  // Server-to-server Razorpay Webhook (idempotent)
  router.post('/webhook/razorpay', async (req, res) => {
    if (!RAZORPAY_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'Webhook secret not configured.' });
    }

    const signature = String(req.headers['x-razorpay-signature'] || '');
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    const event = req.body?.event;
    const paymentEntity = req.body?.payload?.payment?.entity;
    if (event === 'payment.captured' && paymentEntity?.order_id) {
      const order = await PaymentOrder.findOne({ gatewayOrderId: paymentEntity.order_id }).lean();
      if (order) {
        const result = await creditOrderCoinsIdempotent({
          orderId: order.orderId,
          gatewayPaymentId: paymentEntity.id
        });
        if (result.ok) {
          onCoinsUpdated?.(order.userId, result.coinBalance);
        }
      }
    } else if (event === 'payment.failed' && paymentEntity?.order_id) {
      await PaymentOrder.updateOne(
        { gatewayOrderId: paymentEntity.order_id, status: 'pending' },
        { $set: { status: 'failed' } }
      );
    }

    res.json({ received: true });
  });

  return router;
}

module.exports = { createWalletRouter };

