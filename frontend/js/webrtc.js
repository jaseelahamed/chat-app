import { soundFX } from './sound.js';

export class WebRTCManager {
  constructor({ socket, backendOrigin, showToast, onCallStateChange }) {
    this.socket = socket;
    this.backendOrigin = (backendOrigin || window.location.origin).replace(/\/+$/, '');
    this.showToast = showToast;
    this.onCallStateChange = onCallStateChange;

    this.client = null;
    this.localAudioTrack = null;
    this.localVideoTrack = null;
    this.localScreenTrack = null;
    this.remoteAudioTrack = null;
    this.remoteVideoTrack = null;
    this.publishedAudio = false;
    this.publishedVideoType = null; // 'camera' | 'screen' | null

    this.activeCall = null; // { peer, callType, role, channel, state }
    this.pendingIncoming = null; // { from, callType, channel }

    this.micEnabled = true;
    this.camEnabled = false;
    this.screenSharing = false;
    this.isMinimized = false;

    this.timerInterval = null;
    this.ringTimeout = null;
    this.callStartedAt = null;

    this.dom = {
      incomingModal: document.getElementById('incoming-call-modal'),
      incomingAvatar: document.getElementById('incoming-avatar'),
      incomingBadge: document.getElementById('incoming-call-badge'),
      incomingName: document.getElementById('incoming-caller-name'),
      btnAccept: document.getElementById('btn-accept-call'),
      btnReject: document.getElementById('btn-reject-call'),

      overlay: document.getElementById('call-overlay'),
      peerAvatar: document.getElementById('call-peer-avatar'),
      peerName: document.getElementById('call-peer-name'),
      stateLabel: document.getElementById('call-state-label'),
      timer: document.getElementById('call-timer'),
      btnMinimize: document.getElementById('btn-minimize-call'),
      btnRestore: document.getElementById('btn-restore-call'),
      miniHeaderTimer: document.getElementById('mini-header-timer'),

      remoteVideo: document.getElementById('remote-video'),
      remoteAudio: document.getElementById('remote-audio'),
      avatarStage: document.getElementById('remote-avatar-stage'),
      stageAvatar: document.getElementById('stage-peer-avatar'),
      stageName: document.getElementById('stage-peer-name'),
      stageSubtext: document.getElementById('stage-subtext'),
      peerBadges: document.getElementById('peer-media-badges'),

      localPip: document.getElementById('local-pip'),
      localVideo: document.getElementById('local-video'),

      btnMic: document.getElementById('btn-toggle-mic'),
      btnCam: document.getElementById('btn-toggle-cam'),
      btnShare: document.getElementById('btn-share-screen'),
      btnEnd: document.getElementById('btn-end-call')
    };

    this.bindUIEvents();
    this.bindSocketEvents();
  }

  getAgoraSDK() {
    if (!window.AgoraRTC) {
      throw new Error('Agora SDK failed to load. Refresh the page and check your connection.');
    }
    window.AgoraRTC.setLogLevel?.(2);
    return window.AgoraRTC;
  }

  bindUIEvents() {
    this.dom.btnAccept.addEventListener('click', () => this.acceptIncomingCall());
    this.dom.btnReject.addEventListener('click', () => this.rejectIncomingCall());
    this.dom.btnEnd.addEventListener('click', () => this.endActiveCall());
    this.dom.btnMic.addEventListener('click', () => this.toggleMic());
    this.dom.btnCam.addEventListener('click', () => this.toggleCamera());
    this.dom.btnShare.addEventListener('click', () => this.toggleScreenShare());
    this.dom.btnMinimize.addEventListener('click', () => this.setMinimized(true));
    this.dom.btnRestore.addEventListener('click', () => this.setMinimized(false));
  }

