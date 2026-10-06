'use strict';

(function () {
  const api = window.niboMemory;
  const $ = (id) => document.getElementById(id);
  const list = $('notes');
  const status = $('status');

  function say(text, kind) {
    status.textContent = text || '';
    status.className = `status ${kind || ''}`;
  }

  function when(at) {
    if (!at) return '';
    try {
      return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  function render(data) {
    list.textContent = '';
    for (const note of data.notes) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = note.text;
      const date = document.createElement('span');
      date.className = 'when';
      date.textContent = when(note.at);
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✖';
      del.title = 'Forget this';
      del.setAttribute('aria-label', `Forget: ${note.text}`);
      del.addEventListener('click', async () => {
        await api.remove(note.id);
        say('Forgotten! 🧹', 'ok');
        load();
      });
      li.append(text, date, del);
      list.append(li);
    }
    const n = data.notes.length;
    $('summary').textContent = n ? `I remember ${n} ${n === 1 ? 'thing' : 'things'} about you.` : 'My notebook is empty.';
    $('empty').hidden = n > 0;
    $('clear').disabled = n === 0;
    $('off').hidden = data.on;
  }

  async function load() {
    const data = await api.list();
    if (data) render(data);
  }

  $('add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('note');
    const text = input.value.trim();
    if (!text) return input.focus();
    const res = await api.add(text);
    if (res && res.ok) {
      input.value = '';
      say('Okay, I\'ll remember that! 🧠', 'ok');
    } else {
      say((res && res.message) || "I couldn't keep that one. 😿", 'bad');
    }
    load();
  });

  $('clear').addEventListener('click', async () => {
    const res = await api.clear();
    if (res && res.cleared) say('Poof! I forgot everything. 🧹', 'ok');
    load();
  });

  $('close').addEventListener('click', () => api.close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.close();
  });
  api.onChange(load);
  load();
  $('note').focus();
})();
