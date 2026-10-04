'use strict';

// The tidy-up approval popup: shows Nibo's plan, lets the user untick
// anything, and only then says yes.
(function () {
  const api = window.niboOrganize;
  const $ = (id) => document.getElementById(id);
  const approveBtn = $('approve');
  const checks = []; // every file checkbox

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  function updateApprove() {
    const n = checks.filter((c) => c.checked).length;
    approveBtn.disabled = n === 0;
    approveBtn.textContent = n ? `Move ${plural(n, 'file')} 🧹` : 'Nothing picked';
  }

  function renderPile(pile) {
    const pileChecks = [];
    const head = el('input', { type: 'checkbox', checked: true, title: 'Move this whole pile' });
    const list = el('ul', { className: 'files', hidden: pile.items.length > 6 });
    const toggle = el('button', { type: 'button', className: 'toggle' });
    const setToggle = () => (toggle.textContent = list.hidden ? '▸ show files' : '▾ hide');
    setToggle();
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      list.hidden = !list.hidden;
      setToggle();
    });

    for (const item of pile.items) {
      const box = el('input', { type: 'checkbox', checked: true });
      box.dataset.id = item.id;
      pileChecks.push(box);
      checks.push(box);
      const label = el('label', { title: item.name }, box, el('span', { className: 'file-name', textContent: item.name }));
      if (item.renamedTo) label.append(el('span', { className: 'renamed', textContent: `→ ${item.renamedTo}` }));
      label.append(el('span', { className: 'file-meta', textContent: formatSize(item.size) }));
      list.append(el('li', {}, label));
      box.addEventListener('change', () => {
        const on = pileChecks.filter((c) => c.checked).length;
        head.checked = on === pileChecks.length;
        head.indeterminate = on > 0 && on < pileChecks.length;
        updateApprove();
      });
    }

    head.addEventListener('change', () => {
      for (const c of pileChecks) c.checked = head.checked;
      head.indeterminate = false;
      updateApprove();
    });

    const dest = el('span', { className: 'pile-dest' }, `→ 📁 ${pile.folder}`);
    if (!pile.folderExists) dest.append(el('span', { className: 'badge', textContent: 'new' }));
    const headRow = el(
      'label',
      { className: 'pile-head' },
      head,
      el('span', { className: 'pile-title', textContent: pile.label }),
      dest,
      el('span', { className: 'spacer' }),
      el('span', { className: 'small', textContent: plural(pile.items.length, 'file') }),
      toggle,
    );
    return el('section', { className: 'pile' }, headRow, list);
  }

  function describeSkipped(s) {
    const parts = [];
    if (s.shortcuts) parts.push(plural(s.shortcuts, 'shortcut'));
    if (s.folders) parts.push(plural(s.folders, 'folder'));
    if (s.unknown) parts.push(`${plural(s.unknown, 'file')} I'm not sure about`);
    if (s.busy) parts.push(`${plural(s.busy, 'file')} that changed just now`);
    if (s.more) parts.push(`${s.more} more for next time`);
    return parts.length ? `I'll leave these where they are: ${parts.join(', ')}.` : '';
  }

  async function load() {
    const plan = await api.getPlan();
    if (!plan) {
      $('intro').textContent = 'This plan has expired. Ask Nibo again! 🐰';
      approveBtn.disabled = true;
      return;
    }
    $('where').textContent = plan.root;
    $('where').title = plan.root;
    $('intro').textContent =
      `I found ${plural(plan.total, 'loose file')} in ${plan.label} and sorted them into piles. ` +
      'Untick anything you want me to leave alone. Nothing moves until you say so, and I never delete or overwrite anything.';
    $('piles').append(...plan.piles.map(renderPile));
    $('skipped').textContent = describeSkipped(plan.skipped);
    updateApprove();
    approveBtn.focus();
  }

  approveBtn.addEventListener('click', () => {
    approveBtn.disabled = true;
    api.approve(checks.filter((c) => c.checked).map((c) => c.dataset.id));
  });
  $('cancel').addEventListener('click', () => api.cancel());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.cancel();
  });

  load();
})();