  bindSocketEvents() {
    this.socket.on('call:incoming', ({ from, callType, channel }) => {
      if (this.activeCall || this.pendingIncoming) {
        this.socket.emit('call:reject', { to: from.id, reason: 'busy' });
        return;
      }

      this.pendingIncoming = { from, callType, channel };
      this.dom.incomingAvatar.textContent = from.avatar;
      this.dom.incomingAvatar.style.background = from.color;
      this.dom.incomingName.textContent = from.name;
      this.dom.incomingBadge.textContent =
        callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call';
      this.dom.incomingModal.classList.remove('hidden');
      soundFX.startRingtone(false);
    });

    this.socket.on('call:accepted', async ({ channel }) => {
      if (!this.activeCall) return;
      clearTimeout(this.ringTimeout);
      this.ringTimeout = null;
      soundFX.stopRingtone();

      this.activeCall.channel = channel || this.activeCall.channel;
      this.activeCall.state = 'connecting';
      this.updateStageStatus('Connecting...', 'Joining Agora RTC channel...');

      try {
        await this.joinAgoraChannel(this.activeCall.channel);
      } catch (err) {
        console.error('Failed to join Agora channel:', err);
        this.showToast(err.message || 'Could not establish Agora call.', 'error');
        this.endActiveCall();
      }
    });

    this.socket.on('call:rejected', ({ reason }) => {
      soundFX.stopRingtone();
      const msg = reason === 'busy' ? 'User is currently in another call.' : 'Call was declined.';
      this.showToast(msg, 'error');
      this.cleanupCall();
    });

    this.socket.on('call:busy', ({ name }) => {
      soundFX.stopRingtone();
      this.showToast(`${name} is currently in another call.`, 'error');
      this.cleanupCall();
    });

    this.socket.on('call:unavailable', ({ reason }) => {
      soundFX.stopRingtone();
      this.showToast(reason || 'User is unavailable.', 'error');
      this.cleanupCall();
    });

    this.socket.on('call:ended', ({ reason }) => {
      soundFX.stopRingtone();
      if (this.pendingIncoming) {
        this.pendingIncoming = null;
        this.dom.incomingModal.classList.add('hidden');
        this.showToast('Missed call.', 'info');
        return;
      }
      if (this.activeCall) {
        const msg =
          reason === 'disconnected'
            ? 'Peer disconnected from call.'
            : reason === 'cancelled'
            ? 'Call cancelled.'
            : 'Call ended.';
        this.showToast(msg, 'info');
        this.cleanupCall();
      }
    });

    this.socket.on('call:media-state', ({ micEnabled, camEnabled, screenSharing }) => {
      this.renderPeerMediaBadges({ micEnabled, camEnabled, screenSharing });
      this.refreshRemoteVideoVisibility(camEnabled || screenSharing);
    });
  }

