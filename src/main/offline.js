'use strict';

// Nibo's built-in "little bunny brain": works without an API key or internet.

const JOKES = [
  'Why did the bunny join the band? He had the best hip-hop beats! 🥁',
  'What do you call a bunny with fleas? Bugs Bunny! 🐛',
  "How do rabbits travel? By hare-plane! ✈️",
  'Why are bunnies so lucky? They have four rabbit feet!',
  'What did the computer do at lunchtime? It had a byte! 🍪',
  "Why was the computer cold? It left its Windows open! 🪟",
  'What is a bunny’s favorite music? Hip hop, obviously. 🎶',
  'How do you know carrots are good for your eyes? Have you ever seen a bunny wearing glasses? 👓',
  "Why don't programmers like nature? Too many bugs. 🐞",
  'What do you call a sleeping bunny? A hare-nap! 😴',
  "Why did the bunny cross the road? To prove he wasn't chicken! 🐔",
  'How many bunnies does it take to change a light bulb? Just one, but it takes a whole hop-eration.',
  'What do you call a rabbit that tells jokes? A funny bunny! (That’s me.)',
  "Why did the AI go to therapy? It had too many unresolved dependencies. 🧠",
  'My favorite exercise? Hare-obics! 🏋️',
];

const FACTS = [
  'Bunnies can see almost 360° around them — but they have a tiny blind spot right in front of their nose! 👀',
  'When rabbits are super happy they do a twisty jump called a “binky”. I do those all the time! 🐇',
  "A rabbit's teeth never stop growing, which is why we love to munch. 🥕",
  'Honey never spoils — archaeologists found edible honey in ancient Egyptian tombs! 🍯',
  'Octopuses have three hearts and blue blood. 🐙',
  'Bananas are berries, but strawberries are not! 🍓',
  'A group of bunnies is called a “fluffle”. Best word ever.',
  "Wombats make cube-shaped poop. Nature is weird! 🟫",
  'The first computer “bug” was an actual moth stuck in a relay in 1947. 🦋',
  "Carrots used to be purple! Orange carrots became popular in the 1600s — just like my fur, I'm a classic. 💜",
  'Sea otters hold hands while sleeping so they don’t drift apart. 🦦',
  'Rabbits purr by gently grinding their teeth when they are content.',
  "There are more possible chess games than atoms in the observable universe. ♟️",
  'Butterflies taste with their feet. 🦋',
  'Your brain uses about 20% of your body’s energy — think happy thoughts, they’re worth it! 🧠',
];

const COMPLIMENTS = [
  "You're doing way better than you think. Seriously! 💜",
  'If you were a carrot, you’d be the crunchiest, most golden carrot in the whole garden. 🥕',
  'Your desktop is lucky to have you. And so am I! 🐰',
  "Hey, you showed up today. That counts for a lot! ✨",
  'You have the energy of a bunny doing a binky. Unstoppable!',
  "Whatever you're working on — you've got this. I believe in you! 💪",
  'You make this computer a cozier place. 🏡',
  'Remember to drink some water and stretch those paws! You deserve it. 💧',
  "Fun fact: you're my favorite human. Don't tell the others. 🤫",
  'Even on a slow day, you’re still moving forward. Hop by hop! 🐾',
];

const GREETINGS = [
  "Hi hi! I'm Nibo! 🐰 Hover over me to chat, or right-click for silly stuff!",
  'Boing! Nibo is here! What are we doing today? ✨',
  'Hello, friend! Got any carrots? 🥕 (Just kidding... unless?)',
  "*twitches nose* Oh hi! I was just floating around. What's up?",
];

const HUNGRY_LINES = [
  'My tummy is rumbling... got a carrot? 🥕',
  'Is it snack time? I think it’s snack time. 🥺',
  '*stares at the carrot button* ...no reason.',
  "I'm sooo hungry I could eat a whole garden! 🥕🥕",
];

const FED_LINES = [
  'Nom nom nom! Thank you!! 🥕💜',
  'Crunchy! That was the best carrot ever!',
  'Yum! You’re the best! *happy binky*',
  'Mmm, carrot power! I feel 10% smarter already. 🧠',
];

const STUFFED_LINES = [
  "I'm sooo full... *burp* ...excuse me! 😳",
  'No more, please! My tummy is a balloon! 🎈',
  "I couldn't eat another bite. Maybe later! 🥕",
];

const POKE_LINES = [
  'Hehe, that tickles! 😆',
  'Boop! 👉🐰',
  'Hey! I was floating there! 😤 ...okay, do it again.',
  '*happy wiggle*',
  "You found my secret giggle button!",
];

function pick(list, rand = Math.random) {
  return list[Math.floor(rand() * list.length) % list.length];
}

// ---------- safe arithmetic (no eval) ----------

