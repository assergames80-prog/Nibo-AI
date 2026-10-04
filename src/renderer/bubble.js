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
  let rafQueued = false;
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
    streamText = '';
    render(text);
    setActions(opts.actions);
    show();
    textEl.scrollTop = 0;
    scheduleHide(opts.sticky ? 0 : (opts.duration ?? readingTime(text)));
  }

  function thinking() {
    streamText = '';
    clearHideTimer();
    textEl.textContent = '';
    setActions(null);
    const dots = document.createElement('span');
    dots.className = 'thinking';
    dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    textEl.append(dots);
    show();
  }

  function startStream() {
    streamText = '';
    clearHideTimer();
    setActions(null);
    render('');
    show();
  }

  function append(delta) {
    streamText += delta;
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => {
      rafQueued = false;
      render(streamText);
      textEl.scrollTop = textEl.scrollHeight;
    });
  }

  function finish(text, opts = {}) {
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
