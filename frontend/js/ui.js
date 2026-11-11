const QUICK_EMOJIS = [
  '😀', '😂', '😍', '🔥', '👏', '🎉', '❤️', '👍',
  '🙌', '🤩', '😎', '🤔', '😅', '🚀', '✨', '💯',
  '👀', '🫡', '🤝', '💡', '🎧', '📹', '💬', '⚡'
];

const REACTION_CHOICES = ['👍', '❤️', '😂', '🔥', '👏'];

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, 3400);
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function initEmojiPopover(popoverEl, onPick) {
  popoverEl.innerHTML = '';
  QUICK_EMOJIS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => onPick(emoji));
    popoverEl.appendChild(btn);
  });
}

export function renderChannels({
  listEl,
  channels,
  activeTarget,
  unreadCounts,
  filter,
  onSelect
}) {
  listEl.innerHTML = '';
  const query = filter.trim().toLowerCase();

  channels
    .filter((ch) => !query || ch.name.toLowerCase().includes(query))
    .forEach((ch) => {
      const li = document.createElement('li');
      const isActive =
        activeTarget.type === 'channel' && activeTarget.id === ch.id;
      li.className = `nav-item${isActive ? ' active' : ''}`;

      const unread = unreadCounts.get(ch.id) || 0;

      li.innerHTML = `
        <div class="nav-item-main">
          <span class="channel-hash">#</span>
          <div class="nav-label-wrap">
            <div class="nav-label"></div>
            <div class="nav-sub"></div>
          </div>
        </div>
        <div class="nav-item-actions"></div>
      `;

      li.querySelector('.nav-label').textContent = ch.name;
      li.querySelector('.nav-sub').textContent = ch.topic;

      if (unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        li.querySelector('.nav-item-actions').appendChild(badge);
      }

      li.addEventListener('click', () => onSelect(ch));
      listEl.appendChild(li);
    });
}

export function renderUsers({
  listEl,
  emptyHintEl,
  countEl,
  users,
  meId,
  activeTarget,
  unreadCounts,
  getDmRoomId,
  filter,
  categoryFilter = 'all',
  onSelectUser,
  onCallUser
}) {
  listEl.innerHTML = '';
  const peers = users.filter((u) => u.id !== meId && (u.role !== 'executive' || u.approvalStatus === 'approved'));
  const onlinePeersCount = peers.filter((u) => u.status !== 'offline').length;
  countEl.textContent = String(onlinePeersCount);

  const query = filter.trim().toLowerCase();
  const filtered = peers.filter((u) => {
    const matchesSearch =
      !query ||
      u.name.toLowerCase().includes(query) ||
      (u.username && u.username.toLowerCase().includes(query)) ||
      (u.category && u.category.toLowerCase().includes(query));
    if (!matchesSearch) return false;
    if (categoryFilter === 'online') return u.status === 'online';
    if (categoryFilter && categoryFilter !== 'all') return u.category === categoryFilter;
    return true;
  });

  emptyHintEl.classList.toggle('hidden', peers.length > 0);

  filtered.forEach((peer) => {
    const li = document.createElement('li');
    const isActive = activeTarget.type === 'dm' && activeTarget.id === peer.id;
    li.className = `nav-item${isActive ? ' active' : ''}`;

    const roomId = getDmRoomId(meId, peer.id);
    const unread = unreadCounts.get(roomId) || 0;
    const statusClass =
      peer.status === 'in-call' ? 'in-call' : peer.status === 'online' ? 'online' : 'offline';
    const roleTag = peer.role === 'executive' ? `${peer.category || 'Executive'} · ` : '';
    const statusLabel =
      peer.status === 'in-call' ? 'In a call' : peer.status === 'online' ? 'Online' : 'Offline';

    li.innerHTML = `
      <div class="nav-item-main">
        <div class="avatar-wrap">
          <div class="avatar sm"></div>
          <span class="status-dot ${statusClass}"></span>
        </div>
        <div class="nav-label-wrap">
          <div class="nav-label"></div>
          <div class="nav-sub"></div>
        </div>
      </div>
      <div class="nav-item-actions">
        <button class="quick-call-btn audio" title="Voice call">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button class="quick-call-btn video" title="Video call">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <polygon points="23 7 16 12 23 17 23 7" stroke-linejoin="round" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </button>
      </div>
    `;

    const avatarEl = li.querySelector('.avatar');
    avatarEl.textContent = peer.avatar;
    avatarEl.style.background = peer.color;
    li.querySelector('.nav-label').textContent = peer.name;
    li.querySelector('.nav-sub').textContent = `${roleTag}${statusLabel}`;

    const actions = li.querySelector('.nav-item-actions');
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      actions.prepend(badge);
    }

    li.querySelector('.quick-call-btn.audio').addEventListener('click', (e) => {
      e.stopPropagation();
      onCallUser(peer, 'audio');
    });

    li.querySelector('.quick-call-btn.video').addEventListener('click', (e) => {
      e.stopPropagation();
      onCallUser(peer, 'video');
    });

    li.addEventListener('click', () => onSelectUser(peer));
    listEl.appendChild(li);
  });
}