function tokenize(expr) {
  const tokens = [];
  const re = /\s*(\d+(?:\.\d+)?|\.\d+|[-+*/%^()x×÷])\s*/gy;
  let m;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    m = re.exec(expr);
    if (!m) return null;
    let t = m[1];
    if (t === 'x' || t === '×') t = '*';
    if (t === '÷') t = '/';
    tokens.push(t);
    pos = re.lastIndex;
  }
  return tokens;
}

// Recursive-descent parser: expr := term (('+'|'-') term)*, etc.
function evaluate(expr) {
  const tokens = tokenize(String(expr));
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parsePrimary() {
    const t = next();
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const v = parseExpr();
      if (next() !== ')') throw new Error('missing )');
      return v;
    }
    if (t === '-') return -parsePower();
    if (t === '+') return parsePower();
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error('bad number');
    return n;
  }
  function parsePower() {
    const base = parsePrimary();
    if (peek() === '^') {
      next();
      return Math.pow(base, parsePower());
    }
    return base;
  }
  function parseTerm() {
    let v = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const r = parsePower();
      if (op === '*') v *= r;
      else if (op === '/') v /= r;
      else v %= r;
    }
    return v;
  }
  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  try {
    const v = parseExpr();
    if (i !== tokens.length || !Number.isFinite(v)) return null;
    return Math.round(v * 1e10) / 1e10;
  } catch {
    return null;
  }
}

