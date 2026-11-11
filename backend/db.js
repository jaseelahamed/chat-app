const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 32 },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 24 },
    passwordHash: { type: String, required: true },
    avatar: { type: String, default: '⚡', maxlength: 8 },
    color: { type: String, default: 'linear-gradient(135deg, #6366f1, #8b5cf6)', maxlength: 96 }
  },
  { timestamps: true }
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
    attachment: {
      name: String,
      type: String,
      size: Number,
      dataUrl: String
    },
    replyTo: {
      id: String,
      senderName: String,
      text: String
    },
    reactions: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Number, required: true, index: true }
  },
  { minimize: false }
);

messageSchema.index({ roomId: 1, createdAt: 1 });

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

let dbConnected = false;

async function connectDatabase() {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.warn('  [db] MONGODB_URI is not set. Account registration/login and persistent history require MongoDB Atlas.');
    return false;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000
    });
    dbConnected = true;
    console.log('  [db] Connected to MongoDB Atlas');
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
  Message
};

