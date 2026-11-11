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
  activeTarget: { type: 'channel', id: 'channel:general' },
  messagesByRoom: new Map(),
  unreadCounts: new Map(),
  typingUsersByRoom: new Map(),
  replyTo: null,
  pendingAttachment: null,
  searchFilter: ''
};

let selectedAvatar = AVATAR_OPTIONS[0];
let selectedColor = COLOR_OPTIONS[0];
let authMode = 'login'; // 'login' | 'register' | 'profile'
let typingTimeout = null;
let isCurrentlyTyping = false;

const TOKEN_STORAGE_KEY = 'pulse_auth_token';

const dom = {
  authModal: document.getElementById('auth-modal'),
  authTabs: document.getElementById('auth-tabs'),
  tabLogin: document.getElementById('tab-login'),
  tabRegister: document.getElementById('tab-register'),
  authForm: document.getElementById('auth-form'),
  authError: document.getElementById('auth-error'),
  btnCloseAuth: document.getElementById('btn-close-auth'),
  btnAuthSubmit: document.getElementById('btn-auth-submit'),
  fieldNameGroup: document.getElementById('field-name-group'),
  fieldUsernameGroup: document.getElementById('field-username-group'),
  fieldPasswordGroup: document.getElementById('field-password-group'),
  fieldAvatarGroup: document.getElementById('field-avatar-group'),
  fieldColorGroup: document.getElementById('field-color-group'),
  displayNameInput: document.getElementById('display-name'),
  usernameInput: document.getElementById('auth-username'),
  passwordInput: document.getElementById('auth-password'),
  avatarPicker: document.getElementById('avatar-picker'),
  colorPicker: document.getElementById('color-picker'),
  appShell: document.getElementById('app-shell'),

  sidebar: document.getElementById('sidebar'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  btnOpenSidebar: document.getElementById('btn-open-sidebar'),
  btnCloseSidebar: document.getElementById('btn-close-sidebar'),
  sidebarSearch: document.getElementById('sidebar-search'),

  channelList: document.getElementById('channel-list'),
  userList: document.getElementById('user-list'),
  noPeersHint: document.getElementById('no-peers-hint'),
  onlineCount: document.getElementById('online-count'),

  meAvatar: document.getElementById('me-avatar'),
  meName: document.getElementById('me-name'),
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
  btnVoiceNote: document.getElementById('btn-voice-note'),
  btnVoiceCancel: document.getElementById('btn-voice-cancel'),
  btnVoiceSend: document.getElementById('btn-voice-send'),
  messageInput: document.getElementById('message-input'),
  btnSend: document.getElementById('btn-send'),

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
  }
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
  const isRegister = mode === 'register';
  const isProfile = mode === 'profile';

  dom.authTabs.classList.toggle('hidden', isProfile);
  dom.tabLogin.classList.toggle('active', isLogin);
  dom.tabRegister.classList.toggle('active', isRegister);
  dom.tabLogin.setAttribute('aria-selected', String(isLogin));
  dom.tabRegister.setAttribute('aria-selected', String(isRegister));

  dom.fieldNameGroup.classList.toggle('hidden', isLogin);
  dom.fieldUsernameGroup.classList.toggle('hidden', isProfile);
  dom.fieldPasswordGroup.classList.toggle('hidden', isProfile);
  dom.fieldAvatarGroup.classList.toggle('hidden', isLogin);
  dom.fieldColorGroup.classList.toggle('hidden', isLogin);

  dom.displayNameInput.required = isRegister || isProfile;
  dom.usernameInput.required = isLogin || isRegister;
  dom.passwordInput.required = isLogin || isRegister;
  dom.passwordInput.autocomplete = isRegister ? 'new-password' : 'current-password';

  dom.btnCloseAuth.classList.toggle('hidden', !isProfile);
  const label = isLogin ? 'Log In' : isRegister ? 'Create Account' : 'Save Profile';
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
dom.tabRegister.addEventListener('click', () => setAuthMode('register'));

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
      const token = getStoredToken();
      const name = dom.displayNameInput.value.trim();
      const res = await fetch(`${backendOrigin}/auth/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          name,
          avatar: selectedAvatar,
          color: selectedColor
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Could not update profile.');
      }
      state.me = { ...state.me, ...data.user };
      dom.meAvatar.textContent = state.me.avatar;
      dom.meAvatar.style.background = state.me.color;
      dom.meName.textContent = state.me.name;
      dom.authModal.classList.add('hidden');
      showToast('Profile updated.', 'success');
      return;
    }

    const endpoint = authMode === 'register' ? '/auth/register' : '/auth/login';
    const body =
      authMode === 'register'
        ? {
            name: dom.displayNameInput.value.trim(),
            username: dom.usernameInput.value.trim(),
            password: dom.passwordInput.value,
            avatar: selectedAvatar,
            color: selectedColor
          }
        : {
            username: dom.usernameInput.value.trim(),
            password: dom.passwordInput.value
          };

    const res = await fetch(`${backendOrigin}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Authentication failed.');
    }

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
  dom.displayNameInput.value = state.me.name;
  setAuthMode('profile');
  dom.authModal.classList.remove('hidden');
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

socket.on('session:ready', ({ user, channels, users, history }) => {
  state.me = user;
  state.channels = channels;
  state.users = users;
  state.messagesByRoom.clear();

  Object.entries(history).forEach(([roomId, msgs]) => {
    state.messagesByRoom.set(roomId, msgs);
  });

  dom.meAvatar.textContent = user.avatar;
  dom.meAvatar.style.background = user.color;
  dom.meName.textContent = user.name;

  dom.authModal.classList.add('hidden');
  dom.appShell.classList.remove('hidden');

  refreshAllViews();
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
    onSelectUser: selectDmPeer,
    onCallUser: startCallWithPeer
  });
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
      const handle = peer.username ? `@${peer.username} · ` : '';
      dom.headerSubtitle.textContent =
        peer.status === 'in-call'
          ? `${handle}Currently in a call`
          : peer.status === 'online'
          ? `${handle}Online — ready to chat or call`
          : `${handle}Offline — messages are saved in chat history`;
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
    }
  });
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
    replyTo: state.replyTo
  });

  dom.messageInput.value = '';
  dom.messageInput.style.height = 'auto';
  state.replyTo = null;
  state.pendingAttachment = null;
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

// Search Filter
dom.sidebarSearch.addEventListener('input', (e) => {
  state.searchFilter = e.target.value;
  refreshSidebar();
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

