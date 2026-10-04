'use strict';

(function () {
  const nibo = window.nibo;
  const bubble = window.NiboBubble;
  const $ = (id) => document.getElementById(id);

  const pose = $('pose');
  const wrap = $('nibo-wrap');
  const fx = $('fx');
  const input = $('ask');
  const form = $('prompt');
  const menu = $('menu');
  const presetBtn = $('preset-btn');
  const feedBtn = $('feed-btn');
  const voiceBtn = $('voice-btn');
  const undoTidyBtn = $('undo-tidy-btn');
  const eyesLook = $('eyes-look');
  const noise = $('sketchy-noise');

  // Where Nibo's eyes and mouth are, in window coordinates.
  const EYES = { x: 180, y: 362 };
  const MOUTH = { x: 180, y: 392 };
  const HEAD = { x: 180, y: 320 };

  const JOKE_TOPICS = ['bunnies', 'carrots', 'computers', 'space', 'cats', 'coffee', 'dinosaurs', 'the ocean', 'pizza', 'robots', 'music', 'math'];
  const FACT_TOPICS = ['animals', 'space', 'the human body', 'history', 'food', 'the ocean', 'inventions', 'rabbits', 'weather', 'plants'];

  let state = null;
  let lines = { greetings: [], hungry: [], fed: [], stuffed: [], poke: [] };

  const face = { thinking: false, talking: false, munching: false, sleeping: false, held: false, expr: null };
  let exprTimer = null;
  let talkTimer = null;

  let reqSeq = 0;
  let currentReq = null;
  let gotDelta = false;
  let promptMode = null; // 'search' | 'app': what the prompt bar is asking for
  let feeding = false;
  let hovering = false;
  let ignoring = null;
  let pressed = null;
  let dragging = false;
  let uiTimer = null;
  let lookOverride = null;
  let lastLook = '';
  let lastCursor = { x: EYES.x, y: 600 };
  let lastInteraction = Date.now();
  let lastHungryNag = 0;
  let zTimer = null;
  let danceTimer = null;
  let noteTimer = null;

  const pick = (list) => (list && list.length ? list[Math.floor(Math.random() * list.length)] : '');
  const rand = (a, b) => a + Math.random() * (b - a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const touch = () => (lastInteraction = Date.now());

  // ---------- face ----------

  function renderFace() {
    const mood = state ? state.mood : 'okay';
    let eyes = 'open';
    let mouth = 'w';
    let brows = 'off';
    let cheeks = 'normal';

    if (mood === 'hungry' || mood === 'sad') {
      brows = 'on';
      mouth = 'sad';
    }
    if (face.talking || tts.active) mouth = 'talk';
    if (face.expr) {
      if (face.expr.eyes || face.expr.mouth) brows = 'off';
      eyes = face.expr.eyes || eyes;
      mouth = face.expr.mouth || mouth;
      brows = face.expr.brows || brows;
      cheeks = face.expr.cheeks || cheeks;
    }
    if (face.munching) {
      eyes = 'happy';
      mouth = 'munch';
      brows = 'off';
      cheeks = 'puff';
    }
    if (face.held) {
      eyes = 'wide';
      mouth = 'o';
      brows = 'off';
    }
    if (face.sleeping) {
      eyes = 'closed';
      mouth = 'w';
      brows = 'off';
    }

    pose.dataset.eyes = eyes;
    pose.dataset.mouth = mouth;
    pose.dataset.brows = brows;
    pose.dataset.cheeks = cheeks;
    setBoil(face.talking || tts.active || face.munching || pose.classList.contains('dance') || face.held);
  }

  // Temporary expression; ms = 0 keeps it until the next express()/hold().
  function express(expr, ms = 1600) {
    face.expr = expr;
    renderFace();
    clearTimeout(exprTimer);
    if (!ms) return;
    exprTimer = setTimeout(() => {
      face.expr = null;
      renderFace();
    }, ms);
  }

  const hold = (expr) => express(expr, 0);

  function talkFor(ms) {
    face.talking = true;
    renderFace();
    clearTimeout(talkTimer);
    talkTimer = setTimeout(() => {
      face.talking = false;
      renderFace();
    }, ms);
  }

  // "Line boil": re-seed the sketchy filter so outlines wiggle like a cartoon.
  let boilTimer = null;
  let boilSeed = 2;
  function setBoil(on) {
    const enabled = on && (!state || state.settings.boil !== false);
    if (enabled && !boilTimer) {
      boilTimer = setInterval(() => {
        boilSeed = (boilSeed % 4) + 1;
        noise.setAttribute('seed', String(boilSeed));
      }, 150);
    } else if (!enabled && boilTimer) {
      clearInterval(boilTimer);
      boilTimer = null;
    }
  }

  function flash(cls, ms) {
    pose.classList.remove(cls);
    void pose.offsetWidth; // restart the CSS animation
    pose.classList.add(cls);
    setTimeout(() => pose.classList.remove(cls), ms);
  }

  const playPose = flash;
  const twitch = () => flash(Math.random() < 0.5 ? 'twitch-l' : 'twitch-r', 520);
  const wave = () => flash('wave', 1700);

  function blinkLoop() {
    setTimeout(() => {
      if (!face.sleeping) {
        pose.classList.add('blink');
        setTimeout(() => pose.classList.remove('blink'), 110);
        if (Math.random() < 0.2) {
          setTimeout(() => pose.classList.add('blink'), 260);
          setTimeout(() => pose.classList.remove('blink'), 370);
        }
      }
      blinkLoop();
    }, rand(2200, 5600));
  }

  function lookAt(x, y) {
    if (lookOverride) ({ x, y } = lookOverride);
    const dx = x - EYES.x;
    const dy = y - EYES.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / 140);
    // Rounded to half units so tiny mouse moves don't trigger repaints.
    const tx = Math.round((dx / d) * 4 * k * 2) / 2;
    const ty = Math.round((dy / d) * 3.5 * k * 2) / 2;
    const t = `translate(${tx} ${ty})`;
    if (t !== lastLook) {
      lastLook = t;
      eyesLook.setAttribute('transform', t);
    }
  }

  function glance(target, ms = 1300) {
    lookOverride = target || { x: EYES.x + rand(-200, 200), y: EYES.y + rand(-160, 60) };
    lookAt(0, 0);
    setTimeout(() => {
      lookOverride = null;
      lookAt(lastCursor.x, lastCursor.y);
    }, ms);
  }

  // ---------- effects ----------

  const SVGNS = 'http://www.w3.org/2000/svg';

  function icon(viewBox, parts, size) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    for (const [tag, attrs] of parts) {
      const n = document.createElementNS(SVGNS, tag);
      for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      s.append(n);
    }
    return s;
  }

  const INK = '#3b2c5a';
  const heartIcon = (size, color = '#ff7faf') =>
    icon(
      '0 0 24 24',
      [
        [
          'path',
          {
            d: 'M12 21 C 4 14.5, 1.5 9.5, 5.5 5.6 C 8.6 2.8, 11.6 4.6, 12 7.6 C 12.4 4.6, 15.4 2.8, 18.5 5.6 C 22.5 9.5, 20 14.5, 12 21 Z',
            fill: color,
            stroke: INK,
            'stroke-width': '1.6',
            'stroke-linejoin': 'round',
          },
        ],
      ],
      size,
    );

  const sparkleIcon = (size, color = '#ffd34d') =>
    icon(
      '0 0 24 24',
      [
        [
          'path',
          {
            d: 'M12 1 C 13 8, 16 11, 23 12 C 16 13, 13 16, 12 23 C 11 16, 8 13, 1 12 C 8 11, 11 8, 12 1 Z',
            fill: color,
            stroke: INK,
            'stroke-width': '1.4',
            'stroke-linejoin': 'round',
          },
        ],
      ],
      size,
    );

  const carrotIcon = (size) =>
    icon(
      '0 0 40 40',
      [
        ['path', { d: 'M 23 12 C 27 6, 33 6, 36 3 M 23 12 C 24 6, 22 3, 25 0 M 23 12 C 29 10, 33 13, 39 11', stroke: '#3faa5a', 'stroke-width': '3', fill: 'none', 'stroke-linecap': 'round' }],
        ['path', { d: 'M 25 10 C 31 14, 31 20, 27 24 L 7 36 C 4 38, 1.5 35.5, 3.5 33 L 17 12 C 20 8, 23 8, 25 10 Z', fill: '#ff9a3c', stroke: INK, 'stroke-width': '2', 'stroke-linejoin': 'round' }],
        ['path', { d: 'M 13 21 l 4 2 M 17 16 l 4 2 M 10 27 l 3 2', stroke: INK, 'stroke-width': '1.5', 'stroke-linecap': 'round', fill: 'none' }],
      ],
      size,
    );

  function spawn(node, x, y, keyframes, duration, easing = 'ease-out') {
    const el = document.createElement('div');
    el.className = 'fx';
    el.append(node);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    fx.append(el);
    const anim = el.animate(keyframes, { duration, easing, fill: 'forwards' });
    anim.onfinish = () => el.remove();
    return anim;
  }

  function spawnText(text, x, y, { size = 22, dx = 0, dy = -80, duration = 1800, color } = {}) {
    const span = document.createElement('span');
    span.className = 'fx-text';
    span.textContent = text;
    span.style.fontSize = `${size}px`;
    if (color) span.style.color = color;
    return spawn(
      span,
      x,
      y,
      [
        { transform: 'translate(0, 0) scale(0.6)', opacity: 0 },
        { transform: `translate(${dx * 0.3}px, ${dy * 0.25}px) scale(1)`, opacity: 1, offset: 0.25 },
        { transform: `translate(${dx}px, ${dy}px) scale(1.1)`, opacity: 0 },
      ],
      duration,
    );
  }

  function hearts(n = 5) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const x = HEAD.x + rand(-70, 50);
        const y = HEAD.y + rand(-10, 30);
        spawn(
          heartIcon(rand(16, 27), Math.random() < 0.3 ? '#b07cf0' : '#ff7faf'),
          x,
          y,
          [
            { transform: 'translate(0, 0) scale(0.3)', opacity: 0 },
            { transform: `translate(${rand(-8, 8)}px, -26px) scale(1)`, opacity: 1, offset: 0.2 },
            { transform: `translate(${rand(-34, 34)}px, -130px) scale(0.85)`, opacity: 0 },
          ],
          rand(1500, 2100),
        );
      }, i * 140);
    }
  }

  function sparkles(n = 6) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const x = HEAD.x + rand(-110, 90);
        const y = HEAD.y + rand(-60, 150);
        spawn(
          sparkleIcon(rand(12, 22), pick(['#ffd34d', '#8ee6cf', '#ffb3cf'])),
          x,
          y,
          [
            { transform: 'scale(0) rotate(0deg)', opacity: 0 },
            { transform: 'scale(1.1) rotate(45deg)', opacity: 1, offset: 0.4 },
            { transform: 'scale(0) rotate(90deg)', opacity: 0 },
          ],
          900,
        );
      }, i * 90);
    }
  }

  function crumbs() {
    for (let i = 0; i < 7; i++) {
      setTimeout(() => {
        const dot = document.createElement('span');
        dot.className = 'fx-text';
        dot.textContent = '•';
        dot.style.color = i % 3 ? '#ff9a3c' : '#3faa5a';
        dot.style.fontSize = `${rand(12, 18)}px`;
        spawn(
          dot,
          MOUTH.x + rand(-14, 10),
          MOUTH.y - 6,
          [
            { transform: 'translate(0, 0)', opacity: 1 },
            { transform: `translate(${rand(-40, 40)}px, ${rand(60, 110)}px)`, opacity: 0 },
          ],
          rand(700, 1000),
          'cubic-bezier(.3,.1,.8,.6)',
        );
      }, i * 180);
    }
  }

  function musicNote() {
    spawnText(pick(['♪', '♫', '♬']), HEAD.x + rand(-110, 80), HEAD.y + rand(0, 60), {
      size: rand(20, 30),
      dx: rand(-30, 30),
      dy: -100,
      duration: 1600,
      color: pick(['#7a5cd6', '#ff7faf', '#3faa8a']),
    });
  }

  async function throwCarrot() {
    const r = feedBtn.getBoundingClientRect();
    const visible = document.body.classList.contains('show-ui');
    const sx = visible ? r.left + r.width / 2 - 20 : MOUTH.x + 110;
    const sy = visible ? r.top - 12 : MOUTH.y + 70;
    const tx = MOUTH.x - 22;
    const ty = MOUTH.y - 22;
    const anim = spawn(
      carrotIcon(40),
      sx,
      sy,
      [
        { transform: 'translate(0, 0) rotate(0deg) scale(0.6)' },
        { transform: `translate(${(tx - sx) / 2}px, ${ty - sy - 90}px) rotate(160deg) scale(1)`, offset: 0.55 },
        { transform: `translate(${tx - sx}px, ${ty - sy}px) rotate(300deg) scale(0.65)`, opacity: 1 },
      ],
      650,
      'ease-in-out',
    );
    await anim.finished.catch(() => {});
  }

  function startZzz() {
    stopZzz();
    zTimer = setInterval(() => {
      spawnText('z', HEAD.x + 52 + rand(-4, 4), HEAD.y + 10, { size: rand(16, 28), dx: rand(20, 45), dy: -80, duration: 2300 });
    }, 1100);
  }

  function stopZzz() {
    clearInterval(zTimer);
    zTimer = null;
  }

  // ---------- Nibo's voice (text to speech) ----------

  // Speech is queued one sentence at a time, so Nibo can start talking while
  // an answer is still streaming in, and stop instantly when interrupted.
  //
  // On Windows each sentence is rendered by the Windows voice in the main
  // process and played here, through Chromium, so the microphone's echo
  // cancellation can remove Nibo's own voice and the user can talk over him.
  // Elsewhere (or if that fails) the Web Speech API speaks instead.
  const tts = { queue: 0, buffer: '', active: false, log: [], gen: 0, utterances: new Set() };
  const player = { ctx: null, gain: null, source: null, chain: Promise.resolve(), duckTimer: 0 };
  const SQUEAK = 1.22; // play the Windows voice a little faster and higher: bunny-sized
  const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|\n+/g;

  function pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((v) => /^en/i.test(v.lang) && /zira|aria|jenny|samantha|female/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      null
    );
  }

  function cleanForSpeech(text) {
    return bubble
      .tidy(text)
      .replace(/https?:\/\/\S+/g, 'a link')
      .replace(/\*[^*\n]+\*/g, '')
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
      .replace(/^\s*-\s+/gm, '')
      .trim();
  }

  // "Speaking" lasts from the first sound until the queue runs dry.
  function setSpeaking(on) {
    if (tts.active === on) return;
    tts.active = on;
    if (ears) ears.setNiboSpeaking(on);
    renderFace();
  }

  function sentenceDone(gen) {
    if (gen !== tts.gen) return;
    tts.queue = Math.max(0, tts.queue - 1);
    if (!tts.queue) setSpeaking(false);
  }

  function speakSentence(sentence) {
    const clean = cleanForSpeech(sentence);
    if (!clean) return;
    const gen = tts.gen;
    tts.queue++;
    tts.log.push({ text: clean, at: Date.now() });
    if (state && state.settings.nativeVoice) {
      const audio = nibo.tts(clean).catch(() => null); // start rendering right away
      player.chain = player.chain
        .then(async () => {
          if (gen !== tts.gen) return;
          const res = await audio;
          if (gen !== tts.gen) return;
          if (res && res.ok) await playPcm(res, gen);
          else await speakWithBrowser(clean, gen);
        })
        .catch(() => {})
        .finally(() => sentenceDone(gen));
    } else {
      speakWithBrowser(clean, gen).finally(() => sentenceDone(gen));
    }
  }

  function ensurePlayer() {
    if (!player.ctx) {
      player.ctx = new AudioContext();
      player.gain = player.ctx.createGain();
      player.gain.connect(player.ctx.destination);
    }
    if (player.ctx.state === 'suspended') player.ctx.resume().catch(() => {});
    return player.ctx;
  }

  // Play 16-bit mono PCM from the Windows voice. Resolves when it ends or is stopped.
  function playPcm({ pcm, sampleRate }, gen) {
    return new Promise((resolve) => {
      const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
      const frames = Math.floor(bytes.byteLength / 2);
      if (gen !== tts.gen || !frames) return resolve();
      const ctx = ensurePlayer();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const buffer = ctx.createBuffer(1, frames, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = view.getInt16(i * 2, true) / 32768;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = SQUEAK;
      source.connect(player.gain);
      source.onended = () => {
        if (player.source === source) player.source = null;
        resolve();
      };
      player.source = source;
      player.gain.gain.cancelScheduledValues(ctx.currentTime);
      player.gain.gain.setValueAtTime(1, ctx.currentTime);
      source.start();
      setSpeaking(true);
    });
  }

  // Web Speech API fallback. Resolves when the sentence is done (or stopped).
  function speakWithBrowser(text, gen) {
    return new Promise((resolve) => {
      if (gen !== tts.gen || !('speechSynthesis' in window)) return resolve();
      const synth = window.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text.slice(0, 400));
      u.pitch = 1.8;
      u.rate = 1.08;
      const voice = pickVoice();
      if (voice) u.voice = voice;
      // Chromium can skip the end event of an utterance it has garbage-collected,
      // so keep a reference, and stop waiting once the engine has gone quiet.
      tts.utterances.add(u);
      let quietSince = 0;
      const watchdog = setInterval(() => {
        if (synth.speaking || synth.pending) quietSince = 0;
        else if (!quietSince) quietSince = Date.now();
        else if (Date.now() - quietSince > 1500) done();
      }, 250);
      function done() {
        clearInterval(watchdog);
        tts.utterances.delete(u);
        resolve();
      }
      u.onstart = () => gen === tts.gen && setSpeaking(true);
      u.onend = u.onerror = done;
      synth.speak(u);
    });
  }

  // Turn Nibo down the moment it sounds like the user is talking over him,
  // so the microphone can tell them apart.
  function duck() {
    if (!player.source || !player.gain) return;
    const g = player.gain.gain;
    const now = player.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0.25, now, 0.03);
    clearTimeout(player.duckTimer);
    player.duckTimer = setTimeout(() => {
      if (player.gain) player.gain.gain.setTargetAtTime(1, player.ctx.currentTime, 0.15);
    }, 600);
  }

  // Feed streamed text; complete sentences are spoken right away.
  function feedSpeech(delta) {
    tts.buffer += delta;
    let cut = 0;
    SENTENCE_END.lastIndex = 0;
    for (let m; (m = SENTENCE_END.exec(tts.buffer)); ) {
      if (m.index + m[0].length >= 12) cut = m.index + m[0].length;
    }
    if (cut) {
      speakSentence(tts.buffer.slice(0, cut));
      tts.buffer = tts.buffer.slice(cut);
    }
  }

  function flushSpeech() {
    if (tts.buffer.trim()) speakSentence(tts.buffer);
    tts.buffer = '';
  }

  function stopSpeaking() {
    tts.gen++;
    tts.buffer = '';
    tts.queue = 0;
    player.chain = Promise.resolve();
    if (player.source) {
      try {
        player.source.stop();
      } catch {
        // already stopped
      }
      player.source = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }

  function speak(text) {
    stopSpeaking();
    feedSpeech(`${text} `);
    flushSpeech();
  }

  // What Nibo said in the last few seconds (to recognize his own echo).
  function recentlySaid() {
    const cutoff = Date.now() - 20000;
    tts.log = tts.log.filter((e) => e.at > cutoff);
    return tts.log.map((e) => e.text).join(' ');
  }

  // Speak out loud when the voice setting is on, or while we're chatting by voice.
  const voiceOut = () => Boolean(state && (state.settings.voice || listening));

  // Say something with a little mouth movement (and voice, if enabled).
  function say(text, opts) {
    bubble.say(text, opts);
    if (voiceOut()) speak(text);
    else talkFor(clamp(String(text).length * 35, 600, 2600));
  }

  // Stop talking / thinking right now. Returns true if there was something to stop.
  function interrupt() {
    const busy = tts.active || tts.queue > 0 || Boolean(currentReq);
    stopSpeaking();
    if (currentReq) {
      nibo.cancel(currentReq);
      currentReq = null;
      face.thinking = false;
      face.talking = false;
      lookOverride = null;
      renderFace();
      if (gotDelta) bubble.finish();
    }
    return busy;
  }

  // ---------- chatting ----------

  let reqSpeaks = false;

  function sourceChips(sources) {
    return (sources || []).map((src) => ({ label: `🔗 ${src.site}`, action: 'open-url', arg: src.url }));
  }

  // opts: { viaVoice, heard, search }
  async function ask(text, opts = {}) {
    text = String(text || '').trim();
    if (!text) return;
    touch();
    if (face.sleeping) wake(false);
    stopSpeaking();
    if (currentReq) nibo.cancel(currentReq);

    const id = String(++reqSeq);
    currentReq = id;
    gotDelta = false;
    reqSpeaks = Boolean(opts.viaVoice) || voiceOut();
    face.thinking = true;
    face.talking = false;
    lookOverride = { x: EYES.x + 160, y: EYES.y - 200 };
    lookAt(0, 0);
    renderFace();
    twitch();
    bubble.thinking(opts.heard ? `“${opts.heard}”` : '');

    let res;
    try {
      res = await nibo.ask(id, text, { search: opts.search });
    } catch {
      res = { ok: false, error: 'Oops, my ears got tangled. Try again? 🐰' };
    }
    if (currentReq !== id) return; // a newer question (or an interruption) took over

    currentReq = null;
    face.thinking = false;
    face.talking = false;
    lookOverride = null;
    lookAt(lastCursor.x, lastCursor.y);
    renderFace();

    if (res.aborted) {
      bubble.hide();
      return;
    }
    if (!res.ok) {
      express({ brows: 'on', mouth: 'sad' }, 2600);
      bubble.say(res.error || 'Hmm, something went wrong. 🐰', { actions: res.actions });
      if (reqSpeaks) speak(res.error || 'Hmm, something went wrong.');
      return;
    }
    if (res.organize) {
      return res.organize === 'ask' ? chooseFolderToTidy() : organize(res.organize);
    }
    const actions = [...sourceChips(res.sources), ...(res.actions || [])];
    if (gotDelta) {
      bubble.finish(res.text, { actions });
      if (reqSpeaks) flushSpeech();
    } else {
      bubble.say(res.text, { actions });
      if (reqSpeaks) speak(res.text);
      else talkFor(clamp(res.text.length * 35, 600, 2600));
    }
    if (res.opened && res.opened.length) celebrateOpen();
    else if (res.searched) {
      playPose('jump', 560);
      twitch();
    }
  }

  nibo.on('nibo:delta', ({ id, delta }) => {
    if (id !== currentReq) return;
    if (!gotDelta) {
      gotDelta = true;
      face.thinking = false;
      face.talking = true;
      lookOverride = null;
      lookAt(lastCursor.x, lastCursor.y);
      renderFace();
      bubble.startStream();
    }
    bubble.append(delta);
    if (reqSpeaks) feedSpeech(delta);
  });

  // Nibo decided to look something up on the web.
  nibo.on('nibo:search-status', ({ id, query }) => {
    if (id !== currentReq) return;
    if (reqSpeaks) flushSpeech();
    gotDelta = false;
    face.talking = false;
    face.thinking = true;
    lookOverride = { x: EYES.x - 180, y: EYES.y - 220 };
    lookAt(0, 0);
    renderFace();
    twitch();
    bubble.thinking(`🔎 Looking up “${query}”…`);
  });

  // ---------- Nibo's ears (talking to him) ----------

  let ears = null;
  let listening = false;
  let voiceSeq = 0;
  let ignoreUtterance = false;
  let carry = { text: '', at: 0 }; // words heard before a short pause
  let levelFrame = 0;
  let lastLevel = 0;
  const micBtn = $('mic-btn');
  const voiceBadge = $('voice-badge');

  function toggleListening() {
    return listening ? stopListening() : startListening();
  }

  async function startListening() {
    if (listening) return;
    touch();
    if (face.sleeping) wake(false);
    if (!state.settings.hasKey) {
      return say('I need a Groq key to understand speech! 🎤 Add one in Settings.', {
        actions: [{ label: '⚙️ Settings', action: 'settings' }],
      });
    }
    if (!window.NiboVoice || !navigator.mediaDevices) return say("Hmm, I can't use a microphone here. 😿");
    if (!(await nibo.micAccess())) return say("I'm not allowed to use the microphone. 🎤 Check your privacy settings.");

    const next = new window.NiboVoice.Ears({
      onStart: heardSomething,
      onUtterance: handleUtterance,
      onDiscard: heardNothing,
      onLevel: showLevel,
    });
    try {
      await next.open(state.settings.micSensitivity);
    } catch {
      next.close();
      return say(
        "I couldn't open the microphone. 🎤 Make sure one is plugged in and that apps may use it (Windows Settings → Privacy & security → Microphone).",
        { duration: 9000 },
      );
    }
    ears = next;
    listening = true;
    ears.setNiboSpeaking(tts.active);
    document.body.classList.add('listening');
    pose.classList.add('listening');
    micBtn.title = 'Stop listening (Ctrl+Alt+Space)';
    playPose('jump', 560);
    say("I'm listening! 👂", { duration: 3000 });
  }

  function stopListening(quiet = false) {
    if (!listening) return;
    listening = false;
    voiceSeq++;
    carry = { text: '', at: 0 };
    if (ears) ears.close();
    ears = null;
    unhear();
    document.body.classList.remove('listening');
    pose.classList.remove('listening');
    micBtn.title = 'Talk to Nibo (Ctrl+Alt+Space)';
    if (!quiet) say('Okay, my ears are taking a break. 👂💤', { duration: 2500 });
  }

  function unhear() {
    document.body.classList.remove('hearing');
    pose.classList.remove('hearing');
  }

  // The mic picked up the start of speech.
  function heardSomething() {
    touch();
    if (face.sleeping) wake(false);
    if ((tts.active || tts.queue) && state.settings.bargeIn === false) {
      ignoreUtterance = true;
      return;
    }
    ignoreUtterance = false;
    interrupt();
    document.body.classList.add('hearing');
    pose.classList.add('hearing');
    bubble.thinking('🎤 Listening…');
  }

  function heardNothing() {
    unhear();
    if (!currentReq && !ignoreUtterance) bubble.hide();
    ignoreUtterance = false;
  }

  async function handleUtterance({ wav, speechMs, bargeIn }) {
    unhear();
    if (ignoreUtterance) {
      ignoreUtterance = false;
      return;
    }
    const turn = ++voiceSeq;
    face.thinking = true;
    renderFace();
    bubble.thinking('🎤 …');
    const res = await nibo.transcribe(wav);
    if (turn !== voiceSeq) {
      // More speech came in while this was transcribing: keep the words for it.
      if (res && res.ok && listening && !window.NiboVoice.isPhantom(res.text, { speechMs })) {
        carry = { text: `${carry.text} ${res.text}`.trim(), at: Date.now() };
      }
      return;
    }
    face.thinking = false;
    renderFace();
    if (!res || !res.ok) {
      if (res && !res.aborted) say(res.error || "I couldn't hear that. 🎤", { actions: res.actions });
      return;
    }
    // Only speech that overlapped Nibo talking can be his own echo.
    const echo = bargeIn && window.NiboVoice.isEcho(res.text, recentlySaid());
    if (window.NiboVoice.isPhantom(res.text, { speechMs }) || echo) {
      bubble.hide();
      return;
    }
    const earlier = Date.now() - carry.at < 10000 ? carry.text : '';
    carry = { text: '', at: 0 };
    const text = `${earlier} ${res.text}`.trim();

    if (/^(stop|wait|shh+|hush|be quiet|never ?mind)[.!]*$/i.test(text)) {
      bubble.say('🤐', { duration: 1200 });
      return;
    }
    if (/^(stop|quit) listening[.!]*$/i.test(text)) return stopListening();
    ask(text, { viaVoice: true, heard: text });
  }

  function showLevel(db, threshold) {
    if (tts.active && db > threshold - 3) duck();
    lastLevel = clamp((db - threshold + 12) / 24, 0, 1);
    if (levelFrame) return;
    levelFrame = requestAnimationFrame(() => {
      levelFrame = 0;
      micBtn.style.setProperty('--level', lastLevel.toFixed(2));
      voiceBadge.style.setProperty('--level', lastLevel.toFixed(2));
    });
  }

  // ---------- presets ----------

  const PROMPT_MODES = {
    search: { placeholder: 'Search the web for…', line: 'What should I sniff out on the web? 🔎 Type it below!' },
    app: { placeholder: 'Type an app name…', line: 'Which app should I open? 🚀 Type its name!' },
  };

  function enterPromptMode(mode, actions = []) {
    exitPromptMode();
    promptMode = mode;
    document.body.classList.add(`${mode}-mode`);
    input.placeholder = PROMPT_MODES[mode].placeholder;
    showUI();
    input.focus();
    say(PROMPT_MODES[mode].line, { sticky: true, actions });
  }

  function exitPromptMode() {
    if (promptMode) document.body.classList.remove(`${promptMode}-mode`);
    promptMode = null;
    input.placeholder = 'Ask me anything…';
  }

  // In the browser (no Tavily key, or the "Search in browser" chip).
  async function browserSearch(query) {
    const res = await nibo.preset('search', query);
    if (res && res.ok) {
      say(res.text, { duration: 4000 });
      playPose('jump', 560);
      twitch();
    }
  }

  async function doSearch(query) {
    const q = String(query || '').trim();
    if (!q) return enterPromptMode('search');
    exitPromptMode();
    touch();
    if (state.settings.hasSearch) return ask(q, { search: true });
    return browserSearch(q);
  }

  function chooseFolderToTidy() {
    touch();
    if (face.sleeping) wake(false);
    express({ eyes: 'happy', mouth: 'smile' }, 1200);
    say('Ooh, tidy time! 🧹 Which folder should I organize?', {
      sticky: true,
      actions: [
        { label: '🖥️ Desktop', action: 'organize', arg: 'desktop' },
        { label: '⬇️ Downloads', action: 'organize', arg: 'downloads' },
        { label: '📁 Pick a folder…', action: 'organize', arg: 'pick' },
      ],
    });
  }

  async function organize(target) {
    touch();
    if (face.sleeping) wake(false);
    bubble.say('*sniff sniff* Looking for loose files... 🐽', { sticky: true });
    playPose('scurry', 1200);
    const res = await nibo.organize(target);
    if (!res || (res.cancelled && !res.text)) return bubble.hide();
    if (res.ok && res.moved) {
      say(res.text, {
        actions: [
          { label: '📂 Open folder', action: 'open-organized' },
          { label: '↩️ Undo', action: 'organize-undo' },
        ],
      });
      playPose('binky', 800);
      express({ eyes: 'happy', mouth: 'smile' }, 2000);
      sparkles(10);
      hearts(3);
    } else {
      say(res.text);
      if (res.ok) express({ eyes: 'happy', mouth: 'smile' }, 1500);
    }
  }

  async function undoTidy() {
    touch();
    const res = await nibo.organizeUndo();
    if (!res || (res.cancelled && !res.text)) return;
    say(res.text);
    if (res.ok) playPose('jump', 560);
  }

  // ---------- opening apps ----------

  function chooseApp() {
    touch();
    if (face.sleeping) wake(false);
    const recent = (state.recentApps || []).slice(0, 4);
    enterPromptMode(
      'app',
      recent.map((name) => ({ label: `🚀 ${name}`, action: 'open-app', arg: name })),
    );
  }

  function celebrateOpen() {
    playPose('jump', 560);
    express({ eyes: 'happy', mouth: 'smile' }, 1500);
    sparkles(6);
    twitch();
  }

  async function openApp(name) {
    const n = String(name || '').trim();
    if (!n) return chooseApp();
    exitPromptMode();
    touch();
    if (face.sleeping) wake(false);
    stopSpeaking();
    bubble.thinking('');
    let res;
    try {
      res = await nibo.openApp(n);
    } catch {
      res = null;
    }
    if (!res || !res.ok) return say("Oops, my paws slipped. Try again? 🐰");
    say(res.text, { actions: res.actions });
    if (res.opened && res.opened.length) celebrateOpen();
  }

  async function feed() {
    if (feeding) return;
    feeding = true;
    touch();
    try {
      if (face.sleeping) wake(false);
      hold({ eyes: 'wide', mouth: 'o' });
      await throwCarrot();
      const res = await nibo.feed();
      hold(null);
      if (!res) return;
      applyState(res.state);

      if (res.result === 'stuffed') {
        express({ eyes: 'closed', mouth: 'o', cheeks: 'puff' }, 1900);
        playPose('rumble', 450);
        say(pick(lines.stuffed));
        return;
      }

      face.munching = true;
      renderFace();
      crumbs();
      await sleep(1500);
      face.munching = false;
      express({ eyes: 'happy', mouth: 'smile' }, 2300);
      playPose('binky', 800);
      hearts(6);
      sparkles(4);
      say(pick(lines.fed));
    } finally {
      feeding = false;
    }
  }

  function dance(ms = 5200) {
    touch();
    if (face.sleeping) wake(false);
    clearTimeout(danceTimer);
    clearInterval(noteTimer);
    pose.classList.add('dance');
    hold({ eyes: 'happy', mouth: 'smile' });
    bubble.say(pick(['♪ Boogie time! ♪', '♫ Hop hop, bunny bop! ♫', '♪ Shake that cottontail! ♪']), { duration: ms });
    noteTimer = setInterval(musicNote, 280);
    danceTimer = setTimeout(() => {
      clearInterval(noteTimer);
      pose.classList.remove('dance');
      hold(null);
      hearts(3);
    }, ms);
  }

  async function hop() {
    touch();
    if (face.sleeping) wake(false);
    say(pick(['Wheee! 🐇', 'Boing boing boing!', 'Hop hop hooray!']), { duration: 2600 });
    hold({ eyes: 'happy', mouth: 'smile' });
    await nibo.preset('hop');
    hold(null);
  }

  function nap(quiet = false) {
    if (face.sleeping) return;
    face.sleeping = true;
    wrap.classList.add('sleepy');
    renderFace();
    startZzz();
    if (!quiet) bubble.say('Yaaawn... nap time. 😴 (Click me to wake me up!)', { duration: 3000 });
  }

  function wake(greet = true) {
    if (!face.sleeping) return;
    face.sleeping = false;
    wrap.classList.remove('sleepy');
    stopZzz();
    renderFace();
    playPose('jump', 560);
    twitch();
    touch();
    if (greet) {
      say(pick(['*yawn* Oh! Hi there! 👋', 'I was NOT sleeping. I was... resting my eyes. 👀', 'Huh? Carrots?! ...Oh, it’s you! Hi!']), {
        duration: 3500,
      });
    }
  }

  async function toggleVoice() {
    const next = !(state && state.settings.voice);
    applyState(await nibo.setVoice(next));
    if (next) {
      bubble.say('Squeaky voice ON! 🔊 Can you hear me?', { duration: 3000 });
      speak('Squeaky voice on! Can you hear me?');
    } else {
      stopSpeaking();
      say('Shh... quiet mode. 🔇', { duration: 2500 });
    }
  }

  function hungryNag() {
    lastHungryNag = Date.now();
    playPose('rumble', 450);
    say(pick(lines.hungry), { duration: 7000, actions: [{ label: '🥕 Feed Nibo', action: 'feed' }] });
  }

  async function poke() {
    touch();
    if (face.sleeping) return wake(true);
    playPose('poke', 360);
    express({ eyes: 'happy', mouth: 'smile' }, 1300);
    twitch();
    applyState(await nibo.pat());
    if (!bubble.isVisible()) say(pick(lines.poke), { duration: 2600 });
    if (Math.random() < 0.35) hearts(2);
  }

  async function runPreset(name) {
    closeMenu();
    touch();
    switch (name) {
      case 'organize':
        return chooseFolderToTidy();
      case 'undo-organize':
        return undoTidy();
      case 'joke':
        return ask(`Tell me a short, silly joke about ${pick(JOKE_TOPICS)}!`);
      case 'fact':
        return ask(`Tell me a surprising fun fact about ${pick(FACT_TOPICS)}!`);
      case 'cheer':
        return ask('Cheer me up! Say something sweet and encouraging.');
      case 'search': {
        const typed = input.value.trim();
        if (!typed) return enterPromptMode('search');
        input.value = '';
        return doSearch(typed);
      }
      case 'open-app': {
        const typed = input.value.trim();
        if (!typed) return chooseApp();
        input.value = '';
        return openApp(typed);
      }
      case 'feed':
        return feed();
      case 'dance':
        return dance();
      case 'hop':
        return hop();
      case 'nap':
        return nap();
      case 'voice':
        return toggleVoice();
      case 'forget':
        nibo.clearChat();
        express({ eyes: 'closed', mouth: 'o' }, 900);
        return say('Poof! 🧹 I forgot everything we talked about. ...Wait, who are you? Just kidding! 🐰');
      case 'settings':
        return nibo.openSettings();
      case 'hide':
        say('Bye for now! Click my icon in the tray to bring me back. 🙈', { duration: 1800 });
        await sleep(1400);
        bubble.hide();
        return nibo.hide();
      case 'quit':
        wave();
        say('Bye bye! See you soon! 👋🐰', { sticky: true });
        await sleep(1500);
        return nibo.quit();
      default:
        return undefined;
    }
  }

  bubble.onAction((action) => {
    if (action.action === 'search') doSearch(action.arg);
    else if (action.action === 'settings') nibo.openSettings();
    else if (action.action === 'retry') ask(action.arg);
    else if (action.action === 'feed') feed();
    else if (action.action === 'organize') organize(action.arg);
    else if (action.action === 'organize-undo') undoTidy();
    else if (action.action === 'open-organized') nibo.openOrganized();
    else if (action.action === 'open-url') nibo.openExternal(action.arg);
    else if (action.action === 'browser-search') browserSearch(action.arg);
    else if (action.action === 'open-app') openApp(action.arg);
  });

  // ---------- hover, click-through, menu ----------

  function setInteractive(on) {
    if (!state || !state.clickThrough) return;
    const ignore = !on;
    if (ignore === ignoring) return;
    ignoring = ignore;
    nibo.setIgnoreMouse(ignore);
  }

  function hitAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.hit') : null;
  }

  function showUI() {
    clearTimeout(uiTimer);
    document.body.classList.add('show-ui');
  }

  function menuOpen() {
    return !menu.classList.contains('hidden');
  }

  function maybeHideUI(delay = 1400) {
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      const typing = document.activeElement === input && input.value.trim();
      if (hovering || menuOpen() || typing || promptMode || dragging) return;
      document.body.classList.remove('show-ui');
      if (document.activeElement === input) input.blur();
    }, delay);
  }

  function updatePointer(x, y, inside = true) {
    const hit = inside ? hitAt(x, y) : null;
    setInteractive(Boolean(hit) || dragging || Boolean(pressed));
    const over = Boolean(hit);
    if (over === hovering) return;
    hovering = over;
    if (hovering) {
      showUI();
      touch();
    } else {
      maybeHideUI();
    }
  }

  function openMenu(x, y) {
    if (typeof x === 'number') {
      const h = menu.offsetHeight || 360;
      menu.style.left = `${clamp(x - 30, 8, 360 - 226 - 8)}px`;
      menu.style.top = `${clamp(y - 40, 8, 620 - h - 8)}px`;
      menu.style.right = 'auto';
      menu.style.bottom = 'auto';
    } else {
      menu.style.left = '';
      menu.style.top = '';
      menu.style.right = '';
      menu.style.bottom = '';
    }
    voiceBtn.textContent = state && state.settings.voice ? '🔊' : '🔇';
    menu.classList.remove('hidden');
    showUI();
    setInteractive(true);
  }

  function closeMenu() {
    menu.classList.add('hidden');
  }

  document.addEventListener('mousemove', (e) => {
    lastCursor = { x: e.clientX, y: e.clientY };
    updatePointer(e.clientX, e.clientY);
    if (pressed && !dragging && Math.hypot(e.screenX - pressed.x, e.screenY - pressed.y) > 4) {
      dragging = true;
      document.body.classList.add('dragging');
      pose.classList.add('held');
      face.held = true;
      renderFace();
      bubble.hide();
      closeMenu();
      nibo.dragStart();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#menu') && !e.target.closest('#preset-btn')) closeMenu();
    if (e.button !== 0 || !e.target.closest('.nibo-hit')) return;
    pressed = { x: e.screenX, y: e.screenY };
    e.preventDefault();
  });

  function endDrag() {
    dragging = false;
    document.body.classList.remove('dragging');
    pose.classList.remove('held');
    face.held = false;
    renderFace();
    nibo.dragEnd();
    playPose('land', 280);
    touch();
  }

  document.addEventListener('mouseup', (e) => {
    if (!pressed) return;
    pressed = null;
    if (dragging) endDrag();
    else if (e.button === 0 && e.target.closest('.nibo-hit')) {
      if (interrupt()) express({ eyes: 'wide', mouth: 'o' }, 900);
      else poke();
    }
  });

  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input')) return;
    e.preventDefault();
    if (e.target.closest('.nibo-hit')) openMenu(e.clientX, e.clientY);
  });

  window.addEventListener('blur', () => {
    closeMenu();
    if (dragging) endDrag();
    pressed = null;
    if (promptMode && !input.value.trim()) {
      exitPromptMode();
      bubble.hide();
    }
    maybeHideUI(600);
  });

  nibo.on('nibo:cursor', ({ x, y, inside }) => {
    if (!dragging) lastCursor = { x, y };
    lookAt(x, y);
    if (!dragging) updatePointer(x, y, inside);
  });

  nibo.on('nibo:hop', (phase) => (phase === 'jump' ? playPose('jump', 560) : playPose('land', 280)));
  nibo.on('nibo:command', (cmd) => {
    if (cmd === 'feed') feed();
    if (cmd === 'toggle-voice') toggleListening();
    if (cmd === 'stop-voice') stopListening(true);
    if (cmd === 'organize-review') {
      say("Take a peek at my plan! 👀 Nothing moves until you say yes.", { sticky: true });
      glance({ x: EYES.x - 400, y: EYES.y - 100 }, 2000);
    }
  });

  presetBtn.addEventListener('click', () => (menuOpen() ? closeMenu() : openMenu()));
  feedBtn.addEventListener('click', () => feed());
  micBtn.addEventListener('click', () => toggleListening());
  voiceBadge.addEventListener('click', () => stopListening());
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (b) runPreset(b.dataset.preset);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return input.focus();
    input.value = '';
    if (promptMode === 'search') doSearch(text);
    else if (promptMode === 'app') openApp(text);
    else ask(text);
  });

  input.addEventListener('focus', showUI);
  input.addEventListener('blur', () => maybeHideUI());

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menuOpen()) return closeMenu();
    if (interrupt()) return;
    if (promptMode) {
      exitPromptMode();
      bubble.hide();
      return;
    }
    if (bubble.isVisible()) return bubble.hide();
    input.blur();
    maybeHideUI(0);
  });

  // ---------- state & life ----------

  function updateMeters() {
    const p = state.pet;
    $('meter-food').style.width = `${clamp(p.fullness, 0, 100)}%`;
    $('meter-joy').style.width = `${clamp(p.happiness, 0, 100)}%`;
    $('stats').title = `Tummy ${Math.round(p.fullness)}% full · Happiness ${Math.round(p.happiness)}% · ${p.carrotsEaten} carrots eaten`;
  }

  function applyState(next) {
    if (!next) return;
    const prevMood = state ? state.mood : null;
    state = next;
    updateMeters();
    voiceBtn.textContent = state.settings.voice ? '🔊' : '🔇';
    undoTidyBtn.hidden = !state.canUndoOrganize;
    if (ears) ears.setSensitivity(state.settings.micSensitivity);
    if (!state.clickThrough) ignoring = false;
    renderFace();
    if (prevMood && prevMood !== 'hungry' && state.mood === 'hungry' && !face.sleeping) hungryNag();
  }

  nibo.on('nibo:state', applyState);

  function idleLoop() {
    setTimeout(() => {
      idleLoop();
      if (dragging || currentReq || feeding || face.sleeping || pose.classList.contains('dance')) return;
      const idleFor = Date.now() - lastInteraction;
      if (idleFor > 10 * 60 * 1000 && !bubble.isVisible() && !hovering) return nap(true);
      if (state && state.mood === 'hungry' && Date.now() - lastHungryNag > 5 * 60 * 1000 && !bubble.isVisible()) {
        return hungryNag();
      }
      const r = Math.random();
      if (r < 0.35) twitch();
      else if (r < 0.6) glance();
      else if (r < 0.7) wave();
      else if (r < 0.78 && state && state.mood === 'happy') hearts(2);
    }, rand(8000, 18000));
  }

  async function start() {
    const [s, l] = await Promise.all([nibo.getState(), nibo.getLines()]);
    if (l) lines = l;
    applyState(s);
    blinkLoop();
    idleLoop();
    await sleep(700);
    wave();
    playPose('jump', 560);
    if (state.settings.firstRun) {
      const intro =
        "Hi hi! I'm Nibo! 🐰 Hover over me to chat (or click 🎤 to talk), right-click me for silly stuff, drag me anywhere, and feed me carrots! 🥕" +
        (state.settings.hasKey ? '' : '\nAdd a free Groq API key in Settings so I can answer anything!');
      say(intro, {
        duration: 22000,
        actions: state.settings.hasKey ? [] : [{ label: '⚙️ Settings', action: 'settings' }],
      });
      nibo.firstRunDone();
    } else {
      say(state.mood === 'hungry' ? pick(lines.hungry) : pick(lines.greetings), { duration: 6000 });
    }
  }

  start();
})();
