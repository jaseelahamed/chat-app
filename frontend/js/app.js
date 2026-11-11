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

function resolveBackendOrigin() {
  const paramBackend = new URLSearchParams(window.location.search).get('backend');
  if (paramBackend) {
    return paramBackend.replace(/\/+$/, '');
  }
  if (typeof window.PULSE_BACKEND_URL === 'string' && window.PULSE_BACKEND_URL.trim()) {
    return window.PULSE_BACKEND_URL.trim().replace(/\/+$/, '');
  }
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const host = window.location.hostname || 'localhost';
  return `${proto}//${host}:${DEFAULT_BACKEND_PORT}`;
}

// Connects same-origin when served by the backend, or directly to the separate backend port (default :5000)
async function connectSocket() {
  if (typeof window.io === 'function') {
    return window.io();
  }

  const backendOrigin = resolveBackendOrigin();
  const isFileOrigin = window.location.protocol === 'file:';
  const isSameAsBackend = !isFileOrigin && window.location.origin === backendOrigin;

  if (isSameAsBackend) {
    await loadScript('/socket.io/socket.io.js');
    return window.io();
  }

  await loadScript(`${backendOrigin}/socket.io/socket.io.js`);
  return window.io(backendOrigin);
}

let socket;
try {
  socket = await connectSocket();
} catch (err) {
  showToast(`Backend server not reachable at ${resolveBackendOrigin()}. Start backend/server.js first.`, 'error');
  throw err;
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
let typingTimeout = null;
let isCurrentlyTyping = false;

const dom = {
  authModal: document.getElementById('auth-modal'),
  authForm: document.getElementById('auth-form'),
  btnCloseAuth: document.getElementById('btn-close-auth'),
  btnAuthSubmit: document.getElementById('btn-auth-submit'),
  displayNameInput: document.getElementById('display-name'),
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

// ---------------- Profile Onboarding ----------------
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

function getOrCreateClientId() {
  let id = sessionStorage.getItem('pulse_user_id');
  if (!id) {
    id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem('pulse_user_id', id);
  }
  return id;
}

function joinWithProfile(profile) {
  sessionStorage.setItem('pulse_profile', JSON.stringify(profile));
  socket.emit('user:join', profile);
}

const savedProfileRaw = sessionStorage.getItem('pulse_profile');
if (savedProfileRaw) {
  try {
    const parsed = JSON.parse(savedProfileRaw);
    selectedAvatar = parsed.avatar || selectedAvatar;
    selectedColor = parsed.color || selectedColor;
    dom.displayNameInput.value = parsed.name || '';
  } catch {
    // Ignore corrupt session value
  }
}

initProfilePickers();

dom.authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = dom.displayNameInput.value.trim();
  if (!name) return;

  soundFX.ensureContext();
  joinWithProfile({
    id: getOrCreateClientId(),
    name,
    avatar: selectedAvatar,
    color: selectedColor
  });
});

dom.btnEditProfile.addEventListener('click', () => {
  if (state.me) {
    dom.displayNameInput.value = state.me.name;
    dom.btnCloseAuth.classList.remove('hidden');
    dom.btnAuthSubmit.querySelector('span').textContent = 'Save Profile';
  }
  dom.authModal.classList.remove('hidden');
});

dom.btnCloseAuth.addEventListener('click', () => {
  if (state.me) {
    dom.authModal.classList.add('hidden');
  }
});

socket.on('connect', () => {
  const existing = sessionStorage.getItem('pulse_profile');
  if (existing) {
    try {
      socket.emit('user:join', JSON.parse(existing));
    } catch {
      // Ignore
    }
  }
});

socket.on('disconnect', () => {
  if (state.me) {
    showToast('Connection lost — attempting to reconnect...', 'error');
  }
});

// ---------------- Socket Events ----------------
socket.on('session:ready', ({ user, channels, users, history }) => {
  state.me = user;
  state.channels = channels;
  state.users = users;

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
      dom.headerSubtitle.textContent =
        peer.status === 'in-call' ? 'Currently in a call' : 'Online — ready to chat or call';
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
      state.replyTo = {
        id: msg.id,
        senderName: msg.senderId === state.me.id ? 'You' : msg.senderName,
        text: msg.text || (msg.attachment ? msg.attachment.name : '')
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

// Attachments
dom.btnAttach.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', () => {
  const file = dom.fileInput.files?.[0];
  dom.fileInput.value = '';
  if (!file) return;

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

