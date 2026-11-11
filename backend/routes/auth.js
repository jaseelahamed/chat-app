const express = require('express');
const crypto = require('crypto');
const { isDatabaseReady, User, Notification, Report } = require('../db');
const {
  hashPassword,
  verifyPassword,
  signAuthToken,
  requireAuth
} = require('../middleware/auth');
const { newTxId } = require('../services/billing');

function createAuthRouter({ onPresenceChanged }) {
  const router = express.Router();

  function formatPublicSelf(doc) {
    return {
      id: doc.userId,
      role: doc.role,
      name: doc.name,
      username: doc.username || '',
      email: doc.email || '',
      mobile: doc.mobile || '',
      avatar: doc.avatar,
      color: doc.color,
      bio: doc.bio || '',
      accountStatus: doc.accountStatus,
      approvalStatus: doc.approvalStatus,
      coinBalance: doc.coinBalance || 0,
      bonusCoinBalance: doc.bonusCoinBalance || 0,
      totalCoinsPurchased: doc.totalCoinsPurchased || 0,
      category: doc.category || 'Companion',
      languages: doc.languages || [],
      experience: doc.experience || '',
      availability: doc.availability || {},
      payoutDetails: doc.payoutDetails || {},
      earnings: doc.earnings || {},
      preferences: doc.preferences || {},
      adminPermissions: doc.adminPermissions || []
    };
  }

  function createSessionAndToken(userDoc, req) {
    const sessionId = crypto.randomUUID();
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 160);
    const deviceName = String(req.body?.deviceName || 'Web / Mobile Browser').slice(0, 60);
    const now = Date.now();

    const sessionEntry = {
      sessionId,
      deviceName,
      userAgent,
      createdAt: now,
      lastActiveAt: now,
      revoked: false
    };

    const token = signAuthToken({
      userId: userDoc.userId,
      role: userDoc.role,
      tokenVersion: userDoc.tokenVersion || 0,
      sessionId
    });

    return { token, sessionEntry };
  }

  // Customer Registration (No OTP, 18+ & Terms required)
  router.post('/customer/register', async (req, res) => {
    if (!isDatabaseReady()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    try {
      const name = String(req.body?.name || '').trim().slice(0, 48);
      const email = String(req.body?.email || '').trim().toLowerCase();
      const mobile = String(req.body?.mobile || '').trim();
      const password = String(req.body?.password || '');
      const ageConfirmed18Plus = Boolean(req.body?.ageConfirmed18Plus);
      const termsAccepted = Boolean(req.body?.termsAccepted);
      const privacyAccepted = req.body?.privacyAccepted !== false && termsAccepted;

      if (!name) return res.status(400).json({ error: 'Name is required.' });
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email is required.' });
      }
      if (!mobile || !/^[0-9+\-\s]{8,18}$/.test(mobile)) {
        return res.status(400).json({ error: 'Valid mobile number is required.' });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters.' });
      }
      if (!ageConfirmed18Plus) {
        return res.status(400).json({ error: 'You must confirm you are 18+ to register.' });
      }
      if (!termsAccepted || !privacyAccepted) {
        return res.status(400).json({ error: 'You must accept Terms & Conditions and Privacy Policy.' });
      }

      const duplicate = await User.findOne({ $or: [{ email }, { mobile }] }).lean();
      if (duplicate) {
        return res.status(409).json({ error: 'An account with this email or mobile number already exists.' });
      }

      const baseUser = email.split('@')[0].replace(/[^a-z0-9._-]/g, '').slice(0, 16) || 'user';
      const username = `${baseUser}_${crypto.randomBytes(2).toString('hex')}`;

      const userDoc = await User.create({
        userId: crypto.randomUUID(),
        role: 'customer',
        name,
        username,
        email,
        mobile,
        passwordHash: hashPassword(password),
        avatar: String(req.body?.avatar || name[0].toUpperCase()).slice(0, 512),
        color: String(req.body?.color || 'linear-gradient(135deg, #6366f1, #8b5cf6)').slice(0, 96),
        ageConfirmed18Plus: true,
        termsAccepted: true,
        privacyAccepted: true,
        approvalStatus: 'approved'
      });

      const { token, sessionEntry } = createSessionAndToken(userDoc, req);
      await User.updateOne({ userId: userDoc.userId }, { $push: { sessions: { $each: [sessionEntry], $slice: -10 } } });

      onPresenceChanged?.();
      res.status(201).json({ token, user: formatPublicSelf(userDoc) });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Email, mobile, or username already exists.' });
      }
      console.error('Customer register error:', err);
      res.status(500).json({ error: 'Could not register customer account.' });
    }
  });

  // Executive Registration (Requires Admin approval before paid services)
  router.post('/executive/register', async (req, res) => {
    if (!isDatabaseReady()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    try {
      const name = String(req.body?.name || '').trim().slice(0, 48);
      const email = String(req.body?.email || '').trim().toLowerCase();
      const mobile = String(req.body?.mobile || '').trim();
      const password = String(req.body?.password || '');
      const category = String(req.body?.category || 'Companion').trim().slice(0, 40);
      const experience = String(req.body?.experience || '').trim().slice(0, 200);
      const bio = String(req.body?.bio || '').trim().slice(0, 500);
      const languages = Array.isArray(req.body?.languages)
        ? req.body.languages.map((l) => String(l).trim()).filter(Boolean).slice(0, 10)
        : ['English'];
      const termsAccepted = Boolean(req.body?.termsAccepted);

      if (!name) return res.status(400).json({ error: 'Name is required.' });
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email is required.' });
      }
      if (!mobile || !/^[0-9+\-\s]{8,18}$/.test(mobile)) {
        return res.status(400).json({ error: 'Valid mobile number is required.' });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters.' });
      }
      if (!termsAccepted) {
        return res.status(400).json({ error: 'You must accept Terms & Conditions.' });
      }

      const duplicate = await User.findOne({ $or: [{ email }, { mobile }] }).lean();
      if (duplicate) {
        return res.status(409).json({ error: 'An account with this email or mobile number already exists.' });
      }

      const baseUser = email.split('@')[0].replace(/[^a-z0-9._-]/g, '').slice(0, 16) || 'exec';
      const username = `${baseUser}_${crypto.randomBytes(2).toString('hex')}`;

      const payout = req.body?.payoutDetails || {};
      const documents = Array.isArray(req.body?.documents)
        ? req.body.documents.slice(0, 5).map((d) => ({
            label: String(d.label || 'Document').slice(0, 60),
            url: String(d.url || '').slice(0, 500000),
            uploadedAt: Date.now()
          }))
        : [];

      const userDoc = await User.create({
        userId: crypto.randomUUID(),
        role: 'executive',
        name,
        username,
        email,
        mobile,
        passwordHash: hashPassword(password),
        avatar: String(req.body?.avatar || '🎧').slice(0, 512),
        color: String(req.body?.color || 'linear-gradient(135deg, #06b6d4, #3b82f6)').slice(0, 96),
        bio,
        category,
        languages,
        experience,
        ageConfirmed18Plus: true,
        termsAccepted: true,
        privacyAccepted: true,
        approvalStatus: 'pending',
        payoutDetails: {
          upiId: String(payout.upiId || '').trim().slice(0, 80),
          accountHolder: String(payout.accountHolder || '').trim().slice(0, 80),
          accountNumber: String(payout.accountNumber || '').trim().slice(0, 40),
          ifsc: String(payout.ifsc || '').trim().toUpperCase().slice(0, 20),
          bankName: String(payout.bankName || '').trim().slice(0, 80)
        },
        documents
      });

      const { token, sessionEntry } = createSessionAndToken(userDoc, req);
      await User.updateOne({ userId: userDoc.userId }, { $push: { sessions: { $each: [sessionEntry], $slice: -10 } } });

      res.status(201).json({
        token,
        user: formatPublicSelf(userDoc),
        message: 'Registration submitted. Your account is pending Admin approval.'
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Email or mobile number already exists.' });
      }
      console.error('Executive register error:', err);
      res.status(500).json({ error: 'Could not register executive account.' });
    }
  });

  // Legacy-compatible registration (used by current Pazhi frontend)
  router.post('/register', async (req, res) => {
    if (!isDatabaseReady()) {
      return res.status(503).json({ error: 'Database is not connected. Set MONGODB_URI on the backend.' });
    }

    try {
      const name = String(req.body?.name || '').trim().slice(0, 32);
      const rawUsername = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const avatar = String(req.body?.avatar || name[0]?.toUpperCase() || '⚡').slice(0, 512);
      const color = String(req.body?.color || 'linear-gradient(135deg, #6366f1, #8b5cf6)').slice(0, 96);

      if (!name) return res.status(400).json({ error: 'Please enter your name.' });
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
        role: 'customer',
        name,
        username: rawUsername,
        passwordHash: hashPassword(password),
        avatar,
        color,
        ageConfirmed18Plus: true,
        termsAccepted: true,
        privacyAccepted: true,
        approvalStatus: 'approved'
      });

      const { token, sessionEntry } = createSessionAndToken(userDoc, req);
      await User.updateOne({ userId: userDoc.userId }, { $push: { sessions: { $each: [sessionEntry], $slice: -10 } } });

      onPresenceChanged?.();
      res.status(201).json({ token, user: formatPublicSelf(userDoc) });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Username is already taken.' });
      }
      console.error('Register error:', err);
      res.status(500).json({ error: 'Could not register account.' });
    }
  });

  // Universal Login (username / email / mobile + password)
  router.post('/login', async (req, res) => {
    if (!isDatabaseReady()) {
      return res.status(503).json({ error: 'Database is not connected. Set MONGODB_URI on the backend.' });
    }

    try {
      const identifier = String(
        req.body?.identifier || req.body?.username || req.body?.email || req.body?.mobile || ''
      )
        .trim();
      const password = String(req.body?.password || '');
      const expectedRole = req.body?.role ? String(req.body.role) : null;

      if (!identifier || !password) {
        return res.status(400).json({ error: 'Login credentials and password are required.' });
      }

      const lower = identifier.toLowerCase();
      const query = {
        $or: [{ username: lower }, { email: lower }, { mobile: identifier }]
      };
      if (expectedRole) {
        query.role = expectedRole;
      }

      const userDoc = await User.findOne(query).lean();
      if (!userDoc || !verifyPassword(password, userDoc.passwordHash)) {
        return res.status(401).json({ error: 'Invalid credentials or password.' });
      }
      if (userDoc.accountStatus !== 'active') {
        return res.status(403).json({ error: `Account is ${userDoc.accountStatus}. Contact support.` });
      }

      const { token, sessionEntry } = createSessionAndToken(userDoc, req);
      await User.updateOne({ userId: userDoc.userId }, { $push: { sessions: { $each: [sessionEntry], $slice: -10 } } });

      res.json({ token, user: formatPublicSelf(userDoc) });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Could not log in.' });
    }
  });

  router.post('/forgot-password', async (req, res) => {
    if (!isDatabaseReady()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }
    const identifier = String(req.body?.identifier || req.body?.email || req.body?.mobile || '').trim();
    if (!identifier) {
      return res.status(400).json({ error: 'Email or mobile number is required.' });
    }

    const lower = identifier.toLowerCase();
    const userDoc = await User.findOne({ $or: [{ email: lower }, { mobile: identifier }] });
    if (!userDoc) {
      return res.json({ message: 'If an account matches, a reset token has been generated.' });
    }

    const rawResetToken = crypto.randomBytes(16).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(rawResetToken).digest('hex');
    userDoc.resetTokenHash = resetTokenHash;
    userDoc.resetTokenExpiresAt = Date.now() + 15 * 60 * 1000;
    await userDoc.save();

    res.json({
      message: 'Password reset token generated (valid for 15 minutes).',
      resetToken: rawResetToken
    });
  });

  router.post('/reset-password', async (req, res) => {
    if (!isDatabaseReady()) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }
    const resetToken = String(req.body?.resetToken || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!resetToken || newPassword.length < 4) {
      return res.status(400).json({ error: 'Valid reset token and new password (min 4 chars) required.' });
    }

    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const userDoc = await User.findOne({
      resetTokenHash,
      resetTokenExpiresAt: { $gt: Date.now() }
    });
    if (!userDoc) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    userDoc.passwordHash = hashPassword(newPassword);
    userDoc.resetTokenHash = null;
    userDoc.resetTokenExpiresAt = 0;
    userDoc.tokenVersion += 1;
    await userDoc.save();

    res.json({ message: 'Password reset successful. Please log in with your new password.' });
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json({ user: formatPublicSelf(req.user) });
  });

  router.put('/profile', requireAuth, async (req, res) => {
    try {
      const updates = {};
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim().slice(0, 48);
        if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
        updates.name = name;
      }
      if (req.body?.avatar !== undefined) updates.avatar = String(req.body.avatar).slice(0, 512);
      if (req.body?.color !== undefined) updates.color = String(req.body.color).slice(0, 96);
      if (req.body?.bio !== undefined) updates.bio = String(req.body.bio).trim().slice(0, 500);
      if (req.body?.email !== undefined) {
        const email = String(req.body.email).trim().toLowerCase();
        if (email) updates.email = email;
      }
      if (req.body?.mobile !== undefined) {
        const mobile = String(req.body.mobile).trim();
        if (mobile) updates.mobile = mobile;
      }
      if (req.body?.preferences && typeof req.body.preferences === 'object') {
        updates.preferences = {
          notificationsEnabled: req.body.preferences.notificationsEnabled !== false,
          promotionalAlerts: req.body.preferences.promotionalAlerts !== false
        };
      }
      if (req.user.role === 'executive') {
        if (req.body?.category !== undefined) updates.category = String(req.body.category).trim().slice(0, 40);
        if (req.body?.experience !== undefined) updates.experience = String(req.body.experience).trim().slice(0, 200);
        if (Array.isArray(req.body?.languages)) {
          updates.languages = req.body.languages.map((l) => String(l).trim()).filter(Boolean).slice(0, 10);
        }
        if (req.body?.payoutDetails && typeof req.body.payoutDetails === 'object') {
          updates.payoutDetails = {
            upiId: String(req.body.payoutDetails.upiId || '').trim().slice(0, 80),
            accountHolder: String(req.body.payoutDetails.accountHolder || '').trim().slice(0, 80),
            accountNumber: String(req.body.payoutDetails.accountNumber || '').trim().slice(0, 40),
            ifsc: String(req.body.payoutDetails.ifsc || '').trim().toUpperCase().slice(0, 20),
            bankName: String(req.body.payoutDetails.bankName || '').trim().slice(0, 80)
          };
        }
      }

      const updated = await User.findOneAndUpdate(
        { userId: req.user.userId },
        { $set: updates },
        { new: true, projection: { passwordHash: 0 } }
      ).lean();

      onPresenceChanged?.(updated);
      res.json({ user: formatPublicSelf(updated) });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Email or mobile is already used by another account.' });
      }
      console.error('Profile update error:', err);
      res.status(500).json({ error: 'Could not update profile.' });
    }
  });

  router.put('/change-password', requireAuth, async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }

    const doc = await User.findOne({ userId: req.user.userId });
    if (!doc || !verifyPassword(currentPassword, doc.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    doc.passwordHash = hashPassword(newPassword);
    doc.tokenVersion += 1;
    await doc.save();

    const { token, sessionEntry } = createSessionAndToken(doc, req);
    await User.updateOne({ userId: doc.userId }, { $push: { sessions: { $each: [sessionEntry], $slice: -10 } } });

    res.json({ message: 'Password updated.', token });
  });

  router.post('/logout-all', requireAuth, async (req, res) => {
    await User.updateOne(
      { userId: req.user.userId },
      {
        $inc: { tokenVersion: 1 },
        $set: { 'sessions.$[].revoked': true }
      }
    );
    res.json({ message: 'Logged out from all devices.' });
  });

  router.get('/sessions', requireAuth, async (req, res) => {
    res.json({ sessions: (req.user.sessions || []).filter((s) => !s.revoked) });
  });

  router.post('/deactivate', requireAuth, async (req, res) => {
    const action = req.body?.mode === 'delete' ? 'deleted' : 'deactivated';
    await User.updateOne(
      { userId: req.user.userId },
      {
        $set: { accountStatus: action },
        $inc: { tokenVersion: 1 }
      }
    );
    onPresenceChanged?.();
    res.json({ message: `Account ${action}.` });
  });

  router.post('/block', requireAuth, async (req, res) => {
    const targetUserId = String(req.body?.userId || '').trim();
    const unblock = Boolean(req.body?.unblock);
    if (!targetUserId || targetUserId === req.user.userId) {
      return res.status(400).json({ error: 'Invalid target user.' });
    }
    await User.updateOne(
      { userId: req.user.userId },
      unblock
        ? { $pull: { blockedUsers: targetUserId } }
        : { $addToSet: { blockedUsers: targetUserId } }
    );
    res.json({ message: unblock ? 'User unblocked.' : 'User blocked.' });
  });

  router.post('/report', requireAuth, async (req, res) => {
    const reportedUserId = String(req.body?.userId || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const roomId = String(req.body?.roomId || '').trim();
    if (!reportedUserId || !reason) {
      return res.status(400).json({ error: 'Target user and reason are required.' });
    }
    const report = await Report.create({
      reportId: newTxId('rep'),
      reporterId: req.user.userId,
      reportedUserId,
      reason,
      roomId,
      createdAt: Date.now()
    });
    res.status(201).json({ report });
  });

  router.get('/notifications', requireAuth, async (req, res) => {
    const notifications = await Notification.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ notifications });
  });

  router.post('/notifications/read', requireAuth, async (req, res) => {
    await Notification.updateMany(
      { userId: req.user.userId, read: false },
      { $set: { read: true } }
    );
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAuthRouter };

