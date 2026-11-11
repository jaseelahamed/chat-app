const mongoose = require('mongoose');
const crypto = require('crypto');

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ['customer', 'executive', 'admin'], default: 'customer', index: true },
    name: { type: String, required: true, trim: true, maxlength: 48 },
    username: { type: String, unique: true, sparse: true, lowercase: true, trim: true, maxlength: 32 },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true, maxlength: 120 },
    mobile: { type: String, unique: true, sparse: true, trim: true, maxlength: 20 },
    passwordHash: { type: String, required: true },
    avatar: { type: String, default: '⚡', maxlength: 512 },
    color: { type: String, default: 'linear-gradient(135deg, #6366f1, #8b5cf6)', maxlength: 96 },
    bio: { type: String, default: '', maxlength: 500 },

    // Compliance & account lifecycle
    ageConfirmed18Plus: { type: Boolean, default: false },
    termsAccepted: { type: Boolean, default: false },
    privacyAccepted: { type: Boolean, default: false },
    accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'blocked', 'deactivated', 'deleted'],
      default: 'active',
      index: true
    },
    tokenVersion: { type: Number, default: 0 },
    resetTokenHash: { type: String, default: null },
    resetTokenExpiresAt: { type: Number, default: 0 },
    sessions: {
      type: [
        new mongoose.Schema(
          {
            sessionId: String,
            deviceName: String,
            userAgent: String,
            createdAt: Number,
            lastActiveAt: Number,
            revoked: { type: Boolean, default: false }
          },
          { _id: false }
        )
      ],
      default: []
    },
    preferences: {
      notificationsEnabled: { type: Boolean, default: true },
      promotionalAlerts: { type: Boolean, default: true }
    },
    blockedUsers: { type: [String], default: [] },

    // Customer Wallet (Coins only — non-withdrawable)
    coinBalance: { type: Number, default: 0, min: 0 },
    bonusCoinBalance: { type: Number, default: 0, min: 0 },
    totalCoinsPurchased: { type: Number, default: 0, min: 0 },

    // Executive Onboarding, Availability & INR Earnings
    approvalStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true
    },
    approvalNote: { type: String, default: '' },
    category: { type: String, default: 'Companion', index: true },
    languages: { type: [String], default: ['English'] },
    experience: { type: String, default: '' },
    ratingAvg: { type: Number, default: 5.0 },
    ratingCount: { type: Number, default: 0 },
    availability: {
      manualStatus: { type: String, enum: ['available', 'busy', 'offline'], default: 'offline' },
      chatEnabled: { type: Boolean, default: true },
      audioEnabled: { type: Boolean, default: true },
      videoEnabled: { type: Boolean, default: true },
      adminRestricted: { type: Boolean, default: false }
    },
    payoutDetails: {
      upiId: { type: String, default: '' },
      accountHolder: { type: String, default: '' },
      accountNumber: { type: String, default: '' },
      ifsc: { type: String, default: '' },
      bankName: { type: String, default: '' }
    },
    documents: {
      type: [
        new mongoose.Schema(
          {
            label: String,
            url: String,
            uploadedAt: Number
          },
          { _id: false }
        )
      ],
      default: []
    },
    earnings: {
      chatInr: { type: Number, default: 0 },
      audioInr: { type: Number, default: 0 },
      videoInr: { type: Number, default: 0 },
      bonusInr: { type: Number, default: 0 },
      pendingInr: { type: Number, default: 0 },
      approvedInr: { type: Number, default: 0 },
      withdrawnInr: { type: Number, default: 0 }
    },

    // Admin Role Permissions
    adminPermissions: {
      type: [String],
      default: []
    }
  },
  { timestamps: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String },
    type: { type: String },
    size: { type: Number },
    dataUrl: { type: String }
  },
  { _id: false }
);

const replyToSchema = new mongoose.Schema(
  {
    id: { type: String },
    senderName: { type: String },
    text: { type: String }
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    roomId: { type: String, required: true, index: true },
    targetType: { type: String, enum: ['channel', 'dm'], required: true },
    participants: { type: [String], default: [], index: true },
    type: { type: String, default: 'text' },
    callType: { type: String },
    senderId: { type: String, required: true },
    senderName: { type: String },
    senderAvatar: { type: String },
    senderColor: { type: String },
    text: { type: String, default: '' },
    attachment: { type: attachmentSchema, default: null },
    replyTo: { type: replyToSchema, default: null },
    reactions: { type: mongoose.Schema.Types.Mixed, default: {} },
    deliveryStatus: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
    isPaid: { type: Boolean, default: false },
    coinsCharged: { type: Number, default: 0 },
    viewOnce: { type: Boolean, default: false },
    viewedBy: { type: [String], default: [] },
    expiresAt: { type: Number, default: null, index: true },
    createdAt: { type: Number, required: true, index: true }
  },
  { minimize: false }
);
messageSchema.index({ roomId: 1, createdAt: 1 });

const platformSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    platformName: { type: String, default: 'Pazhi' },
    maintenanceMode: { type: Boolean, default: false },
    chatCoinPerMessage: { type: Number, default: 10, min: 0 },
    freeMessagesEnabled: { type: Boolean, default: false },
    freeMessageLimit: { type: Number, default: 0, min: 0 },
    audioCoinPerSecond: { type: Number, default: 1, min: 0 },
    videoCoinPerSecond: { type: Number, default: 2, min: 0 },
    coinToInrRate: { type: Number, default: 1, min: 0.01 },
    commissions: {
      chatExecPct: { type: Number, default: 70, min: 0, max: 100 },
      audioExecPct: { type: Number, default: 70, min: 0, max: 100 },
      videoExecPct: { type: Number, default: 70, min: 0, max: 100 }
    },
    minWithdrawalInr: { type: Number, default: 500, min: 1 },
    messageExpirySeconds: { type: Number, default: 0, min: 0 },
    viewOnceEnabled: { type: Boolean, default: true },
    lowBalanceWarningCoins: { type: Number, default: 30, min: 0 },
    termsText: { type: String, default: 'Users must be 18+ and follow platform safety guidelines.' },
    privacyText: { type: String, default: 'Your account and transaction data are protected.' },
    supportEmail: { type: String, default: 'support@pazhi.app' }
  },
  { timestamps: true }
);

const coinPackageSchema = new mongoose.Schema(
  {
    packageId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    priceInr: { type: Number, required: true, min: 1 },
    coins: { type: Number, required: true, min: 1 },
    bonusCoins: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true, index: true },
    isPromotional: { type: Boolean, default: false },
    displayOrder: { type: Number, default: 0 },
    salesCount: { type: Number, default: 0 },
    totalRevenueInr: { type: Number, default: 0 }
  },
  { timestamps: true }
);

const paymentOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    gatewayOrderId: { type: String, index: true },
    gatewayPaymentId: { type: String, index: true },
    userId: { type: String, required: true, index: true },
    packageId: { type: String, required: true },
    packageName: { type: String },
    amountInr: { type: Number, required: true },
    coins: { type: Number, required: true },
    bonusCoins: { type: Number, default: 0 },
    provider: {
      type: String,
      enum: ['razorpay', 'upi', 'gpay', 'phonepe', 'sandbox'],
      default: 'razorpay'
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'cancelled', 'refunded'],
      default: 'pending',
      index: true
    },
    creditedAt: { type: Number, default: null },
    refundedAt: { type: Number, default: null },
    refundReason: { type: String, default: '' },
    createdAt: { type: Number, required: true, index: true }
  }
);

const ledgerTransactionSchema = new mongoose.Schema({
  txId: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, unique: true, sparse: true },
  userId: { type: String, required: true, index: true },
  role: { type: String, enum: ['customer', 'executive', 'platform', 'admin'], required: true },
  kind: {
    type: String,
    enum: [
      'coin_purchase',
      'bonus_credit',
      'chat_debit',
      'audio_debit',
      'video_debit',
      'refund',
      'exec_chat_earning',
      'exec_audio_earning',
      'exec_video_earning',
      'exec_bonus',
      'platform_commission',
      'withdrawal_hold',
      'withdrawal_paid',
      'withdrawal_refund',
      'admin_adjustment'
    ],
    required: true,
    index: true
  },
  currency: { type: String, enum: ['COINS', 'INR'], required: true },
  amount: { type: Number, required: true },
  balanceBefore: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  grossInr: { type: Number, default: 0 },
  platformCommissionInr: { type: Number, default: 0 },
  executiveNetInr: { type: Number, default: 0 },
  referenceType: { type: String, default: '' },
  referenceId: { type: String, default: '', index: true },
  counterpartyId: { type: String, default: '' },
  note: { type: String, default: '' },
  createdAt: { type: Number, required: true, index: true }
});

const callSessionSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true, index: true },
  roomId: { type: String, required: true, index: true },
  channel: { type: String, required: true },
  callType: { type: String, enum: ['audio', 'video'], required: true },
  callerId: { type: String, required: true },
  calleeId: { type: String, required: true },
  customerId: { type: String, index: true },
  executiveId: { type: String, index: true },
  isPaid: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['ringing', 'active', 'ended', 'rejected', 'cancelled', 'missed'],
    default: 'ringing',
    index: true
  },
  coinRatePerSec: { type: Number, default: 0 },
  billedSeconds: { type: Number, default: 0 },
  totalCoinsCharged: { type: Number, default: 0 },
  execEarnedInr: { type: Number, default: 0 },
  platformCommissionInr: { type: Number, default: 0 },
  endReason: { type: String, default: '' },
  startedAt: { type: Number, required: true },
  connectedAt: { type: Number, default: null },
  endedAt: { type: Number, default: null }
});

