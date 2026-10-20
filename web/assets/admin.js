// Admin panel: first-run setup, login, ingest settings for StudioMix, channel
// details, privacy and chat moderation.
(() => {
  const $ = (s) => document.querySelector(s);
  let state = null;
  let timer = 0;

  async function api(action, body) {
    const res = await fetch(`/admin/api/${action}`, body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {});
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      show('login');
      throw new Error(data.error || 'Inicia sesión');
    }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function show(view) {
    for (const id of ['setup', 'login', 'dashboard']) $(`#${id}`).hidden = id !== view;
    $('#btn-logout').hidden = view !== 'dashboard';
    clearInterval(timer);
    if (view === 'dashboard') {
      refresh();
      timer = setInterval(refresh, 2000);
    }
  }

  const flash = (el, text) => {
    el.textContent = text;
    setTimeout(() => {
      el.textContent = '';
    }, 2500);
  };

  function render() {
    const s = state;
    $('#live-badge').textContent = s.live ? 'EN DIRECTO' : 'SIN EMISIÓN';
    $('#live-badge').classList.toggle('live', s.live);
    $('#stat-live').textContent = s.live ? 'En directo' : 'Sin señal';
    $('#stat-live').style.color = s.live ? 'var(--live)' : '';
    $('#stat-viewers').textContent = s.viewers;
    $('#stat-tracks').textContent = s.live && s.stats.tracks?.length ? `Recibiendo: ${s.stats.tracks.join(', ')} · ${s.stats.readers} reproductores conectados` : '';
    $('#rtmp-server').textContent = s.ingest.rtmpServer;
    $('#stream-key').textContent = s.streamKey;
    $('#rtmp-url').textContent = s.ingest.rtmpUrl;
    $('#srt-url').textContent = s.ingest.srtUrl;
    $('#viewer-url').textContent = s.viewerUrl;
    // Don't overwrite what the operator is typing.
    if (!$('#channel-form').contains(document.activeElement)) {
      $('#ch-title').value = s.title;
      $('#ch-description').value = s.description;
      $('#ch-host').value = s.publicHost;
    }
    if (!$('#privacy-form').contains(document.activeElement)) $('#pv-private').checked = s.private;

    const list = $('#mod-list');
    const items = [...s.chat].reverse().map((m) => {
      const li = document.createElement('li');
      const text = document.createElement('span');
      const nick = document.createElement('strong');
      nick.textContent = `${m.nick}: `;
      text.append(nick, document.createTextNode(m.text));
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Borrar';
      del.onclick = () => api('chat-delete', { id: m.id }).then(refresh);
      const ban = document.createElement('button');
      ban.type = 'button';
      ban.className = 'danger';
      ban.textContent = 'Bloquear';
      ban.title = 'Borra sus mensajes y no le deja escribir más';
      ban.onclick = () => confirm(`¿Bloquear a «${m.nick}» en el chat?`) && api('chat-ban', { id: m.id }).then(refresh);
      li.append(text, del, ban);
      return li;
    });
    list.replaceChildren(...items);
    $('#mod-empty').hidden = items.length > 0;
  }

  async function refresh() {
    try {
      state = await api('state');
      render();
    } catch (err) {
      console.warn(err.message);
    }
  }

  async function start() {
    const status = await api('status');
    show(status.needsSetup ? 'setup' : status.loggedIn ? 'dashboard' : 'login');
  }

  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('setup', { code: $('#setup-code').value, password: $('#setup-password').value });
      show('dashboard');
    } catch (err) {
      $('#setup-error').textContent = err.message;
    }
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('login', { password: $('#login-password').value });
      $('#login-password').value = '';
      show('dashboard');
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api('logout', {});
    show('login');
  });

  $('#channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('channel', { title: $('#ch-title').value, description: $('#ch-description').value, publicHost: $('#ch-host').value });
      document.activeElement.blur();
      flash($('#channel-msg'), 'Guardado');
      refresh();
    } catch (err) {
      flash($('#channel-msg'), err.message);
    }
  });

  $('#privacy-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#privacy-error').textContent = '';
    try {
      await api('privacy', { private: $('#pv-private').checked, password: $('#pv-password').value || undefined });
      $('#pv-password').value = '';
      document.activeElement.blur();
      flash($('#privacy-msg'), 'Guardado');
      refresh();
    } catch (err) {
      $('#privacy-error').textContent = err.message;
    }
  });

  $('#btn-regenerate').addEventListener('click', async () => {
    if (!confirm('Se cortará la emisión en curso y tendrás que poner la clave nueva en StudioMix. ¿Cambiarla?')) return;
    await api('regenerate-key', {});
    refresh();
  });

  $('#btn-clear').addEventListener('click', async () => {
    if (confirm('¿Borrar todos los mensajes del chat?')) await api('chat-clear', {});
    refresh();
  });

  document.addEventListener('click', (e) => {
    const id = e.target.dataset?.copy;
    if (!id) return;
    navigator.clipboard.writeText($(`#${id}`).textContent).then(() => {
      const old = e.target.textContent;
      e.target.textContent = 'Copiado';
      setTimeout(() => {
        e.target.textContent = old;
      }, 1200);
    });
  });

  start().catch((err) => {
    document.body.textContent = `No se pudo cargar el panel: ${err.message}`;
  });
})();
