'use strict';

// The speech bubble: plain text rendering (no innerHTML), streaming, actions.
(function () {
  const el = document.getElementById('bubble');
  const textEl = document.getElementById('bubble-text');
  const actionsEl = document.getElementById('bubble-actions');
  const closeBtn = document.getElementById('bubble-close');

  const URL_RE = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,!?;:])/g;

  let hideTimer = null;
  let hovered = false;
  let pendingHideMs = 0;
  let streamText = '';
  let renderFrame = 0; // a queued render of streamed text
  let onAction = () => {};
  let onHide = () => {};

  function tidy(text) {
    return String(text || '')
      .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Drop a queued streamed-text render so it can't overwrite what comes next.
  function cancelRender() {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }

  function render(text) {
    textEl.textContent = '';
    const clean = tidy(text);
    let last = 0;
    for (const match of clean.matchAll(URL_RE)) {
      if (match.index > last) textEl.append(clean.slice(last, match.index));
      const a = document.createElement('a');
      a.textContent = match[0];
      a.dataset.href = match[0];
      a.title = 'Open in your browser';
      textEl.append(a);
      last = match.index + match[0].length;
    }
    if (last < clean.length) textEl.append(clean.slice(last));
    textEl.classList.remove('scrolly');
    if (textEl.scrollHeight - textEl.clientHeight > 2) textEl.classList.add('scrolly');
  }

  function setActions(actions) {
    actionsEl.textContent = '';
    for (const action of actions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = action.label;
      b.addEventListener('click', () => onAction(action));
      actionsEl.append(b);
    }
  }

  function clearHideTimer() {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function scheduleHide(ms) {
    clearHideTimer();
    pendingHideMs = ms;
    if (!ms || hovered) return;
    hideTimer = setTimeout(hide, ms);
  }

  function readingTime(text) {
    return Math.max(5000, Math.min(45000, 3500 + String(text).length * 60));
  }

  function show() {
    el.classList.remove('hidden');
  }

  function hide() {
    clearHideTimer();
    pendingHideMs = 0;
    if (el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    onHide();
  }

  // Say something. opts: { actions, duration (ms, 0 = stay), sticky }
  function say(text, opts = {}) {
    cancelRender();
    streamText = '';
    render(text);
    setActions(opts.actions);
    show();
    textEl.scrollTop = 0;
    scheduleHide(opts.sticky ? 0 : (opts.duration ?? readingTime(text)));
  }

  // Change the words only (the chips stay put, so a click on one can't be lost), e.g. a progress bar.
  function setText(text) {
    cancelRender();
    streamText = '';
    render(text);
    show();
  }

  // Bouncing dots, optionally under a line like what Nibo heard or is looking up.
  function thinking(label) {
    cancelRender();
    streamText = '';
    clearHideTimer();
    textEl.textContent = '';
    setActions(null);
    if (label) {
      const line = document.createElement('div');
      line.className = 'heard';
      line.textContent = label;
      textEl.append(line);
    }
    const dots = document.createElement('span');
    dots.className = 'thinking';
    dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    textEl.append(dots);
    show();
  }

  function startStream() {
    cancelRender();
    streamText = '';
    clearHideTimer();
    setActions(null);
    render('');
    show();
  }

  function append(delta) {
    streamText += delta;
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      render(streamText);
      textEl.scrollTop = textEl.scrollHeight;
    });
  }

  function finish(text, opts = {}) {
    cancelRender();
    const finalText = text ?? streamText;
    render(finalText);
    setActions(opts.actions);
    show();
    scheduleHide(readingTime(finalText));
  }

  textEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-href]');
    if (a) window.nibo.openExternal(a.dataset.href);
  });
  closeBtn.addEventListener('click', hide);
  el.addEventListener('mouseenter', () => {
    hovered = true;
    clearTimeout(hideTimer);
  });
  el.addEventListener('mouseleave', () => {
    hovered = false;
    if (pendingHideMs) scheduleHide(Math.min(pendingHideMs, 4000));
  });

  window.NiboBubble = {
    say,
    setText,
    thinking,
    startStream,
    append,
    finish,
    hide,
    isVisible: () => !el.classList.contains('hidden'),
    onAction: (fn) => (onAction = fn),
    onHide: (fn) => (onHide = fn),
    tidy,
  };
})();
