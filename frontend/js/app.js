import { soundFX } from './sound.js';
import { WebRTCManager } from './webrtc.js';
import {
  showToast,
  initEmojiPopover,
  renderChannels,
  renderUsers,
  renderMessages
} from './ui.js';

const AVATAR_OPTIONS = ['⚡', '🚀', '🎧', '🦊', '🐼', '🌟', '💎', '🔥'];
const COLOR_OPTIONS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #06b6d4, #3b82f6)',
  'linear-gradient(135deg, #ec4899, #f43f5e)',
  'linear-gradient(135deg, #10b981, #14b8a6)',
  'linear-gradient(135deg, #f59e0b, #f97316)',
  'linear-gradient(135deg, #8b5cf6, #d946ef)'
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

const DEFAULT_BACKEND_PORT = '5000';

function isLocalHostname(hostname) {
  return (
    !hostname ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname)
  );
}

function resolveBackendOrigin() {
  const paramBackend = new URLSearchParams(window.location.search).get('backend');
  if (paramBackend) {
    return paramBackend.replace(/\/+$/, '');
  }
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const host = window.location.hostname || 'localhost';
  if (isLocalHostname(host)) {
    return `${proto}//${host}:${DEFAULT_BACKEND_PORT}`;
  }
  if (typeof window.PULSE_BACKEND_URL === 'string' && window.PULSE_BACKEND_URL.trim()) {
    return window.PULSE_BACKEND_URL.trim().replace(/\/+$/, '');
  }
  return `${proto}//${host}:${DEFAULT_BACKEND_PORT}`;
}

function hasConfiguredBackend() {
  const paramBackend = new URLSearchParams(window.location.search).get('backend');
  if (paramBackend) return true;
  if (typeof window.PULSE_BACKEND_URL === 'string' && window.PULSE_BACKEND_URL.trim()) {
    return true;
  }
  return isLocalHostname(window.location.hostname);
}

// Connects same-origin when served by the backend, or directly to the separate backend origin
async function connectSocket() {
  const backendOrigin = resolveBackendOrigin();
  const isFileOrigin = window.location.protocol === 'file:';
  const isSameAsBackend = !isFileOrigin && window.location.origin === backendOrigin;

  if (typeof window.io !== 'function') {
    if (isSameAsBackend) {
      await loadScript('/socket.io/socket.io.js');
    } else {
      await loadScript(`${backendOrigin}/socket.io/socket.io.js`);
    }
  }

  return isSameAsBackend ? window.io() : window.io(backendOrigin);
}

const backendOrigin = resolveBackendOrigin();
let socket = null;
try {
  socket = await connectSocket();
} catch (err) {
  console.error('Socket initialization failed:', err);
  showToast(`Backend server not reachable at ${backendOrigin}.`, 'error');
}

if (!hasConfiguredBackend()) {
  showToast(
    'Backend URL is not configured in config.js. Set BACKEND_URL in Netlify env vars and redeploy.',
    'error'
  );
}

const state = {
  me: null,
  channels: [],
  users: [],
  pricing: { chatCoinPerMessage: 10, audioCoinPerSecond: 1, videoCoinPerSecond: 2 },
  activeTarget: { type: 'channel', id: 'channel:general' },
  messagesByRoom: new Map(),
  unreadCounts: new Map(),
  typingUsersByRoom: new Map(),
  replyTo: null,
  pendingAttachment: null,
  searchFilter: '',
  categoryFilter: 'all',
  viewOnceNext: false
};

let selectedAvatar = AVATAR_OPTIONS[0];
let selectedColor = COLOR_OPTIONS[0];
let authMode = 'login'; // 'login' | 'register-customer' | 'register-executive' | 'profile'
let typingTimeout = null;
let isCurrentlyTyping = false;

const TOKEN_STORAGE_KEY = 'pulse_auth_token';

