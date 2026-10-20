// Viewer page: plays the stream over WebRTC (WHEP), follows the live state and
// the chat over Server-Sent Events, and handles private channels.
(() => {
  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  let channel = null;
  let pc = null;
  let session = null;
  let retryTimer = 0;
  let events = null;

  const api = async (url, body) => {
    const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  };

  // --- player (WHEP) -------------------------------------------------------

  function waitForIce(peer) {
    // Send the offer with its candidates; don't wait forever on odd networks.
    return new Promise((resolve) => {
      if (peer.iceGatheringState === 'complete') return resolve();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 1500);
      peer.addEventListener('icegatheringstatechange', () => peer.iceGatheringState === 'complete' && done());
    });
  }

  function stopPlayer() {
    clearTimeout(retryTimer);
    if (session) fetch(session, { method: 'DELETE' }).catch(() => {});
    session = null;
    pc?.close();
    pc = null;
    video.srcObject = null;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (channel?.live && channel.canWatch) retryTimer = setTimeout(startPlayer, 3000);
  }

  async function startPlayer() {
    stopPlayer();
    if (!channel?.live || !channel.canWatch) return;
    const peer = new RTCPeerConnection();
    pc = peer;
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.ontrack = (e) => {
      if (!video.srcObject) video.srcObject = new MediaStream();
      video.srcObject.addTrack(e.track);
      video.play().catch(() => {});
      $('#btn-sound').hidden = !video.muted;
    };
    peer.onconnectionstatechange = () => {
      if (pc !== peer) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') scheduleRetry();
      if (peer.connectionState === 'disconnected') setTimeout(() => pc === peer && peer.connectionState === 'disconnected' && scheduleRetry(), 4000);
    };
    try {
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);
      const res = await fetch('/whep', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: peer.localDescription.sdp });
      if (pc !== peer) return;
      if (!res.ok) throw new Error(`WHEP ${res.status}`);
      session = res.headers.get('Location');
      await peer.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    } catch (err) {
      console.warn('No se pudo conectar el vídeo:', err.message);
      scheduleRetry();
    }
  }

  // --- channel state ---------------------------------------------------------

  function render() {
    document.title = channel.title;
    $('#title').textContent = channel.title;
    $('#description').textContent = channel.description || '';
    $('#live-badge').textContent = channel.live ? 'EN DIRECTO' : 'SIN EMISIÓN';
    $('#live-badge').classList.toggle('live', channel.live);
    $('#viewers').textContent = `👁 ${channel.viewers ?? 0}`;
    $('#lock').hidden = channel.canWatch;
    $('#offline').hidden = !channel.canWatch || channel.live;
    $('#chat-form').hidden = !channel.canWatch;
  }

  function addMessage(m) {
    const li = document.createElement('li');
    li.dataset.id = m.id;
    const nick = document.createElement('strong');
    nick.textContent = m.nick;
    const text = document.createElement('span');
    text.textContent = ` ${m.text}`;
    li.append(nick, text);
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(li);
    while (box.children.length > 200) box.firstElementChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function connectEvents() {
    events?.close();
    events = new EventSource('/api/events');
    events.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      $('#messages').replaceChildren();
      d.messages.forEach(addMessage);
      const wasLive = channel.live;
      Object.assign(channel, { live: d.status.live, viewers: d.viewers });
      render();
      if (channel.live && (!wasLive || !pc)) startPlayer();
    });
    events.addEventListener('status', (e) => {
      const live = JSON.parse(e.data).live;
      if (live === channel.live) return;
      channel.live = live;
      render();
      if (live) startPlayer();
      else stopPlayer();
    });
    events.addEventListener('viewers', (e) => {
      channel.viewers = JSON.parse(e.data).viewers;
      render();
    });
    events.addEventListener('message', (e) => addMessage(JSON.parse(e.data)));
    events.addEventListener('delete', (e) => document.querySelector(`#messages [data-id="${JSON.parse(e.data).id}"]`)?.remove());
    events.addEventListener('clear', () => $('#messages').replaceChildren());
    events.addEventListener('channel', async () => {
      // Title, description or privacy changed: reload what applies to us.
      channel = await api('/api/channel');
      render();
      if (!channel.canWatch) {
        stopPlayer();
        events.close();
      }
    });
  }

  async function load() {
    channel = await api('/api/channel');
    render();
    if (channel.canWatch) connectEvents();
  }

  // --- interactions ------------------------------------------------------------

  $('#unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#unlock-error').textContent = '';
    try {
      await api('/api/unlock', { password: $('#unlock-password').value });
      $('#unlock-password').value = '';
      await load();
    } catch (err) {
      $('#unlock-error').textContent = err.message;
    }
  });

  const nick = $('#nick');
  try {
    nick.value = localStorage.getItem('sl.nick') || '';
  } catch {
    // Storage blocked: the name just isn't remembered.
  }
  nick.addEventListener('change', () => {
    try {
      localStorage.setItem('sl.nick', nick.value.trim());
    } catch {
      // Storage blocked.
    }
  });

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#text');
    $('#chat-error').textContent = '';
    try {
      await api('/api/chat', { nick: nick.value, text: text.value });
      text.value = '';
    } catch (err) {
      $('#chat-error').textContent = err.message;
    }
  });

  $('#btn-sound').addEventListener('click', () => {
    video.muted = false;
    video.play().catch(() => {});
    $('#btn-sound').hidden = true;
  });
  $('#btn-full').addEventListener('click', () => {
    const player = $('#player');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  });

  load().catch((err) => {
    $('#title').textContent = 'No se pudo cargar el canal';
    console.error(err);
  });
})();
