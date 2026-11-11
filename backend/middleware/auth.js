const crypto = require('crypto');
const { isDatabaseReady, User } = require('../db');

const AUTH_SECRET =
  (process.env.AUTH_SECRET || '').trim() ||
  (process.env.AGORA_APP_CERTIFICATE || '').trim() ||
  'pulse-connect-auth-secret';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = String(storedHash || '').split(':');
  if (!salt || !expectedHex) return false;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function signAuthToken(payload) {
  const body = {
    ...payload,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed.userId || (parsed.exp && parsed.exp < Date.now())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function authenticateToken(token) {
  const claims = verifyAuthToken(token);
  if (!claims || !isDatabaseReady()) return null;

  const user = await User.findOne({ userId: claims.userId }, { passwordHash: 0 }).lean();
  if (!user) return null;
  if (user.accountStatus !== 'active') return null;
  if (typeof claims.tokenVersion === 'number' && user.tokenVersion !== claims.tokenVersion) {
    return null;
  }
  if (claims.sessionId && Array.isArray(user.sessions)) {
    const sess = user.sessions.find((s) => s.sessionId === claims.sessionId);
    if (sess && sess.revoked) return null;
  }
  return { user, claims };
}

async function requireAuth(req, res, next) {
  if (!isDatabaseReady()) {
    return res.status(503).json({ error: 'Database is not connected.' });
  }

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const auth = await authenticateToken(token);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized or session expired.' });
  }

  req.user = auth.user;
  req.authClaims = auth.claims;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role.' });
    }
    next();
  };
}

function requireApprovedExecutive(req, res, next) {
  if (!req.user || req.user.role !== 'executive') {
    return res.status(403).json({ error: 'Executive account required.' });
  }
  if (req.user.approvalStatus !== 'approved') {
    return res.status(403).json({ error: 'Executive account is pending Admin approval.' });
  }
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    const perms = req.user.adminPermissions || [];
    if (perms.includes('all') || perms.includes(permission)) {
      return next();
    }
    return res.status(403).json({ error: `Missing permission: ${permission}` });
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAuthToken,
  verifyAuthToken,
  authenticateToken,
  requireAuth,
  requireRole,
  requireApprovedExecutive,
  requirePermission
};