const withdrawalRequestSchema = new mongoose.Schema({
  withdrawalId: { type: String, required: true, unique: true, index: true },
  executiveId: { type: String, required: true, index: true },
  amountInr: { type: Number, required: true, min: 1 },
  payoutMethod: { type: String, enum: ['upi', 'bank'], default: 'upi' },
  payoutDetails: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['pending', 'approved', 'processing', 'completed', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  utr: { type: String, default: '' },
  rejectionReason: { type: String, default: '' },
  processedBy: { type: String, default: '' },
  createdAt: { type: Number, required: true, index: true },
  processedAt: { type: Number, default: null }
});

const bonusRuleSchema = new mongoose.Schema(
  {
    ruleId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    bonusType: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
    metric: {
      type: String,
      enum: ['chats', 'audio_minutes', 'video_minutes', 'earnings_inr'],
      default: 'chats'
    },
    period: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'daily' },
    targetValue: { type: Number, required: true, min: 1 },
    rewardValue: { type: Number, required: true, min: 1 },
    maxBonusInr: { type: Number, default: 5000 },
    applicableCategories: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    startsAt: { type: Number, default: null },
    endsAt: { type: Number, default: null }
  },
  { timestamps: true }
);

const notificationSchema = new mongoose.Schema({
  notificationId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  category: { type: String, default: 'system' },
  title: { type: String, required: true },
  body: { type: String, required: true },
  read: { type: Boolean, default: false },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Number, required: true, index: true }
});

const auditLogSchema = new mongoose.Schema({
  logId: { type: String, required: true, unique: true },
  actorId: { type: String, required: true, index: true },
  actorRole: { type: String, required: true },
  action: { type: String, required: true, index: true },
  targetId: { type: String, default: '' },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Number, required: true, index: true }
});

const reportSchema = new mongoose.Schema({
  reportId: { type: String, required: true, unique: true },
  reporterId: { type: String, required: true, index: true },
  reportedUserId: { type: String, required: true, index: true },
  reason: { type: String, required: true },
  roomId: { type: String, default: '' },
  status: { type: String, enum: ['open', 'reviewed', 'resolved'], default: 'open' },
  createdAt: { type: Number, required: true }
});

const chatConsentSchema = new mongoose.Schema({
  consentKey: { type: String, required: true, unique: true }, // customerId:executiveId
  customerId: { type: String, required: true },
  executiveId: { type: String, required: true },
  accepted: { type: Boolean, default: false },
  updatedAt: { type: Number, required: true }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const PlatformSettings = mongoose.model('PlatformSettings', platformSettingsSchema);
const CoinPackage = mongoose.model('CoinPackage', coinPackageSchema);
const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);
const LedgerTransaction = mongoose.model('LedgerTransaction', ledgerTransactionSchema);
const CallSession = mongoose.model('CallSession', callSessionSchema);
const WithdrawalRequest = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
const BonusRule = mongoose.model('BonusRule', bonusRuleSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const AuditLog = mongoose.model('AuditLog', auditLogSchema);
const Report = mongoose.model('Report', reportSchema);
const ChatConsent = mongoose.model('ChatConsent', chatConsentSchema);

let dbConnected = false;

function hashInitialPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

async function seedDefaults() {
  await PlatformSettings.updateOne(
    { key: 'global' },
    { $setOnInsert: { key: 'global', platformName: 'Pazhi' } },
    { upsert: true }
  );

  const packageCount = await CoinPackage.countDocuments();
  if (packageCount === 0) {
    await CoinPackage.insertMany([
      {
        packageId: 'pkg-starter-99',
        name: 'Starter Pack',
        priceInr: 99,
        coins: 100,
        bonusCoins: 10,
        displayOrder: 1
      },
      {
        packageId: 'pkg-popular-299',
        name: 'Popular Pack',
        priceInr: 299,
        coins: 320,
        bonusCoins: 50,
        isPromotional: true,
        displayOrder: 2
      },
      {
        packageId: 'pkg-vip-999',
        name: 'VIP Pack',
        priceInr: 999,
        coins: 1200,
        bonusCoins: 250,
        isPromotional: true,
        displayOrder: 3
      }
    ]);
  }

  const adminExists = await User.exists({ role: 'admin' });
  if (!adminExists) {
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@pazhi.app').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@1234';
    await User.create({
      userId: crypto.randomUUID(),
      role: 'admin',
      name: 'Super Admin',
      username: 'superadmin',
      email: adminEmail,
      passwordHash: hashInitialPassword(adminPassword),
      avatar: '🛡️',
      ageConfirmed18Plus: true,
      termsAccepted: true,
      privacyAccepted: true,
      approvalStatus: 'approved',
      adminPermissions: ['all']
    });
    console.log(`  [db] Seeded default Super Admin (${adminEmail})`);
  }
}

async function connectDatabase() {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.warn('  [db] MONGODB_URI is not set.');
    return false;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000
    });
    dbConnected = true;
    console.log('  [db] Connected to MongoDB Atlas');
    await seedDefaults();
    return true;
  } catch (err) {
    dbConnected = false;
    console.error('  [db] MongoDB connection failed:', err.message);
    return false;
  }
}

function isDatabaseReady() {
  return dbConnected && mongoose.connection.readyState === 1;
}

module.exports = {
  connectDatabase,
  isDatabaseReady,
  User,
  Message,
  PlatformSettings,
  CoinPackage,
  PaymentOrder,
  LedgerTransaction,
  CallSession,
  WithdrawalRequest,
  BonusRule,
  Notification,
  AuditLog,
  Report,
  ChatConsent
};