export function renderMessages({
  listEl,
  containerEl,
  messages,
  meId,
  emptyTitle,
  emptySubtitle,
  onReply,
  onReact,
  onDelete,
  onOpenLightbox,
  onViewOnce
}) {
  listEl.innerHTML = '';

  if (!messages || messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-chat-banner';
    empty.innerHTML = `<h3></h3><p></p>`;
    empty.querySelector('h3').textContent = emptyTitle;
    empty.querySelector('p').textContent = emptySubtitle;
    listEl.appendChild(empty);
    return;
  }

  messages.forEach((msg) => {
    if (msg.type === 'call-log') {
      const pill = document.createElement('div');
      pill.className = 'call-log-pill';
      const label = document.createElement('span');
      label.textContent = msg.text;
      const time = document.createElement('span');
      time.className = 'call-log-time';
      time.textContent = formatTime(msg.createdAt);
      pill.append(label, time);
      listEl.appendChild(pill);
      return;
    }

    const isOwn = msg.senderId === meId;
    const row = document.createElement('div');
    row.className = `msg-row${isOwn ? ' own' : ''}`;
    row.dataset.messageId = msg.id;

    const avatar = document.createElement('div');
    avatar.className = 'avatar sm';
    avatar.textContent = msg.senderAvatar || msg.senderName?.[0] || '?';
    avatar.style.background = msg.senderColor || '#6366f1';

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'msg-body-wrap';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const senderSpan = document.createElement('span');
    senderSpan.className = 'msg-sender';
    senderSpan.textContent = isOwn ? 'You' : msg.senderName;
    const timeSpan = document.createElement('span');
    const tick = isOwn
      ? msg.deliveryStatus === 'read'
        ? ' · ✓✓'
        : msg.deliveryStatus === 'delivered'
        ? ' · ✓✓'
        : ' · ✓'
      : '';
    const paidTag = msg.isPaid && msg.coinsCharged ? ` · 🪙${msg.coinsCharged}` : '';
    timeSpan.textContent = `${formatTime(msg.createdAt)}${tick}${paidTag}`;
    meta.append(senderSpan, timeSpan);

    const bubbleContainer = document.createElement('div');
    bubbleContainer.className = 'msg-bubble-container';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (msg.viewOnce && !isOwn && !msg.viewOnceOpened) {
      const voBtn = document.createElement('button');
      voBtn.type = 'button';
      voBtn.className = 'btn-chip sm';
      voBtn.textContent = '👁 View Once Message (Tap to open)';
      voBtn.addEventListener('click', () => {
        onViewOnce?.(msg);
        voBtn.remove();
        if (msg.text) {
          const td = document.createElement('div');
          td.textContent = msg.text;
          bubble.appendChild(td);
        }
        if (msg.attachment?.dataUrl && String(msg.attachment.type || '').startsWith('image/')) {
          onOpenLightbox(msg.attachment.dataUrl);
        }
      });
      bubble.appendChild(voBtn);
      bubbleContainer.append(bubble);
      bodyWrap.append(meta, bubbleContainer);
      row.append(avatar, bodyWrap);
      listEl.appendChild(row);
      return;
    }

    if (msg.replyTo) {
      const quote = document.createElement('div');
      quote.className = 'reply-quote';
      const qAuthor = document.createElement('div');
      qAuthor.className = 'reply-quote-author';
      qAuthor.textContent = msg.replyTo.senderName;
      const qText = document.createElement('div');
      qText.className = 'reply-quote-text';
      qText.textContent = msg.replyTo.text || 'Attachment';
      quote.append(qAuthor, qText);
      bubble.appendChild(quote);
    }

    if (msg.text) {
      const textDiv = document.createElement('div');
      textDiv.textContent = msg.text;
      bubble.appendChild(textDiv);
    }

    if (msg.attachment && msg.attachment.dataUrl) {
      const mime = String(msg.attachment.type || '');
      if (mime.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'msg-attachment-img';
        img.src = msg.attachment.dataUrl;
        img.alt = msg.attachment.name || 'Photo';
        img.addEventListener('click', () => onOpenLightbox(msg.attachment.dataUrl));
        bubble.appendChild(img);
      } else if (mime.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.className = 'msg-attachment-audio';
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = msg.attachment.dataUrl;
        bubble.appendChild(audio);
      } else {
        const link = document.createElement('a');
        link.className = 'msg-attachment-file';
        link.href = msg.attachment.dataUrl;
        link.download = msg.attachment.name || 'file';
        link.textContent = `📎 ${msg.attachment.name || 'Attachment'}`;
        bubble.appendChild(link);
      }
    }

    const hoverActions = document.createElement('div');
    hoverActions.className = 'msg-hover-actions';

    REACTION_CHOICES.slice(0, 3).forEach((emoji) => {
      const rBtn = document.createElement('button');
      rBtn.type = 'button';
      rBtn.className = 'mini-action';
      rBtn.title = `React with ${emoji}`;
      rBtn.textContent = emoji;
      rBtn.addEventListener('click', () => onReact(msg.id, emoji));
      hoverActions.appendChild(rBtn);
    });

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'mini-action';
    replyBtn.title = 'Reply';
    replyBtn.textContent = '↩';
    replyBtn.addEventListener('click', () => onReply(msg));
    hoverActions.appendChild(replyBtn);

    if (isOwn) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini-action';
      delBtn.title = 'Delete message';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => onDelete(msg.id));
      hoverActions.appendChild(delBtn);
    }

    bubbleContainer.append(bubble, hoverActions);
    bodyWrap.append(meta, bubbleContainer);

    const reactionEntries = Object.entries(msg.reactions || {});
    if (reactionEntries.length > 0) {
      const reactionsRow = document.createElement('div');
      reactionsRow.className = 'reactions-row';
      reactionEntries.forEach(([emoji, userIds]) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `reaction-pill${userIds.includes(meId) ? ' active' : ''}`;
        pill.textContent = `${emoji} ${userIds.length}`;
        pill.addEventListener('click', () => onReact(msg.id, emoji));
        reactionsRow.appendChild(pill);
      });
      bodyWrap.appendChild(reactionsRow);
    }

    row.append(avatar, bodyWrap);
    listEl.appendChild(row);
  });

  containerEl.scrollTop = containerEl.scrollHeight;
}