  async acquireMedia(wantsVideo) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        'Camera/microphone access requires localhost or HTTPS in this browser.'
      );
    }

    const AgoraRTC = this.getAgoraSDK();
    const audioTrack = await AgoraRTC.createMicrophoneAudioTrack({
      AEC: true,
      ANS: true
    });

    if (!wantsVideo) {
      return { audioTrack, videoTrack: null, hasVideo: false };
    }

    try {
      const videoTrack = await AgoraRTC.createCameraVideoTrack({
        encoderConfig: '720p_1'
      });
      return { audioTrack, videoTrack, hasVideo: true };
    } catch (err) {
      if (
        err.code === 'DEVICE_NOT_FOUND' ||
        err.name === 'NotFoundError' ||
        err.name === 'OverconstrainedError'
      ) {
        this.showToast('No camera detected — joining with audio only.', 'info');
        return { audioTrack, videoTrack: null, hasVideo: false };
      }
      audioTrack.stop();
      audioTrack.close();
      throw err;
    }
  }

  async startCall(peer, callType) {
    if (this.activeCall || this.pendingIncoming) {
      this.showToast('You are already in a call.', 'error');
      return;
    }

    try {
      const { audioTrack, videoTrack, hasVideo } = await this.acquireMedia(callType === 'video');
      this.localAudioTrack = audioTrack;
      this.localVideoTrack = videoTrack;
      this.micEnabled = true;
      this.camEnabled = hasVideo;
      this.screenSharing = false;

      this.activeCall = {
        peer,
        callType: hasVideo ? 'video' : 'audio',
        role: 'caller',
        channel: null,
        state: 'ringing'
      };

      this.openCallStage(peer, 'Calling...', `Ringing ${peer.name}...`);
      this.syncLocalPreview();
      this.updateControlButtons();
      soundFX.startRingtone(true);

      this.socket.emit('call:request', {
        to: peer.id,
        callType: this.activeCall.callType
      });
      this.ringTimeout = setTimeout(() => {
        if (this.activeCall && this.activeCall.state === 'ringing') {
          this.showToast(`${peer.name} did not answer.`, 'info');
          this.endActiveCall();
        }
      }, 45000);
      this.onCallStateChange?.(true);
    } catch (err) {
      console.error('Failed to start call:', err);
      this.showToast(
        err.message || 'Please allow microphone/camera permissions to place a call.',
        'error'
      );
      this.cleanupCall();
    }
  }

  async acceptIncomingCall() {
    if (!this.pendingIncoming) return;
    const { from, callType, channel } = this.pendingIncoming;
    this.pendingIncoming = null;
    this.dom.incomingModal.classList.add('hidden');
    soundFX.stopRingtone();

    try {
      const { audioTrack, videoTrack, hasVideo } = await this.acquireMedia(callType === 'video');
      this.localAudioTrack = audioTrack;
      this.localVideoTrack = videoTrack;
      this.micEnabled = true;
      this.camEnabled = hasVideo;
      this.screenSharing = false;

      this.activeCall = {
        peer: from,
        callType: hasVideo ? 'video' : 'audio',
        role: 'callee',
        channel,
        state: 'connecting'
      };

      this.openCallStage(from, 'Connecting...', 'Joining Agora RTC channel...');
      this.syncLocalPreview();
      this.updateControlButtons();

      this.socket.emit('call:accept', { to: from.id });
      this.onCallStateChange?.(true);

      await this.joinAgoraChannel(channel);
      this.emitMediaState();
    } catch (err) {
      console.error('Failed to accept call:', err);
      this.showToast(
        err.message || 'Microphone/camera access is required to answer.',
        'error'
      );
      this.socket.emit('call:reject', { to: from.id, reason: 'declined' });
      this.cleanupCall();
    }
  }

  rejectIncomingCall() {
    if (!this.pendingIncoming) return;
    const { from } = this.pendingIncoming;
    this.pendingIncoming = null;
    this.dom.incomingModal.classList.add('hidden');
    soundFX.stopRingtone();
    this.socket.emit('call:reject', { to: from.id, reason: 'declined' });
  }

  endActiveCall() {
    if (!this.activeCall) return;
    const peerId = this.activeCall.peer.id;
    const eventName = this.activeCall.state === 'ringing' ? 'call:cancel' : 'call:end';
    this.socket.emit(eventName, { to: peerId });
    this.cleanupCall();
  }

  markCallConnected() {
    if (!this.activeCall || this.activeCall.state === 'connected') return;
    this.activeCall.state = 'connected';
    const sub =
      this.activeCall.callType === 'video' ? 'HD video & audio active' : 'Voice call active';
    this.updateStageStatus('Connected', sub);
    this.startTimer();
    this.emitMediaState();
  }

  async fetchAgoraToken(channelName) {
    const uid = Math.floor(1 + Math.random() * 2147483646);
    const url = `${this.backendOrigin}/agora/token?channel=${encodeURIComponent(channelName)}&uid=${uid}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to fetch Agora call token.');
    }
    return data;
  }

  async joinAgoraChannel(channelName) {
    if (!channelName) {
      throw new Error('Missing Agora call channel.');
    }

    const AgoraRTC = this.getAgoraSDK();
    const callSession = this.activeCall;
    const { appId, channel, token, uid } = await this.fetchAgoraToken(channelName);

    if (!this.activeCall || this.activeCall !== callSession) return;

    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    this.client = client;

    client.on('user-joined', () => {
      if (this.activeCall === callSession) {
        this.markCallConnected();
      }
    });

    client.on('user-published', async (user, mediaType) => {
      try {
        await client.subscribe(user, mediaType);
        if (this.activeCall !== callSession) return;

        if (mediaType === 'audio' && user.audioTrack) {
          this.remoteAudioTrack = user.audioTrack;
          user.audioTrack.play();
        }
        if (mediaType === 'video' && user.videoTrack) {
          this.remoteVideoTrack = user.videoTrack;
          this.dom.remoteVideo.srcObject = new MediaStream([user.videoTrack.getMediaStreamTrack()]);
          this.dom.remoteVideo.play?.().catch(() => {});
          this.refreshRemoteVideoVisibility(true);
        }
        this.markCallConnected();
      } catch (err) {
        console.error('Failed to subscribe to remote track:', err);
      }
    });

    client.on('user-unpublished', (_user, mediaType) => {
      if (mediaType === 'video') {
        this.remoteVideoTrack = null;
        this.dom.remoteVideo.srcObject = null;
        this.refreshRemoteVideoVisibility(false);
      }
      if (mediaType === 'audio') {
        this.remoteAudioTrack = null;
      }
    });

    client.on('user-left', () => {
      this.remoteVideoTrack = null;
      this.remoteAudioTrack = null;
      this.dom.remoteVideo.srcObject = null;
      this.refreshRemoteVideoVisibility(false);
    });

    client.on('connection-state-change', (curState, _revState, reason) => {
      if (this.activeCall !== callSession) return;
      if (curState === 'DISCONNECTED' && reason !== 'LEAVE') {
        this.showToast('Agora connection lost.', 'error');
        this.endActiveCall();
      }
    });

    await client.join(appId, channel, token, uid);

    if (!this.activeCall || this.activeCall !== callSession) {
      await client.leave().catch(() => {});
      return;
    }

    const toPublish = [];
    if (this.localAudioTrack && this.micEnabled) {
      toPublish.push(this.localAudioTrack);
      this.publishedAudio = true;
    }
    if (this.localVideoTrack && this.camEnabled && !this.screenSharing) {
      toPublish.push(this.localVideoTrack);
      this.publishedVideoType = 'camera';
    }

    if (toPublish.length > 0) {
      await client.publish(toPublish);
    }

    if (client.remoteUsers.length > 0) {
      this.markCallConnected();
    } else {
      this.updateStageStatus('Connecting...', 'Waiting for peer to join...');
    }
  }

  async toggleMic() {
    if (!this.localAudioTrack) return;
    this.micEnabled = !this.micEnabled;
    await this.localAudioTrack.setEnabled(this.micEnabled);
    if (this.client && this.micEnabled && !this.publishedAudio) {
      await this.client.publish(this.localAudioTrack);
      this.publishedAudio = true;
    }
    this.updateControlButtons();
    this.emitMediaState();
  }

  async toggleCamera() {
    if (!this.activeCall) return;

    if (this.localVideoTrack) {
      this.camEnabled = !this.camEnabled;
      await this.localVideoTrack.setEnabled(this.camEnabled);

      if (this.screenSharing && this.camEnabled) {
        await this.stopScreenShare();
        return;
      }

      if (this.client && !this.screenSharing && this.camEnabled && this.publishedVideoType !== 'camera') {
        await this.client.publish(this.localVideoTrack);
        this.publishedVideoType = 'camera';
      }

      this.syncLocalPreview();
      this.updateControlButtons();
      this.emitMediaState();
      return;
    }

    try {
      const AgoraRTC = this.getAgoraSDK();
      this.localVideoTrack = await AgoraRTC.createCameraVideoTrack({
        encoderConfig: '720p_1'
      });
      this.camEnabled = true;

      if (this.client && !this.screenSharing) {
        if (this.publishedVideoType === 'screen' && this.localScreenTrack) {
          await this.client.unpublish(this.localScreenTrack);
        }
        await this.client.publish(this.localVideoTrack);
        this.publishedVideoType = 'camera';
      }

      this.syncLocalPreview();
      this.updateControlButtons();
      this.emitMediaState();
    } catch (err) {
      console.error('Camera upgrade failed:', err);
      this.showToast('Unable to access camera.', 'error');
    }
  }

  async toggleScreenShare() {
    if (!this.activeCall || !this.client) {
      this.showToast('Wait until the call is connected to share your screen.', 'info');
      return;
    }

    if (this.screenSharing) {
      await this.stopScreenShare();
      return;
    }

    try {
      const AgoraRTC = this.getAgoraSDK();
      const created = await AgoraRTC.createScreenVideoTrack({ encoderConfig: '1080p_1' }, 'disable');
      this.localScreenTrack = Array.isArray(created) ? created[0] : created;

      if (this.publishedVideoType === 'camera' && this.localVideoTrack) {
        await this.client.unpublish(this.localVideoTrack);
        this.publishedVideoType = null;
      }

      await this.client.publish(this.localScreenTrack);
      this.publishedVideoType = 'screen';
      this.screenSharing = true;

      this.dom.localPip.classList.add('screen-mode');
      this.dom.localPip.classList.remove('hidden');
      this.dom.localVideo.srcObject = new MediaStream([
        this.localScreenTrack.getMediaStreamTrack()
      ]);

      this.localScreenTrack.on('track-ended', () => {
        if (this.screenSharing) {
          this.stopScreenShare();
        }
      });

      this.updateControlButtons();
      this.emitMediaState();
    } catch (err) {
      if (this.localScreenTrack) {
        this.localScreenTrack.stop();
        this.localScreenTrack.close();
        this.localScreenTrack = null;
      }
      if (err.code !== 'PERMISSION_DENIED' && err.name !== 'AbortError') {
        this.showToast('Screen share was cancelled or blocked.', 'info');
      }
    }
  }

  async stopScreenShare() {
    if (this.client && this.publishedVideoType === 'screen' && this.localScreenTrack) {
      await this.client.unpublish(this.localScreenTrack).catch(() => {});
      this.publishedVideoType = null;
    }
    if (this.localScreenTrack) {
      this.localScreenTrack.stop();
      this.localScreenTrack.close();
      this.localScreenTrack = null;
    }

    this.screenSharing = false;
    this.dom.localPip.classList.remove('screen-mode');

    if (this.client && this.camEnabled && this.localVideoTrack) {
      await this.client.publish(this.localVideoTrack).catch(() => {});
      this.publishedVideoType = 'camera';
    }

    this.syncLocalPreview();
    this.updateControlButtons();
    this.emitMediaState();
  }

  emitMediaState() {
    if (!this.activeCall) return;
    this.socket.emit('call:media-state', {
      to: this.activeCall.peer.id,
      micEnabled: this.micEnabled,
      camEnabled: this.camEnabled,
      screenSharing: this.screenSharing
    });
  }

  openCallStage(peer, stateText, subText) {
    this.dom.peerAvatar.textContent = peer.avatar;
    this.dom.peerAvatar.style.background = peer.color;
    this.dom.peerName.textContent = peer.name;

    this.dom.stageAvatar.textContent = peer.avatar;
    this.dom.stageAvatar.style.background = peer.color;
    this.dom.stageName.textContent = peer.name;

    this.updateStageStatus(stateText, subText);
    this.dom.timer.textContent = '00:00';
    this.dom.miniHeaderTimer.textContent = '00:00';
    this.dom.peerBadges.innerHTML = '';
    this.refreshRemoteVideoVisibility(false);

    this.isMinimized = false;
    this.dom.btnRestore.classList.add('hidden');
    this.dom.overlay.classList.remove('hidden');
  }

  updateStageStatus(stateText, subText) {
    this.dom.stateLabel.textContent = stateText;
    if (subText) this.dom.stageSubtext.textContent = subText;
  }

  syncLocalPreview() {
    if (this.screenSharing) return;
    if (this.camEnabled && this.localVideoTrack) {
      this.dom.localVideo.srcObject = new MediaStream([
        this.localVideoTrack.getMediaStreamTrack()
      ]);
      this.dom.localPip.classList.remove('hidden');
    } else {
      this.dom.localVideo.srcObject = null;
      this.dom.localPip.classList.add('hidden');
    }
  }

  refreshRemoteVideoVisibility(showVideo) {
    const hasRemoteVideo = Boolean(this.remoteVideoTrack && this.dom.remoteVideo.srcObject);
    if (showVideo && hasRemoteVideo) {
      this.dom.remoteVideo.classList.remove('hidden');
      this.dom.avatarStage.classList.add('hidden');
    } else {
      this.dom.remoteVideo.classList.add('hidden');
      this.dom.avatarStage.classList.remove('hidden');
    }
  }

  renderPeerMediaBadges({ micEnabled, camEnabled, screenSharing }) {
    const badges = [];
    if (micEnabled === false) badges.push('<span class="media-pill">Peer Muted</span>');
    if (camEnabled === false && !screenSharing) {
      badges.push('<span class="media-pill">Camera Off</span>');
    }
    if (screenSharing) {
      badges.push('<span class="media-pill" style="color:#67e8f9">Sharing Screen</span>');
    }
    this.dom.peerBadges.innerHTML = badges.join('');
  }

  updateControlButtons() {
    this.setToggleButtonState(this.dom.btnMic, this.micEnabled);
    this.setToggleButtonState(this.dom.btnCam, this.camEnabled);
    this.dom.btnShare.classList.toggle('active-feature', this.screenSharing);
  }

  setToggleButtonState(btn, isOn) {
    const onIcon = btn.querySelector('.icon-on');
    const offIcon = btn.querySelector('.icon-off');
    btn.classList.toggle('muted', !isOn);
    if (onIcon && offIcon) {
      onIcon.classList.toggle('hidden', !isOn);
      offIcon.classList.toggle('hidden', isOn);
    }
  }

  setMinimized(minimized) {
    if (!this.activeCall) return;
    this.isMinimized = minimized;
    this.dom.overlay.classList.toggle('hidden', minimized);
    this.dom.btnRestore.classList.toggle('hidden', !minimized);
  }

  startTimer() {
    if (this.timerInterval) return;
    this.callStartedAt = Date.now();
    this.timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - this.callStartedAt) / 1000);
      const mins = String(Math.floor(sec / 60)).padStart(2, '0');
      const rem = String(sec % 60).padStart(2, '0');
      const formatted = `${mins}:${rem}`;
      this.dom.timer.textContent = formatted;
      this.dom.miniHeaderTimer.textContent = formatted;
    }, 1000);
  }

  cleanupCall() {
    soundFX.stopRingtone();
    if (this.ringTimeout) {
      clearTimeout(this.ringTimeout);
      this.ringTimeout = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    if (this.localScreenTrack) {
      this.localScreenTrack.stop();
      this.localScreenTrack.close();
      this.localScreenTrack = null;
    }
    if (this.localAudioTrack) {
      this.localAudioTrack.stop();
      this.localAudioTrack.close();
      this.localAudioTrack = null;
    }
    if (this.localVideoTrack) {
      this.localVideoTrack.stop();
      this.localVideoTrack.close();
      this.localVideoTrack = null;
    }
    if (this.client) {
      const oldClient = this.client;
      this.client = null;
      oldClient.leave().catch(() => {});
    }

    this.remoteAudioTrack = null;
    this.remoteVideoTrack = null;
    this.publishedAudio = false;
    this.publishedVideoType = null;
    this.activeCall = null;
    this.micEnabled = true;
    this.camEnabled = false;
    this.screenSharing = false;
    this.isMinimized = false;

    this.dom.remoteVideo.srcObject = null;
    this.dom.remoteAudio.srcObject = null;
    this.dom.localVideo.srcObject = null;
    this.dom.localPip.classList.remove('screen-mode');
    this.dom.overlay.classList.add('hidden');
    this.dom.btnRestore.classList.add('hidden');
    this.dom.incomingModal.classList.add('hidden');
    this.onCallStateChange?.(false);
  }
}