function extractMath(text) {
  const cleaned = text
    .toLowerCase()
    .replace(/^(what('|’)?s|what is|calculate|compute|solve|how much is)\s+/, '')
    .replace(/[=?!]+\s*$/, '')
    .trim();
  if (!/\d/.test(cleaned) || !/[-+*/%^x×÷]/.test(cleaned)) return null;
  if (!/^[\d\s.+\-*/%^()x×÷]+$/.test(cleaned)) return null;
  return evaluate(cleaned) === null ? null : cleaned;
}

// ---------- search ----------

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};

function searchUrl(query, engine = 'google') {
  const base = SEARCH_ENGINES[engine] || SEARCH_ENGINES.google;
  return base + encodeURIComponent(String(query).trim());
}

// "search for cats", "google pancakes", "look up the weather" -> query
function detectSearch(text) {
  const m = String(text)
    .trim()
    .match(
      /^(?:please\s+)?(?:search(?:\s+the\s+web)?(?:\s+for)?|google|look\s+up|bing|duckduckgo)\s+(?!(?:is|was|are|has|does|did)\b)(.+)$/i,
    );
  return m ? m[1].replace(/[?.!]+$/, '').trim() : null;
}

// ---------- chat ----------

function timeString(now) {
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dateString(now) {
  return now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Answer without any AI. Returns { text, actions? }.
 * ctx: { mood, now: Date, rand }
 */
function answer(input, ctx = {}) {
  const text = String(input || '').trim();
  const lower = text.toLowerCase();
  const now = ctx.now || new Date();
  const rand = ctx.rand || Math.random;
  const mood = ctx.mood || 'okay';

  if (!text) return { text: 'Did you say something? My ears are listening! 👂' };

  const math = extractMath(text);
  if (math) {
    return { text: `Hmm, let me count on my paws... ${math} = ${evaluate(math)}! 🐾` };
  }
  if (/\b(hi|hello|hey|howdy|yo|hiya|good (morning|afternoon|evening))\b/.test(lower) && lower.length < 40) {
    return { text: pick(['Hiii! 👋🐰', 'Hello hello! What can I do for you?', 'Hey there, friend! ✨'], rand) };
  }
  if (/how are (you|u)|how('|’)?s it going|how do you feel/.test(lower)) {
    const byMood = {
      happy: "I'm super duper happy! My tail is wiggling! 💜",
      okay: "I'm doing okay! A carrot would make it even better though. 🥕",
      hungry: "Honestly? Hungry. Very hungry. Carrot hungry. 🥺🥕",
      sad: "A little blue today... maybe a carrot and a chat would help? 💙",
    };
    return { text: byMood[mood] || byMood.okay };
  }
  if (/(who|what) are you|your name/.test(lower)) {
    return {
      text: "I'm Nibo, your floating bunny assistant! 🐰 I answer questions, tell jokes, search the web, and eat carrots. Mostly the carrots.",
    };
  }
  if (/\b(what time|the time|time is it)\b/.test(lower)) {
    return { text: `It's ${timeString(now)}! ⏰` };
  }
  if (/\b(what day|today'?s date|what('|’)?s the date|the date)\b/.test(lower)) {
    return { text: `Today is ${dateString(now)}. 📅` };
  }
  if (/\bjoke|funny|make me laugh\b/.test(lower)) return { text: pick(JOKES, rand) };
  if (/\bfact|teach me|something interesting\b/.test(lower)) return { text: pick(FACTS, rand) };
  if (/cheer me up|compliment|encourage|motivat/.test(lower)) return { text: pick(COMPLIMENTS, rand) };
  if (/\b(sad|tired|stressed|anxious|lonely|bored|upset)\b/.test(lower)) {
    return { text: `Aww, come here. 🤗 ${pick(COMPLIMENTS, rand)}` };
  }
  if (/\b(thank|thanks|thx|ty)\b/.test(lower)) {
    return { text: pick(["You're welcome! 💜", 'Anytime! *happy hop*', 'Hehe, happy to help! 🐰'], rand) };
  }
  if (/\b(love you|you('|’)?re (cute|adorable|the best))\b/.test(lower)) {
    return { text: 'Aww! 🥹 *blushes in lavender* You’re the best too!' };
  }
  if (/\b(carrot|hungry|food|eat|snack)\b/.test(lower)) {
    return { text: 'Did someone say snack?! Click the 🥕 button to feed me!' };
  }
  if (/\b(bye|goodbye|see you|good night)\b/.test(lower)) {
    return { text: 'Bye bye! I’ll be right here floating. 👋🐰' };
  }

  return {
    text:
      "Ooh, good question! My little bunny brain needs a Groq API key to answer that one. 🧠 Add a free key in Settings ⚙️ — or I can search the web for you!",
    actions: [
      { label: '🔎 Search the web', action: 'search', arg: text },
      { label: '⚙️ Settings', action: 'settings' },
    ],
  };
}

// ---------- "Organize my apps" ----------

const CATEGORIES = [
  { key: 'apps', label: '🚀 Zoomy shortcuts', exts: ['.lnk', '.url', '.exe', '.appref-ms', '.desktop', '.app', '.website'] },
  { key: 'docs', label: '📄 Paper stuff', exts: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.pages', '.key', '.numbers'] },
  { key: 'pics', label: '🖼️ Pretty pictures', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.ico', '.tif', '.tiff'] },
  { key: 'media', label: '🎵 Noisy things', exts: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.mp4', '.mov', '.mkv', '.avi', '.webm'] },
  { key: 'boxes', label: '📦 Mystery boxes', exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.msi', '.dmg', '.pkg'] },
  { key: 'code', label: '🧪 Nerdy stuff', exts: ['.js', '.ts', '.py', '.json', '.html', '.css', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.sh', '.bat', '.ps1'] },
];

const IGNORED = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '.localized']);

function extname(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function prettyName(name) {
  const ext = extname(name);
  return ['.lnk', '.url', '.appref-ms', '.desktop', '.website'].includes(ext) ? name.slice(0, -ext.length) : name;
}

/**
 * entries: Array<{ name: string, isDir: boolean }>
 * Returns { total, piles: [{label, items}], text }
 */
function organize(entries, rand = Math.random) {
  const seen = new Set();
  const clean = (entries || []).filter((e) => {
    if (!e || typeof e.name !== 'string') return false;
    const lower = e.name.toLowerCase();
    if (IGNORED.has(lower) || lower.startsWith('.') || lower.startsWith('~$')) return false;
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  const piles = new Map();
  const add = (label, name) => {
    if (!piles.has(label)) piles.set(label, []);
    piles.get(label).push(prettyName(name));
  };

  for (const e of clean) {
    if (e.isDir) {
      add('🕳️ Burrows (folders)', e.name);
      continue;
    }
    const ext = extname(e.name);
    const cat = CATEGORIES.find((c) => c.exts.includes(ext));
    add(cat ? cat.label : '🥕 Misc. carrots', e.name);
  }

  const sorted = [...piles.entries()]
    .map(([label, items]) => ({ label, items: items.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => b.items.length - a.items.length);

  const total = clean.length;
  let text;
  if (total === 0) {
    text = 'I checked your desktop and it’s spotless! ✨ Did you hire another bunny to clean?';
  } else {
    const lines = sorted.map((p) => {
      const sample = p.items.slice(0, 3).join(', ');
      const more = p.items.length > 3 ? ` +${p.items.length - 3} more` : '';
      return `${p.label} (${p.items.length}): ${sample}${more}`;
    });
    const verdict =
      total > 40
        ? pick(["That's a LOT of stuff. I got lost twice. 🗺️", 'Your desktop is basically a jungle. I love it. 🌴'], rand)
        : total > 15
          ? pick(['Pretty cozy in there! 🏡', 'A respectable amount of clutter. 👍'], rand)
          : pick(['Very tidy! I approve. 🧹', 'Neat as a freshly dug burrow! 🐰'], rand);
    text =
      `*hops around your desktop sorting things* 🐇💨\nI sorted ${total} thing${total === 1 ? '' : 's'} into piles:\n` +
      lines.map((l) => `- ${l}`).join('\n') +
      `\n${verdict}\n(I only looked — nothing was moved! 🙈)`;
  }
  return { total, piles: sorted, text };
}

module.exports = {
  JOKES,
  FACTS,
  COMPLIMENTS,
  GREETINGS,
  HUNGRY_LINES,
  FED_LINES,
  STUFFED_LINES,
  POKE_LINES,
  SEARCH_ENGINES,
  pick,
  evaluate,
  extractMath,
  searchUrl,
  detectSearch,
  answer,
  organize,
};
