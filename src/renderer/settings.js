'use strict';

(function () {
  const api = window.niboSettings;
  const $ = (id) => document.getElementById(id);

  const ENGINE_NAMES = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' };

  const keyInput = $('key');
  const status = $('key-status');
  const model = $('model');
  const models = $('models');

  function setStatus(text, kind, el = status) {
    el.textContent = text;
    el.className = `status ${kind || ''}`;
  }

  function fillModels(ids) {
    models.textContent = '';
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      models.append(opt);
    }
  }

  async function load() {
    const s = await api.get();
    if (!s) return;

    const storageNote = s.encrypted ? '' : " (Note: secure key storage isn't available on this system.)";
    if (s.hasKey) {
      const from = s.keySource === 'env' ? ' (from the GROQ_API_KEY environment variable)' : '';
      keyInput.placeholder = `Saved: ${s.keyHint}${from} — paste a new key to replace it`;
      setStatus(`🔑 A key is saved. Nibo is extra smart!${storageNote}`, 'ok');
      $('remove-row').hidden = s.keySource !== 'settings';
    } else {
      setStatus(`No key yet — Nibo is using his little offline bunny brain.${storageNote}`, '');
    }

    model.value = s.model;
    model.placeholder = s.defaultModel;
    fillModels([s.defaultModel, 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);

    const engine = $('engine');
    for (const id of s.searchEngines) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = ENGINE_NAMES[id] || id;
      engine.append(opt);
    }
    engine.value = s.searchEngine;

    if (s.hasTavily) {
      const from = s.tavilySource === 'env' ? ' (from the TAVILY_API_KEY environment variable)' : '';
      $('tavily-key').placeholder = `Saved: ${s.tavilyHint}${from}`;
      setStatus('🔎 Web search is on!', 'ok', $('tavily-status'));
      $('remove-tavily-row').hidden = s.tavilySource !== 'settings';
    } else {
      setStatus('No key yet: "search for…" opens your browser instead.', '', $('tavily-status'));
    }
    $('auto-search').checked = s.autoSearch;
    $('mic-sensitivity').value = s.micSensitivity;
    $('barge-in').checked = s.bargeIn;
    $('hotkey-hint').textContent = s.hotkey ? `(or press ${s.hotkey}) ` : '';
    $('voice').checked = s.voice;
    $('boil').checked = s.boil;
    $('check-updates').checked = s.checkUpdates;
    $('startup-row').hidden = !s.canStartWithSystem;
    $('startup').checked = s.startWithSystem;
    $('version').textContent = `Nibo AI v${s.version}`;
  }

  $('test').addEventListener('click', async () => {
    const btn = $('test');
    btn.disabled = true;
    setStatus('Sniffing the key... 🐽', '');
    try {
      const res = await api.testKey(keyInput.value);
      if (res && res.ok) {
        setStatus(`✓ It works! ${res.models.length} models available.`, 'ok');
        if (res.models.length) fillModels(res.models);
      } else {
        setStatus(res && res.error ? res.error : "Hmm, that key didn't work.", 'bad');
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('test-tavily').addEventListener('click', async () => {
    const btn = $('test-tavily');
    btn.disabled = true;
    setStatus('Trying a tiny search... 🔎', '', $('tavily-status'));
    try {
      const res = await api.testTavily($('tavily-key').value);
      if (res && res.ok) setStatus('✓ It works! Nibo can search the web.', 'ok', $('tavily-status'));
      else setStatus(res && res.error ? res.error : "Hmm, that key didn't work.", 'bad', $('tavily-status'));
    } finally {
      btn.disabled = false;
    }
  });

  $('save').addEventListener('click', async () => {
    const patch = {
      model: model.value.trim() || model.placeholder,
      searchEngine: $('engine').value,
      voice: $('voice').checked,
      boil: $('boil').checked,
      autoSearch: $('auto-search').checked,
      bargeIn: $('barge-in').checked,
      checkUpdates: $('check-updates').checked,
      micSensitivity: $('mic-sensitivity').value,
    };
    if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();
    if ($('remove-key').checked) patch.removeKey = true;
    if ($('tavily-key').value.trim()) patch.tavilyKey = $('tavily-key').value.trim();
    if ($('remove-tavily').checked) patch.removeTavilyKey = true;
    if (!$('startup-row').hidden) patch.startWithSystem = $('startup').checked;
    const res = await api.save(patch);
    if (res && res.ok) api.close();
    else setStatus('Could not save settings. 😿', 'bad');
  });

  $('cancel').addEventListener('click', () => api.close());

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.dataset.href);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.close();
  });

  load();
})();