const dom = {
  authModal: document.getElementById('auth-modal'),
  authTabs: document.getElementById('auth-tabs'),
  tabLogin: document.getElementById('tab-login'),
  tabRegisterCustomer: document.getElementById('tab-register-customer'),
  tabRegisterExecutive: document.getElementById('tab-register-executive'),
  authForm: document.getElementById('auth-form'),
  authError: document.getElementById('auth-error'),
  btnCloseAuth: document.getElementById('btn-close-auth'),
  btnAuthSubmit: document.getElementById('btn-auth-submit'),
  fieldNameGroup: document.getElementById('field-name-group'),
  fieldUsernameGroup: document.getElementById('field-username-group'),
  fieldEmailGroup: document.getElementById('field-email-group'),
  fieldMobileGroup: document.getElementById('field-mobile-group'),
  fieldPasswordGroup: document.getElementById('field-password-group'),
  execRegisterFields: document.getElementById('exec-register-fields'),
  fieldBioGroup: document.getElementById('field-bio-group'),
  fieldAvatarGroup: document.getElementById('field-avatar-group'),
  fieldColorGroup: document.getElementById('field-color-group'),
  complianceChecks: document.getElementById('compliance-checks'),
  profileExtraActions: document.getElementById('profile-extra-actions'),
  authFooterLinks: document.getElementById('auth-footer-links'),
  displayNameInput: document.getElementById('display-name'),
  usernameInput: document.getElementById('auth-username'),
  emailInput: document.getElementById('auth-email'),
  mobileInput: document.getElementById('auth-mobile'),
  passwordInput: document.getElementById('auth-password'),
  execCategory: document.getElementById('exec-category'),
  execLanguages: document.getElementById('exec-languages'),
  execExperience: document.getElementById('exec-experience'),
  execUpi: document.getElementById('exec-upi'),
  profileBio: document.getElementById('profile-bio'),
  chkAge18: document.getElementById('chk-age18'),
  chkTerms: document.getElementById('chk-terms'),
  btnLogoutAll: document.getElementById('btn-logout-all'),
  btnDeactivateAccount: document.getElementById('btn-deactivate-account'),
  btnOpenForgot: document.getElementById('btn-open-forgot'),
  avatarPicker: document.getElementById('avatar-picker'),
  colorPicker: document.getElementById('color-picker'),
  appShell: document.getElementById('app-shell'),

  sidebar: document.getElementById('sidebar'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  btnOpenSidebar: document.getElementById('btn-open-sidebar'),
  btnCloseSidebar: document.getElementById('btn-close-sidebar'),
  sidebarSearch: document.getElementById('sidebar-search'),
  discoveryFilter: document.getElementById('discovery-filter'),

  customerWalletBar: document.getElementById('customer-wallet-bar'),
  sidebarCoinBalance: document.getElementById('sidebar-coin-balance'),
  btnOpenWallet: document.getElementById('btn-open-wallet'),

  execSidebarBar: document.getElementById('exec-sidebar-bar'),
  execAvailabilitySelect: document.getElementById('exec-availability-select'),
  btnOpenExecDash: document.getElementById('btn-open-exec-dash'),
  execApprovalBanner: document.getElementById('exec-approval-banner'),

  channelList: document.getElementById('channel-list'),
  userList: document.getElementById('user-list'),
  noPeersHint: document.getElementById('no-peers-hint'),
  onlineCount: document.getElementById('online-count'),

  meAvatar: document.getElementById('me-avatar'),
  meName: document.getElementById('me-name'),
  btnNotifications: document.getElementById('btn-notifications'),
  btnSoundToggle: document.getElementById('btn-sound-toggle'),
  iconSoundOn: document.getElementById('icon-sound-on'),
  iconSoundOff: document.getElementById('icon-sound-off'),
  btnEditProfile: document.getElementById('btn-edit-profile'),
  btnLogout: document.getElementById('btn-logout'),

  headerAvatar: document.getElementById('header-avatar'),
  headerTitle: document.getElementById('header-title'),
  headerSubtitle: document.getElementById('header-subtitle'),
  dmCallButtons: document.getElementById('dm-call-buttons'),
  btnVoiceCall: document.getElementById('btn-voice-call'),
  btnVideoCall: document.getElementById('btn-video-call'),
  btnBlockPeer: document.getElementById('btn-block-peer'),
  btnReportPeer: document.getElementById('btn-report-peer'),

  messagesContainer: document.getElementById('messages-container'),
  messagesList: document.getElementById('messages-list'),
  typingIndicator: document.getElementById('typing-indicator'),
  typingText: document.getElementById('typing-text'),
  composerPreview: document.getElementById('composer-preview'),

  emojiPopover: document.getElementById('emoji-popover'),
  btnEmoji: document.getElementById('btn-emoji'),
  fileInput: document.getElementById('file-input'),
  btnAttach: document.getElementById('btn-attach'),
  composerBar: document.getElementById('composer-bar'),
  voiceRecordingBar: document.getElementById('voice-recording-bar'),
  voiceRecTimer: document.getElementById('voice-rec-timer'),
  btnViewOnce: document.getElementById('btn-view-once'),
  btnVoiceNote: document.getElementById('btn-voice-note'),
  btnVoiceCancel: document.getElementById('btn-voice-cancel'),
  btnVoiceSend: document.getElementById('btn-voice-send'),
  messageInput: document.getElementById('message-input'),
  btnSend: document.getElementById('btn-send'),

  walletModal: document.getElementById('wallet-modal'),
  btnCloseWallet: document.getElementById('btn-close-wallet'),
  walletSummarySub: document.getElementById('wallet-summary-sub'),
  walletTabBuy: document.getElementById('wallet-tab-buy'),
  walletTabHistory: document.getElementById('wallet-tab-history'),
  walletBuyPane: document.getElementById('wallet-buy-pane'),
  walletHistoryPane: document.getElementById('wallet-history-pane'),
  walletPackagesGrid: document.getElementById('wallet-packages-grid'),
  walletHistoryList: document.getElementById('wallet-history-list'),

  execModal: document.getElementById('exec-modal'),
  btnCloseExec: document.getElementById('btn-close-exec'),
  execAvailSub: document.getElementById('exec-avail-sub'),
  execTabEarnings: document.getElementById('exec-tab-earnings'),
  execTabWithdraw: document.getElementById('exec-tab-withdraw'),
  execTabBonuses: document.getElementById('exec-tab-bonuses'),
  execEarningsPane: document.getElementById('exec-earnings-pane'),
  execWithdrawPane: document.getElementById('exec-withdraw-pane'),
  execBonusesPane: document.getElementById('exec-bonuses-pane'),
  execEarningsRange: document.getElementById('exec-earnings-range'),
  execEarningsGrid: document.getElementById('exec-earnings-grid'),
  chkSvcChat: document.getElementById('chk-svc-chat'),
  chkSvcAudio: document.getElementById('chk-svc-audio'),
  chkSvcVideo: document.getElementById('chk-svc-video'),
  execWithdrawForm: document.getElementById('exec-withdraw-form'),
  wdAmount: document.getElementById('wd-amount'),
  wdUpi: document.getElementById('wd-upi'),
  execWithdrawList: document.getElementById('exec-withdraw-list'),
  execBonusesList: document.getElementById('exec-bonuses-list'),

  notificationsModal: document.getElementById('notifications-modal'),
  btnCloseNotifications: document.getElementById('btn-close-notifications'),
  notificationsList: document.getElementById('notifications-list'),

  forgotModal: document.getElementById('forgot-modal'),
  btnCloseForgot: document.getElementById('btn-close-forgot'),
  forgotForm: document.getElementById('forgot-form'),
  forgotIdentifier: document.getElementById('forgot-identifier'),
  resetForm: document.getElementById('reset-form'),
  resetTokenInput: document.getElementById('reset-token-input'),
  resetNewPassword: document.getElementById('reset-new-password'),

  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightbox-img'),
  btnCloseLightbox: document.getElementById('btn-close-lightbox')
};

function getDmRoomId(userA, userB) {
  return `dm:${[userA, userB].sort().join(':')}`;
}

function getActiveRoomId() {
  if (!state.me) return state.activeTarget.id;
  if (state.activeTarget.type === 'channel') return state.activeTarget.id;
  return getDmRoomId(state.me.id, state.activeTarget.id);
}

const webrtc = new WebRTCManager({
  socket,
  backendOrigin: resolveBackendOrigin(),
  showToast,
  onCallStateChange: () => {
    refreshSidebar();
  },
  onOpenWallet: () => openWalletModal()
});

// ---------------- Account Auth & Profile ----------------
function showAuthError(message) {
  if (!message) {
    dom.authError.textContent = '';
    dom.authError.classList.add('hidden');
    return;
  }
  dom.authError.textContent = message;
  dom.authError.classList.remove('hidden');
}

function setAuthMode(mode) {
  authMode = mode;
  showAuthError('');

  const isLogin = mode === 'login';
  const isCustReg = mode === 'register-customer';
  const isExecReg = mode === 'register-executive';
  const isRegister = isCustReg || isExecReg;
  const isProfile = mode === 'profile';

  dom.authTabs.classList.toggle('hidden', isProfile);
  dom.tabLogin.classList.toggle('active', isLogin);
  dom.tabRegisterCustomer.classList.toggle('active', isCustReg);
  dom.tabRegisterExecutive.classList.toggle('active', isExecReg);

  dom.fieldNameGroup.classList.toggle('hidden', isLogin);
  dom.fieldUsernameGroup.classList.toggle('hidden', !isLogin);
  dom.fieldEmailGroup.classList.toggle('hidden', isLogin);
  dom.fieldMobileGroup.classList.toggle('hidden', isLogin);
  dom.fieldPasswordGroup.classList.toggle('hidden', isProfile);
  dom.execRegisterFields.classList.toggle('hidden', !isExecReg);
  dom.fieldBioGroup.classList.toggle('hidden', !isProfile);
  dom.fieldAvatarGroup.classList.toggle('hidden', isLogin);
  dom.fieldColorGroup.classList.toggle('hidden', isLogin);
  dom.complianceChecks.classList.toggle('hidden', !isRegister);
  dom.profileExtraActions.classList.toggle('hidden', !isProfile);
  dom.authFooterLinks.classList.toggle('hidden', isProfile);

  dom.displayNameInput.required = isRegister || isProfile;
  dom.usernameInput.required = isLogin;
  dom.emailInput.required = isRegister;
  dom.mobileInput.required = isRegister;
  dom.passwordInput.required = isLogin || isRegister;
  dom.passwordInput.autocomplete = isRegister ? 'new-password' : 'current-password';

  dom.btnCloseAuth.classList.toggle('hidden', !isProfile);
  const label = isLogin
    ? 'Log In'
    : isCustReg
    ? 'Create Customer Account'
    : isExecReg
    ? 'Submit Executive Application'
    : 'Save Profile';
  dom.btnAuthSubmit.querySelector('span').textContent = label;
}

function initProfilePickers() {
  dom.avatarPicker.innerHTML = '';
  AVATAR_OPTIONS.forEach((av) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pick-chip${av === selectedAvatar ? ' selected' : ''}`;
    btn.textContent = av;
    btn.addEventListener('click', () => {
      selectedAvatar = av;
      initProfilePickers();
    });
    dom.avatarPicker.appendChild(btn);
  });

  dom.colorPicker.innerHTML = '';
  COLOR_OPTIONS.forEach((col) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `color-swatch${col === selectedColor ? ' selected' : ''}`;
    btn.style.background = col;
    btn.addEventListener('click', () => {
      selectedColor = col;
      initProfilePickers();
    });
    dom.colorPicker.appendChild(btn);
  });
}

function getStoredToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

function saveStoredToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function joinWithToken(token) {
  if (!token) return;
  if (!socket) {
    showAuthError(`Cannot connect: backend unavailable at ${backendOrigin}.`);
    return;
  }
  if (!socket.connected) {
    showToast(`Connecting to ${backendOrigin}... (free Render servers take ~30s to wake up)`, 'info');
    return;
  }
  socket.emit('user:join', { token });
}

function logoutAccount() {
  saveStoredToken('');
  state.me = null;
  state.users = [];
  state.messagesByRoom.clear();
  state.unreadCounts.clear();
  state.typingUsersByRoom.clear();
  state.activeTarget = { type: 'channel', id: 'channel:general' };

  dom.appShell.classList.add('hidden');
  dom.authModal.classList.remove('hidden');
  dom.passwordInput.value = '';
  setAuthMode('login');
}

initProfilePickers();
setAuthMode('login');

dom.tabLogin.addEventListener('click', () => setAuthMode('login'));
dom.tabRegisterCustomer.addEventListener('click', () => setAuthMode('register-customer'));
dom.tabRegisterExecutive.addEventListener('click', () => setAuthMode('register-executive'));

async function apiRequest(path, options = {}) {
  const token = getStoredToken();
  const res = await fetch(`${backendOrigin}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

dom.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError('');
  soundFX.ensureContext();

  const submitLabelEl = dom.btnAuthSubmit.querySelector('span');
  const originalLabel = submitLabelEl.textContent;
  dom.btnAuthSubmit.disabled = true;
  submitLabelEl.textContent = 'Please wait...';

  try {
    if (authMode === 'profile') {
      const data = await apiRequest('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name: dom.displayNameInput.value.trim(),
          email: dom.emailInput.value.trim(),
          mobile: dom.mobileInput.value.trim(),
          bio: dom.profileBio.value.trim(),
          avatar: selectedAvatar,
          color: selectedColor
        })
      });
      state.me = { ...state.me, ...data.user };
      dom.meAvatar.textContent = state.me.avatar;
      dom.meAvatar.style.background = state.me.color;
      dom.meName.textContent = state.me.name;
      dom.authModal.classList.add('hidden');
      showToast('Profile updated.', 'success');
      return;
    }

    if (authMode === 'register-customer' || authMode === 'register-executive') {
      if (authMode === 'register-customer' && !dom.chkAge18.checked) {
        throw new Error('Please confirm you are 18 years or older.');
      }
      if (!dom.chkTerms.checked) {
        throw new Error('Please accept the Terms & Conditions and Privacy Policy.');
      }
    }

    let endpoint = '/auth/login';
    let body = {
      identifier: dom.usernameInput.value.trim(),
      password: dom.passwordInput.value
    };

    if (authMode === 'register-customer') {
      endpoint = '/auth/customer/register';
      body = {
        name: dom.displayNameInput.value.trim(),
        email: dom.emailInput.value.trim(),
        mobile: dom.mobileInput.value.trim(),
        password: dom.passwordInput.value,
        avatar: selectedAvatar,
        color: selectedColor,
        ageConfirmed18Plus: dom.chkAge18.checked,
        termsAccepted: dom.chkTerms.checked,
        privacyAccepted: dom.chkTerms.checked
      };
    } else if (authMode === 'register-executive') {
      endpoint = '/auth/executive/register';
      body = {
        name: dom.displayNameInput.value.trim(),
        email: dom.emailInput.value.trim(),
        mobile: dom.mobileInput.value.trim(),
        password: dom.passwordInput.value,
        avatar: selectedAvatar,
        color: selectedColor,
        category: dom.execCategory.value,
        languages: dom.execLanguages.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        experience: dom.execExperience.value.trim(),
        bio: dom.execExperience.value.trim(),
        payoutDetails: { upiId: dom.execUpi.value.trim() },
        termsAccepted: dom.chkTerms.checked
      };
    }

    const res = await fetch(`${backendOrigin}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Authentication failed.');
    }

    if (data.pendingApproval || !data.token) {
      dom.passwordInput.value = '';
      setAuthMode('login');
      showAuthError(data.message || 'Registration submitted! You can log in after Admin approves your account.');
      showToast(data.message || 'Pending Admin approval.', 'info');
      return;
    }

    if (data.message) showToast(data.message, 'info');
    saveStoredToken(data.token);
    dom.passwordInput.value = '';
    joinWithToken(data.token);
  } catch (err) {
    showAuthError(err.message || 'Could not reach server. Try again in a moment.');
  } finally {
    dom.btnAuthSubmit.disabled = false;
    if (dom.btnAuthSubmit.querySelector('span').textContent === 'Please wait...') {
      submitLabelEl.textContent = originalLabel;
    }
  }
});

dom.btnEditProfile.addEventListener('click', () => {
  if (!state.me) return;
  selectedAvatar = state.me.avatar || selectedAvatar;
  selectedColor = state.me.color || selectedColor;
  initProfilePickers();
  dom.displayNameInput.value = state.me.name || '';
  dom.emailInput.value = state.me.email || '';
  dom.mobileInput.value = state.me.mobile || '';
  dom.profileBio.value = state.me.bio || '';
  setAuthMode('profile');
  dom.authModal.classList.remove('hidden');
});

dom.btnLogoutAll.addEventListener('click', async () => {
  try {
    await apiRequest('/auth/logout-all', { method: 'POST' });
    showToast('Logged out from all devices.', 'info');
    logoutAccount();
  } catch (err) {
    showToast(err.message, true);
  }
});

dom.btnDeactivateAccount.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to deactivate your account?')) return;
  try {
    await apiRequest('/auth/deactivate', { method: 'POST', body: JSON.stringify({ mode: 'deactivate' }) });
    showToast('Account deactivated.', 'info');
    logoutAccount();
  } catch (err) {
    showToast(err.message, true);
  }
});

dom.btnOpenForgot.addEventListener('click', () => {
  dom.forgotModal.classList.remove('hidden');
});
dom.btnCloseForgot.addEventListener('click', () => {
  dom.forgotModal.classList.add('hidden');
});

dom.forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ identifier: dom.forgotIdentifier.value.trim() })
    });
    showToast(data.message, 'info');
    if (data.resetToken) {
      dom.resetTokenInput.value = data.resetToken;
      dom.resetForm.classList.remove('hidden');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

dom.resetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await apiRequest('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        resetToken: dom.resetTokenInput.value.trim(),
        newPassword: dom.resetNewPassword.value
      })
    });
    showToast(data.message, 'success');
    dom.forgotModal.classList.add('hidden');
    dom.resetForm.classList.add('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

dom.btnCloseAuth.addEventListener('click', () => {
  if (state.me) {
    dom.authModal.classList.add('hidden');
  }
});

dom.btnLogout.addEventListener('click', () => {
  logoutAccount();
  if (socket && socket.connected) {
    socket.disconnect().connect();
  }
});

let hasShownConnectError = false;
if (socket) {
  socket.on('connect', () => {
    hasShownConnectError = false;
    const token = getStoredToken();
    if (token) {
      socket.emit('user:join', { token });
    }
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connect_error:', err);
    if (!hasShownConnectError) {
      hasShownConnectError = true;
      showToast(`Unable to reach backend at ${backendOrigin}.`, 'error');
    }
  });

  socket.on('disconnect', () => {
    if (state.me) {
      showToast('Connection lost — attempting to reconnect...', 'error');
    }
  });

  if (socket.connected && getStoredToken()) {
    socket.emit('user:join', { token: getStoredToken() });
  }
}

// ---------------- Socket Events ----------------
socket.on('session:error', ({ message }) => {
  saveStoredToken('');
  state.me = null;
  dom.appShell.classList.add('hidden');
  dom.authModal.classList.remove('hidden');
  setAuthMode('login');
  showAuthError(message || 'Session expired. Please log in again.');
});

function updateRoleUI() {
  if (!state.me) return;
  const isCust = state.me.role === 'customer';
  const isExec = state.me.role === 'executive';
  dom.customerWalletBar.classList.toggle('hidden', !isCust);
  dom.execSidebarBar.classList.toggle('hidden', !isExec);

  if (isCust) {
    dom.sidebarCoinBalance.textContent = `🪙 ${state.me.coinBalance || 0} Coins`;
  }
  if (isExec) {
    const pending = state.me.approvalStatus !== 'approved';
    dom.execApprovalBanner.classList.toggle('hidden', !pending);
    if (pending) {
      dom.execApprovalBanner.textContent = `Status: ${state.me.approvalStatus} (Admin approval required)`;
    }
  }
}

socket.on('session:ready', ({ user, channels, users, history, pricing }) => {
  state.me = user;
  state.channels = channels;
  state.users = users;
  if (pricing) state.pricing = pricing;
  state.messagesByRoom.clear();

  Object.entries(history).forEach(([roomId, msgs]) => {
    state.messagesByRoom.set(roomId, msgs);
  });

  dom.meAvatar.textContent = user.avatar;
  dom.meAvatar.style.background = user.color;
  dom.meName.textContent = user.name;

  updateRoleUI();
  dom.authModal.classList.add('hidden');
  dom.appShell.classList.remove('hidden');

  refreshAllViews();
});

socket.on('wallet:update', ({ coinBalance, totalCoinsPurchased }) => {
  if (!state.me) return;
  state.me.coinBalance = coinBalance;
  if (typeof totalCoinsPurchased === 'number') {
    state.me.totalCoinsPurchased = totalCoinsPurchased;
  }
  updateRoleUI();
  refreshSidebar();
});

socket.on('message:error', ({ error, code }) => {
  showToast(error || 'Message could not be sent.', 'error');
  if (code === 'insufficient_balance' && state.me?.role === 'customer') {
    openWalletModal();
  }
});

socket.on('chat:consent-request', ({ executive }) => {
  if (!executive) return;
  const accept = confirm(`${executive.name} wants to start a paid chat with you. Allow?`);
  socket.emit('chat:consent', { executiveId: executive.id, accepted: accept });
});

socket.on('notification:new', ({ title, body }) => {
  showToast(`${title}: ${body}`, 'info');
});

socket.on('presence:update', (users) => {
  state.users = users;
  refreshSidebar();
  refreshHeader();
});

socket.on('dm:history', ({ roomId, messages }) => {
  state.messagesByRoom.set(roomId, messages);
  if (getActiveRoomId() === roomId) {
    refreshMessages();
  }
});

socket.on('message:new', (msg) => {
  const roomId = msg.roomId;
  if (!state.messagesByRoom.has(roomId)) {
    state.messagesByRoom.set(roomId, []);
  }
  state.messagesByRoom.get(roomId).push(msg);

  const isCurrentRoom = getActiveRoomId() === roomId;
  if (isCurrentRoom) {
    refreshMessages();
  } else {
    state.unreadCounts.set(roomId, (state.unreadCounts.get(roomId) || 0) + 1);
    refreshSidebar();
  }

  if (state.me && msg.senderId !== state.me.id) {
    soundFX.playMessageChime();
  }
});

socket.on('message:reacted', ({ roomId, messageId, reactions }) => {
  const list = state.messagesByRoom.get(roomId);
  if (!list) return;
  const target = list.find((m) => m.id === messageId);
  if (target) {
    target.reactions = reactions;
    if (getActiveRoomId() === roomId) {
      refreshMessages();
    }
  }
});

socket.on('message:deleted', ({ roomId, messageId }) => {
  const list = state.messagesByRoom.get(roomId);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx !== -1) {
    list.splice(idx, 1);
    if (getActiveRoomId() === roomId) {
      refreshMessages();
    }
  }
});

socket.on('typing:state', ({ roomId, userId, userName, isTyping }) => {
  if (!state.typingUsersByRoom.has(roomId)) {
    state.typingUsersByRoom.set(roomId, new Map());
  }
  const map = state.typingUsersByRoom.get(roomId);
  if (isTyping) {
    map.set(userId, userName);
  } else {
    map.delete(userId);
  }
  if (getActiveRoomId() === roomId) {
    refreshTypingIndicator();
  }
});

// ---------------- Rendering & Navigation ----------------
function selectChannel(ch) {
  stopTypingSignal();
  state.activeTarget = { type: 'channel', id: ch.id };
  state.unreadCounts.delete(ch.id);
  closeMobileSidebar();
  refreshAllViews();
}

function selectDmPeer(peer) {
  stopTypingSignal();
  state.activeTarget = { type: 'dm', id: peer.id };
  const roomId = getDmRoomId(state.me.id, peer.id);
  state.unreadCounts.delete(roomId);

  if (!state.messagesByRoom.has(roomId)) {
    socket.emit('dm:history', { peerId: peer.id });
  }

  closeMobileSidebar();
  refreshAllViews();
}

function startCallWithPeer(peer, callType) {
  if (!peer) return;
  webrtc.startCall(peer, callType);
}

function refreshAllViews() {
  refreshSidebar();
  refreshHeader();
  refreshMessages();
  refreshTypingIndicator();
}

function refreshSidebar() {
  if (!state.me) return;

  renderChannels({
    listEl: dom.channelList,
    channels: state.channels,
    activeTarget: state.activeTarget,
    unreadCounts: state.unreadCounts,
    filter: state.searchFilter,
    onSelect: selectChannel
  });

  renderUsers({
    listEl: dom.userList,
    emptyHintEl: dom.noPeersHint,
    countEl: dom.onlineCount,
    users: state.users,
    meId: state.me.id,
    activeTarget: state.activeTarget,
    unreadCounts: state.unreadCounts,
    getDmRoomId,
    filter: state.searchFilter,
    categoryFilter: state.categoryFilter,
    onSelectUser: selectDmPeer,
    onCallUser: startCallWithPeer
  });

  if (
    state.me.role === 'customer' &&
    (state.me.totalCoinsPurchased || 0) <= 0 &&
    (state.me.coinBalance || 0) <= 0
  ) {
    dom.noPeersHint.classList.remove('hidden');
    dom.noPeersHint.innerHTML =
      '<p>🔒 Executives Locked</p><span>Purchase a coin package in <strong>Wallet &amp; Top Up</strong> above to view and connect with executives.</span>';
  }
}

function refreshHeader() {
  if (state.activeTarget.type === 'channel') {
    const ch = state.channels.find((c) => c.id === state.activeTarget.id);
    dom.headerAvatar.textContent = '#';
    dom.headerAvatar.style.background = 'rgba(99, 102, 241, 0.18)';
    dom.headerTitle.textContent = ch ? ch.name : 'Channel';
    dom.headerSubtitle.textContent = ch ? ch.topic : '';
    dom.dmCallButtons.classList.add('hidden');
  } else {
    const peer = state.users.find((u) => u.id === state.activeTarget.id);
    if (peer) {
      dom.headerAvatar.textContent = peer.avatar;
      dom.headerAvatar.style.background = peer.color;
      dom.headerTitle.textContent = peer.name;
      const isPaidPair =
        state.me &&
        ((state.me.role === 'customer' && peer.role === 'executive') ||
          (state.me.role === 'executive' && peer.role === 'customer'));
      const rateInfo = isPaidPair
        ? ` · 💬${state.pricing.chatCoinPerMessage}c/msg · 📞${state.pricing.audioCoinPerSecond}c/s · 📹${state.pricing.videoCoinPerSecond}c/s`
        : '';
      const catTag = peer.role === 'executive' && peer.category ? `${peer.category} · ` : '';
      dom.headerSubtitle.textContent =
        peer.status === 'in-call'
          ? `${catTag}In a call${rateInfo}`
          : peer.status === 'online'
          ? `${catTag}Online${rateInfo}`
          : `${catTag}Offline${rateInfo}`;
      dom.dmCallButtons.classList.remove('hidden');
    } else {
      dom.headerAvatar.textContent = '?';
      dom.headerAvatar.style.background = '#334155';
      dom.headerTitle.textContent = 'Offline User';
      dom.headerSubtitle.textContent = 'This user disconnected';
      dom.dmCallButtons.classList.add('hidden');
    }
  }
}

function refreshMessages() {
  if (!state.me) return;
  const roomId = getActiveRoomId();
  const messages = state.messagesByRoom.get(roomId) || [];

  let emptyTitle = 'Start the conversation';
  let emptySubtitle = 'Messages sent here appear instantaneously for everyone in the room.';
  if (state.activeTarget.type === 'dm') {
    const peer = state.users.find((u) => u.id === state.activeTarget.id);
    emptyTitle = peer ? `Say hello to ${peer.name}` : 'Direct Message';
    emptySubtitle = 'Send a real-time message, share a photo, or start a voice/video call above.';
  }

  renderMessages({
    listEl: dom.messagesList,
    containerEl: dom.messagesContainer,
    messages,
    meId: state.me.id,
    emptyTitle,
    emptySubtitle,
    onReply: (msg) => {
      const attachFallback = msg.attachment
        ? String(msg.attachment.type || '').startsWith('audio/')
          ? '🎤 Voice message'
          : String(msg.attachment.type || '').startsWith('image/')
          ? '📷 Photo'
          : msg.attachment.name || 'Attachment'
        : '';
      state.replyTo = {
        id: msg.id,
        senderName: msg.senderId === state.me.id ? 'You' : msg.senderName,
        text: msg.text || attachFallback
      };
      renderComposerPreview();
      dom.messageInput.focus();
    },
    onReact: (messageId, emoji) => {
      socket.emit('message:react', {
        roomId,
        messageId,
        emoji,
        targetType: state.activeTarget.type,
        targetId: state.activeTarget.id
      });
    },
    onDelete: (messageId) => {
      socket.emit('message:delete', {
        roomId,
        messageId,
        targetType: state.activeTarget.type,
        targetId: state.activeTarget.id
      });
    },
    onOpenLightbox: (src) => {
      dom.lightboxImg.src = src;
      dom.lightbox.classList.remove('hidden');
    },
    onViewOnce: (msg) => {
      socket.emit('message:view-once', { roomId, messageId: msg.id });
    }
  });

  if (state.activeTarget.type === 'dm') {
    socket.emit('message:read', { roomId, targetId: state.activeTarget.id });
  }
}

function refreshTypingIndicator() {
  const roomId = getActiveRoomId();
  const map = state.typingUsersByRoom.get(roomId);
  const names = map ? Array.from(map.values()) : [];

  if (names.length === 0) {
    dom.typingIndicator.classList.add('hidden');
  } else {
    dom.typingText.textContent =
      names.length === 1
        ? `${names[0]} is typing...`
        : `${names.slice(0, 2).join(', ')} are typing...`;
    dom.typingIndicator.classList.remove('hidden');
  }
}

// ---------------- Composer & Attachments ----------------
function renderComposerPreview() {
  if (!state.replyTo && !state.pendingAttachment) {
    dom.composerPreview.classList.add('hidden');
    dom.composerPreview.innerHTML = '';
    return;
  }

  dom.composerPreview.classList.remove('hidden');
  dom.composerPreview.innerHTML = `
    <div class="preview-info"></div>
    <button type="button" class="icon-btn" aria-label="Clear">&times;</button>
  `;

  const info = dom.composerPreview.querySelector('.preview-info');
  if (state.replyTo) {
    info.textContent = `Replying to ${state.replyTo.senderName}: "${state.replyTo.text}"`;
  } else if (state.pendingAttachment) {
    info.textContent = `Attached: ${state.pendingAttachment.name}`;
  }

  dom.composerPreview.querySelector('button').addEventListener('click', () => {
    state.replyTo = null;
    state.pendingAttachment = null;
    renderComposerPreview();
  });
}

function sendMessage() {
  const text = dom.messageInput.value.trim();
  if (!text && !state.pendingAttachment) return;

  socket.emit('message:send', {
    targetType: state.activeTarget.type,
    targetId: state.activeTarget.id,
    text,
    attachment: state.pendingAttachment,
    replyTo: state.replyTo,
    viewOnce: state.viewOnceNext
  });

  dom.messageInput.value = '';
  dom.messageInput.style.height = 'auto';
  state.replyTo = null;
  state.pendingAttachment = null;
  state.viewOnceNext = false;
  dom.btnViewOnce?.classList.remove('active');
  renderComposerPreview();
  stopTypingSignal();
}

function stopTypingSignal() {
  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    socket.emit('typing:state', {
      targetType: state.activeTarget.type,
      targetId: state.activeTarget.id,
      isTyping: false
    });
  }
}

dom.messageInput.addEventListener('input', () => {
  dom.messageInput.style.height = 'auto';
  dom.messageInput.style.height = `${Math.min(dom.messageInput.scrollHeight, 130)}px`;

  if (!isCurrentlyTyping && dom.messageInput.value.trim()) {
    isCurrentlyTyping = true;
    socket.emit('typing:state', {
      targetType: state.activeTarget.type,
      targetId: state.activeTarget.id,
      isTyping: true
    });
  }

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    stopTypingSignal();
  }, 1600);
});

dom.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

dom.btnSend.addEventListener('click', sendMessage);

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const maxDim = 1600;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      resolve({
        name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
        type: 'image/jpeg',
        size: Math.round((dataUrl.length * 3) / 4),
        dataUrl
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not process image.'));
    };
    img.src = objectUrl;
  });
}

// Attachments
dom.btnAttach.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', async () => {
  const file = dom.fileInput.files?.[0];
  dom.fileInput.value = '';
  if (!file) return;

  if (file.type && file.type.startsWith('image/') && file.size > 2 * 1024 * 1024) {
    try {
      const compressed = await compressImageFile(file);
      if (compressed.dataUrl.length > 4.2 * 1024 * 1024) {
        showToast('Photo is still too large after compression. Try a smaller image.', 'error');
        return;
      }
      state.pendingAttachment = compressed;
      state.replyTo = null;
      renderComposerPreview();
    } catch (err) {
      showToast(err.message || 'Could not attach photo.', 'error');
    }
    return;
  }

  if (file.size > 3 * 1024 * 1024) {
    showToast('Please select a file smaller than 3 MB.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    state.pendingAttachment = {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: reader.result
    };
    state.replyTo = null;
    renderComposerPreview();
  };
  reader.readAsDataURL(file);
});

// Voice Messages
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceTimerInterval = null;
let voiceStartedAt = 0;
let shouldSendVoice = false;

function resetVoiceRecorderUI() {
  if (voiceTimerInterval) {
    clearInterval(voiceTimerInterval);
    voiceTimerInterval = null;
  }
  if (voiceStream) {
    voiceStream.getTracks().forEach((t) => t.stop());
    voiceStream = null;
  }
  voiceRecorder = null;
  voiceChunks = [];
  dom.voiceRecTimer.textContent = '00:00';
  dom.voiceRecordingBar.classList.add('hidden');
  dom.composerBar.classList.remove('hidden');
}

dom.btnVoiceNote.addEventListener('click', async () => {
  if (voiceRecorder) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== 'function') {
    showToast('Voice recording is not supported in this browser.', 'error');
    return;
  }

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeCandidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    voiceRecorder = mimeType
      ? new MediaRecorder(voiceStream, { mimeType })
      : new MediaRecorder(voiceStream);
    voiceChunks = [];
    shouldSendVoice = false;

    voiceRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        voiceChunks.push(e.data);
      }
    };

    voiceRecorder.onstop = () => {
      const sendNow = shouldSendVoice;
      const recordedType = voiceRecorder?.mimeType || mimeType || 'audio/webm';
      const chunks = [...voiceChunks];
      resetVoiceRecorderUI();

      if (!sendNow || chunks.length === 0) return;

      const blob = new Blob(chunks, { type: recordedType });
      if (blob.size > 3 * 1024 * 1024) {
        showToast('Voice message is too long (max ~3 MB).', 'error');
        return;
      }

      const ext = recordedType.includes('mp4') ? 'm4a' : recordedType.includes('ogg') ? 'ogg' : 'webm';
      const reader = new FileReader();
      reader.onload = () => {
        socket.emit('message:send', {
          targetType: state.activeTarget.type,
          targetId: state.activeTarget.id,
          text: '',
          attachment: {
            name: `voice-message.${ext}`,
            type: recordedType.split(';')[0],
            size: blob.size,
            dataUrl: reader.result
          },
          replyTo: state.replyTo
        });
        state.replyTo = null;
        renderComposerPreview();
      };
      reader.readAsDataURL(blob);
    };

    voiceRecorder.start(250);
    voiceStartedAt = Date.now();
    dom.composerBar.classList.add('hidden');
    dom.voiceRecordingBar.classList.remove('hidden');

    voiceTimerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - voiceStartedAt) / 1000);
      const mins = String(Math.floor(sec / 60)).padStart(2, '0');
      const rem = String(sec % 60).padStart(2, '0');
      dom.voiceRecTimer.textContent = `${mins}:${rem}`;
      if (sec >= 120 && voiceRecorder && voiceRecorder.state === 'recording') {
        shouldSendVoice = true;
        voiceRecorder.stop();
      }
    }, 500);
  } catch (err) {
    console.error('Voice note error:', err);
    resetVoiceRecorderUI();
    showToast('Please allow microphone access to send voice messages.', 'error');
  }
});

dom.btnVoiceCancel.addEventListener('click', () => {
  shouldSendVoice = false;
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.stop();
  } else {
    resetVoiceRecorderUI();
  }
});

dom.btnVoiceSend.addEventListener('click', () => {
  shouldSendVoice = true;
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    voiceRecorder.stop();
  }
});

// Emoji Popover
initEmojiPopover(dom.emojiPopover, (emoji) => {
  dom.messageInput.value += emoji;
  dom.emojiPopover.classList.add('hidden');
  dom.messageInput.focus();
});

dom.btnEmoji.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.emojiPopover.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!dom.emojiPopover.contains(e.target) && e.target !== dom.btnEmoji) {
    dom.emojiPopover.classList.add('hidden');
  }
});

// Header Call Buttons
dom.btnVoiceCall.addEventListener('click', () => {
  if (state.activeTarget.type !== 'dm') return;
  const peer = state.users.find((u) => u.id === state.activeTarget.id);
  startCallWithPeer(peer, 'audio');
});

dom.btnVideoCall.addEventListener('click', () => {
  if (state.activeTarget.type !== 'dm') return;
  const peer = state.users.find((u) => u.id === state.activeTarget.id);
  startCallWithPeer(peer, 'video');
});

// Sound Toggle
dom.btnSoundToggle.addEventListener('click', () => {
  soundFX.enabled = !soundFX.enabled;
  dom.iconSoundOn.classList.toggle('hidden', !soundFX.enabled);
  dom.iconSoundOff.classList.toggle('hidden', soundFX.enabled);
  showToast(soundFX.enabled ? 'Sounds enabled.' : 'Sounds muted.', 'info');
});

// Search & Category Filter
dom.sidebarSearch.addEventListener('input', (e) => {
  state.searchFilter = e.target.value;
  refreshSidebar();
});

dom.discoveryFilter?.addEventListener('change', (e) => {
  state.categoryFilter = e.target.value;
  refreshSidebar();
});

// View Once Toggle
dom.btnViewOnce?.addEventListener('click', () => {
  state.viewOnceNext = !state.viewOnceNext;
  dom.btnViewOnce.classList.toggle('active', state.viewOnceNext);
  showToast(
    state.viewOnceNext ? 'Next message will be View Once.' : 'View Once disabled.',
    'info'
  );
});

// Block & Report Peer
dom.btnBlockPeer?.addEventListener('click', async () => {
  if (state.activeTarget.type !== 'dm') return;
  const peer = state.users.find((u) => u.id === state.activeTarget.id);
  if (!peer) return;
  const unblock = !confirm(`Block ${peer.name}? (Click Cancel to Unblock instead)`);
  try {
    const res = await apiRequest('/auth/block', {
      method: 'POST',
      body: JSON.stringify({ userId: peer.id, unblock })
    });
    showToast(res.message, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

dom.btnReportPeer?.addEventListener('click', async () => {
  if (state.activeTarget.type !== 'dm') return;
  const reason = prompt('Reason for reporting this user:');
  if (!reason) return;
  try {
    await apiRequest('/auth/report', {
      method: 'POST',
      body: JSON.stringify({
        userId: state.activeTarget.id,
        reason,
        roomId: getActiveRoomId()
      })
    });
    showToast('Report submitted to Admin.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------------- Customer Coin Wallet & Recharge ----------------
async function openWalletModal(initialTab = 'buy') {
  if (!state.me || state.me.role !== 'customer') return;
  dom.walletModal.classList.remove('hidden');
  dom.walletSummarySub.textContent = `Available: ${state.me.coinBalance || 0} Coins (Bonus: ${state.me.bonusCoinBalance || 0})`;
  switchWalletTab(initialTab);
  await loadWalletPackages();
  if (initialTab === 'history') await loadWalletHistory();
}

function switchWalletTab(tab) {
  const isBuy = tab === 'buy';
  dom.walletTabBuy.classList.toggle('active', isBuy);
  dom.walletTabHistory.classList.toggle('active', !isBuy);
  dom.walletBuyPane.classList.toggle('hidden', !isBuy);
  dom.walletHistoryPane.classList.toggle('hidden', isBuy);
}

async function loadWalletPackages() {
  try {
    const { packages, paymentMode } = await apiRequest('/wallet/packages');
    dom.walletPackagesGrid.innerHTML = '';
    packages.forEach((pkg) => {
      const card = document.createElement('div');
      card.className = 'pkg-card';
      card.innerHTML = `
        <div class="pkg-name"></div>
        <div class="pkg-coins"></div>
        <div class="pkg-bonus"></div>
        <button type="button" class="btn-chip" style="margin-top:6px;">Buy for ₹${pkg.priceInr}</button>
      `;
      card.querySelector('.pkg-name').textContent = pkg.name;
      card.querySelector('.pkg-coins').textContent = `🪙 ${pkg.coins} Coins`;
      card.querySelector('.pkg-bonus').textContent = pkg.bonusCoins ? `+ ${pkg.bonusCoins} Bonus Coins` : 'Standard Pack';
      card.querySelector('button').addEventListener('click', () => purchasePackage(pkg, paymentMode));
      dom.walletPackagesGrid.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function applyVerifiedPurchase(verified) {
  state.me.coinBalance = verified.coinBalance;
  state.me.bonusCoinBalance = verified.bonusCoinBalance;
  state.me.totalCoinsPurchased = (state.me.totalCoinsPurchased || 0) + (verified.order?.coins || 1);
  updateRoleUI();
  refreshSidebar();
  dom.walletSummarySub.textContent = `Available: ${verified.coinBalance} Coins (Bonus: ${verified.bonusCoinBalance})`;
}

async function purchasePackage(pkg, paymentMode) {
  try {
    const data = await apiRequest('/wallet/recharge/create-order', {
      method: 'POST',
      body: JSON.stringify({ packageId: pkg.packageId, provider: paymentMode === 'razorpay' ? 'razorpay' : 'sandbox' })
    });

    if (data.mode === 'razorpay' && window.Razorpay) {
      const rzp = new window.Razorpay({
        key: data.keyId,
        amount: Math.round(pkg.priceInr * 100),
        currency: 'INR',
        name: 'Pazhi',
        description: `${pkg.name} (${pkg.coins} + ${pkg.bonusCoins} bonus coins)`,
        order_id: data.order.gatewayOrderId,
        prefill: {
          name: state.me?.name || '',
          email: state.me?.email || '',
          contact: state.me?.mobile || ''
        },
        handler: async (resp) => {
          const verified = await apiRequest('/wallet/recharge/verify', {
            method: 'POST',
            body: JSON.stringify({
              orderId: data.order.orderId,
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature
            })
          });
          applyVerifiedPurchase(verified);
          showToast('Coins credited successfully!', 'success');
        }
      });
      rzp.open();
      return;
    }

    const ok = confirm(
      `Sandbox / UPI Test Checkout:\nPay ₹${pkg.priceInr} for ${pkg.coins} + ${pkg.bonusCoins} bonus coins?\n\nOK = Success, Cancel = Simulate Cancelled`
    );
    const verified = await apiRequest('/wallet/recharge/verify', {
      method: 'POST',
      body: JSON.stringify({
        orderId: data.order.orderId,
        simulateStatus: ok ? '' : 'cancelled'
      })
    });
    applyVerifiedPurchase(verified);
    showToast('Coins credited!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadWalletHistory() {
  try {
    const { ledger } = await apiRequest('/wallet/transactions?limit=50');
    dom.walletHistoryList.innerHTML = '';
    if (!ledger.length) {
      dom.walletHistoryList.innerHTML = '<div class="history-row">No transactions yet.</div>';
      return;
    }
    ledger.forEach((tx) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      const left = document.createElement('div');
      left.textContent = `${tx.note || tx.kind} · ${new Date(tx.createdAt).toLocaleString()}`;
      const right = document.createElement('strong');
      right.textContent = `${tx.amount > 0 ? '+' : ''}${tx.amount} coins`;
      row.append(left, right);
      dom.walletHistoryList.appendChild(row);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

dom.btnOpenWallet?.addEventListener('click', () => openWalletModal('buy'));
dom.btnCloseWallet?.addEventListener('click', () => dom.walletModal.classList.add('hidden'));
dom.walletTabBuy?.addEventListener('click', () => switchWalletTab('buy'));
dom.walletTabHistory?.addEventListener('click', async () => {
  switchWalletTab('history');
  await loadWalletHistory();
});

// ---------------- Executive Availability, Earnings & Withdrawals ----------------
dom.execAvailabilitySelect?.addEventListener('change', async (e) => {
  try {
    await apiRequest('/executive/availability', {
      method: 'PUT',
      body: JSON.stringify({ manualStatus: e.target.value })
    });
    showToast(`Availability set to ${e.target.value}.`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function updateServiceToggles() {
  try {
    await apiRequest('/executive/availability', {
      method: 'PUT',
      body: JSON.stringify({
        chatEnabled: dom.chkSvcChat.checked,
        audioEnabled: dom.chkSvcAudio.checked,
        videoEnabled: dom.chkSvcVideo.checked
      })
    });
    showToast('Service availability updated.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

dom.chkSvcChat?.addEventListener('change', updateServiceToggles);
dom.chkSvcAudio?.addEventListener('change', updateServiceToggles);
dom.chkSvcVideo?.addEventListener('change', updateServiceToggles);

async function openExecModal() {
  if (!state.me || state.me.role !== 'executive') return;
  dom.execModal.classList.remove('hidden');
  switchExecTab('earnings');
  await loadExecEarnings();
}

function switchExecTab(tab) {
  dom.execTabEarnings.classList.toggle('active', tab === 'earnings');
  dom.execTabWithdraw.classList.toggle('active', tab === 'withdraw');
  dom.execTabBonuses.classList.toggle('active', tab === 'bonuses');
  dom.execEarningsPane.classList.toggle('hidden', tab !== 'earnings');
  dom.execWithdrawPane.classList.toggle('hidden', tab !== 'withdraw');
  dom.execBonusesPane.classList.toggle('hidden', tab !== 'bonuses');
}

async function loadExecEarnings() {
  try {
    const range = dom.execEarningsRange.value;
    const { period, summary } = await apiRequest(`/executive/earnings?range=${encodeURIComponent(range)}`);
    dom.execAvailSub.textContent = `Available for withdrawal: ₹${summary.availableWithdrawalInr}`;
    const items = [
      ['Chat Earnings', `₹${period.chatInr}`],
      ['Audio Earnings', `₹${period.audioInr}`],
      ['Video Earnings', `₹${period.videoInr}`],
      ['Bonus Earnings', `₹${period.bonusInr}`],
      ['Gross Revenue', `₹${period.grossInr}`],
      ['Platform Fee', `₹${period.platformCommissionInr}`],
      ['Net (Period)', `₹${period.netInr}`],
      ['Withdrawn Total', `₹${summary.withdrawnInr}`]
    ];
    dom.execEarningsGrid.innerHTML = '';
    items.forEach(([label, val]) => {
      const box = document.createElement('div');
      box.className = 'exec-stat-box';
      box.innerHTML = `<small></small><strong></strong>`;
      box.querySelector('small').textContent = label;
      box.querySelector('strong').textContent = val;
      dom.execEarningsGrid.appendChild(box);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadExecWithdrawals() {
  try {
    const { withdrawals, minWithdrawalInr, availableWithdrawalInr } = await apiRequest('/executive/withdrawals');
    dom.execAvailSub.textContent = `Available: ₹${availableWithdrawalInr} (Min ₹${minWithdrawalInr})`;
    dom.execWithdrawList.innerHTML = '';
    if (!withdrawals.length) {
      dom.execWithdrawList.innerHTML = '<div class="history-row">No withdrawal requests yet.</div>';
      return;
    }
    withdrawals.forEach((w) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      const left = document.createElement('div');
      left.textContent = `₹${w.amountInr} · ${w.status.toUpperCase()}${w.utr ? ` (UTR: ${w.utr})` : ''}`;
      row.appendChild(left);
      if (w.status === 'pending') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-chip sm';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', async () => {
          await apiRequest(`/executive/withdrawals/${w.withdrawalId}/cancel`, { method: 'POST' });
          showToast('Withdrawal cancelled.', 'info');
          loadExecWithdrawals();
        });
        row.appendChild(cancelBtn);
      }
      dom.execWithdrawList.appendChild(row);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadExecBonuses() {
  try {
    const { rules, earned } = await apiRequest('/executive/bonuses');
    dom.execBonusesList.innerHTML = '';
    rules.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.textContent = `🎯 ${r.name} · Target: ${r.targetValue} ${r.metric} (${r.period}) -> ₹${r.rewardValue}`;
      dom.execBonusesList.appendChild(row);
    });
    earned.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.textContent = `🏆 Earned ₹${b.amount} — ${b.note}`;
      dom.execBonusesList.appendChild(row);
    });
    if (!rules.length && !earned.length) {
      dom.execBonusesList.innerHTML = '<div class="history-row">No bonus programs active yet.</div>';
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

dom.btnOpenExecDash?.addEventListener('click', openExecModal);
dom.btnCloseExec?.addEventListener('click', () => dom.execModal.classList.add('hidden'));
dom.execTabEarnings?.addEventListener('click', () => {
  switchExecTab('earnings');
  loadExecEarnings();
});
dom.execTabWithdraw?.addEventListener('click', () => {
  switchExecTab('withdraw');
  loadExecWithdrawals();
});
dom.execTabBonuses?.addEventListener('click', () => {
  switchExecTab('bonuses');
  loadExecBonuses();
});
dom.execEarningsRange?.addEventListener('change', loadExecEarnings);

dom.execWithdrawForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiRequest('/executive/withdrawals', {
      method: 'POST',
      body: JSON.stringify({
        amountInr: Number(dom.wdAmount.value),
        payoutMethod: 'upi',
        ...(dom.wdUpi.value.trim() ? { payoutDetails: { upiId: dom.wdUpi.value.trim() } } : {})
      })
    });
    dom.wdAmount.value = '';
    showToast('Withdrawal request submitted!', 'success');
    loadExecWithdrawals();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------------- Notifications Modal ----------------
dom.btnNotifications?.addEventListener('click', async () => {
  dom.notificationsModal.classList.remove('hidden');
  try {
    const { notifications } = await apiRequest('/auth/notifications');
    dom.notificationsList.innerHTML = '';
    if (!notifications.length) {
      dom.notificationsList.innerHTML = '<div class="history-row">No notifications yet.</div>';
    } else {
      notifications.forEach((n) => {
        const row = document.createElement('div');
        row.className = 'history-row';
        row.textContent = `${n.title}: ${n.body} (${new Date(n.createdAt).toLocaleString()})`;
        dom.notificationsList.appendChild(row);
      });
      await apiRequest('/auth/notifications/read', { method: 'POST' });
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

dom.btnCloseNotifications?.addEventListener('click', () => {
  dom.notificationsModal.classList.add('hidden');
});

// Mobile Sidebar Drawer
function openMobileSidebar() {
  dom.sidebar.classList.add('open');
  dom.sidebarBackdrop.classList.remove('hidden');
}

function closeMobileSidebar() {
  dom.sidebar.classList.remove('open');
  dom.sidebarBackdrop.classList.add('hidden');
}

dom.btnOpenSidebar.addEventListener('click', openMobileSidebar);
dom.btnCloseSidebar.addEventListener('click', closeMobileSidebar);
dom.sidebarBackdrop.addEventListener('click', closeMobileSidebar);

// Lightbox
dom.btnCloseLightbox.addEventListener('click', () => {
  dom.lightbox.classList.add('hidden');
});
dom.lightbox.addEventListener('click', (e) => {
  if (e.target === dom.lightbox) {
    dom.lightbox.classList.add('hidden');
  }
});

// PWA Service Worker registration
if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

