'use strict';

// Dev helper: launches Nibo against a fake Groq API, plays a few scenes and
// saves screenshots (plus docs/screenshot.png, the README montage). Run with:
//   npx electron scripts/screenshot.js [--out=dir]     (xvfb-run -a ... on Linux)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startMockGroq } = require('../test/mock-groq');
const { startMockTavily } = require('../test/mock-tavily');

const OUT = path.resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) || 'screenshots');
const MONTAGE = path.join(__dirname, '..', 'docs', 'screenshot.png');
const MONTAGE_SCENES = [
  ['greeting', 'Floats on your desktop'],
  ['menu', 'Right-click for silly presets'],
  ['answer', 'Ask him anything (Groq)'],
  ['search', 'Searches the web 🔎'],
  ['feed-happy', 'Feed him carrots 🥕'],
];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-shots-'));
app.setPath('userData', profile);

// A messy demo Desktop for the tidy-up popup screenshot.
const demoHome = path.join(profile, 'Bunny');
const demoDesktop = path.join(demoHome, 'Desktop');
fs.mkdirSync(path.join(demoDesktop, 'Pictures'), { recursive: true });
const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
for (const f of ['beach-day.jpg', 'cat.png', 'meme.gif', 'taxes-2025.pdf', 'grocery list.txt', 'resume.docx', 'lofi beats.mp3', 'game-setup.exe', 'photos-backup.zip', 'homework.py', 'Chrome.lnk']) {
  const file = path.join(demoDesktop, f);
  fs.writeFileSync(file, Buffer.alloc(2048 + f.length * 5000));
  fs.utimesSync(file, longAgo, longAgo);
}
fs.writeFileSync(path.join(demoDesktop, 'Pictures', 'cat.png'), 'an older cat');
app.setPath('home', demoHome);
app.setPath('desktop', demoDesktop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENES = [
  { name: 'greeting', wait: 1800 },
  { name: 'hover', js: `document.body.classList.add('show-ui'); window.NiboBubble.hide();`, wait: 600 },
  { name: 'menu', js: `document.getElementById('preset-btn').click();`, wait: 500 },
  {
    name: 'ask',
    js: `document.getElementById('menu').classList.add('hidden');
         const i = document.getElementById('ask'); i.value = 'What do bunnies eat?';
         document.getElementById('prompt').requestSubmit();`,
    wait: 450,
  },
  { name: 'answer', wait: 1600 },
  {
    name: 'search',
    js: `{ const i = document.getElementById('ask'); i.value = "What's the weather in Paris today?";
         document.getElementById('prompt').requestSubmit(); }`,
    wait: 3200,
  },
  { name: 'feed-throw', js: `document.getElementById('feed-btn').click();`, wait: 420 },
  { name: 'feed-munch', wait: 900 },
  { name: 'feed-happy', wait: 1500 },
  { name: 'dance', js: `document.querySelector('[data-preset="dance"]').click();`, wait: 900 },
  { name: 'organize', js: `document.querySelector('[data-preset="organize"]').click();`, wait: 700 },
  { name: 'nap', js: `document.querySelector('[data-preset="nap"]').click(); window.NiboBubble.hide();`, wait: 2600 },
];

async function main() {
  const mock = await startMockGroq({
    reply: (body) =>
      body.messages.some((m) => m.role === 'tool')
        ? "It's sunny and 21°C in Paris today. ☀️ Perfect picnic weather, says weather.example.com!"
        : 'Bunnies munch on hay, leafy greens and the occasional carrot treat! 🥕 Hay should be most of the menu.',
    toolCall: (body) =>
      /weather/i.test(body.messages.at(-1).content) ? { name: 'web_search', arguments: '{"query":"Paris weather today"}' } : null,
    chunkDelayMs: 60,
  });
  const tavily = await startMockTavily({ validKey: 'tvly-screenshot-only' });
  process.env.TAVILY_BASE_URL = tavily.url;
  process.env.TAVILY_API_KEY = 'tvly-screenshot-only';
  process.env.GROQ_BASE_URL = mock.url;
  process.env.GROQ_API_KEY = 'gsk_screenshot_only';
  require('../src/main/main.js');

  await app.whenReady();
  await sleep(1500);
  const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Nibo AI');
  fs.mkdirSync(OUT, { recursive: true });

  for (const scene of SCENES) {
    if (scene.js) await win.webContents.executeJavaScript(scene.js);
    await sleep(scene.wait);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${scene.name}.png`), image.toPNG());
    console.log(`saved ${scene.name}.png`);
  }

  await tidyPopup(win);
  await montage(win);
  await mock.close();
  await tavily.close();
  app.exit(0);
}

// Ask Nibo to tidy the demo Desktop and capture the approval popup.
async function tidyPopup(win) {
  await win.webContents.executeJavaScript(`document.querySelector('[data-preset="organize"]').click();
    setTimeout(() => [...document.querySelectorAll('#bubble-actions button')].find((b) => b.textContent.includes('Desktop')).click(), 300);`);
  await sleep(2000);
  const popup = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('tidy'));
  await popup.webContents.executeJavaScript(`const box = [...document.querySelectorAll('.files input')].find((c) => c.closest('label').title === 'resume.docx');
    box.checked = false; box.dispatchEvent(new Event('change'));`);
  await sleep(300);
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'tidy-up.png'), (await popup.webContents.capturePage()).toPNG());
  console.log('saved docs/tidy-up.png');
  popup.close();
  await sleep(500);
}

// Put a few scenes side by side on a pastel "desktop" for the README.
async function montage(win) {
  const font = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'fonts', 'PatrickHand.woff2')).toString('base64');
  const tiles = MONTAGE_SCENES.map(([name, caption]) => {
    const png = fs.readFileSync(path.join(OUT, `${name}.png`)).toString('base64');
    return `<figure><div class="shot" style="background-image:url(data:image/png;base64,${png})"></div><figcaption>${caption}</figcaption></figure>`;
  }).join('');
  const zoom = 0.8; // keep the montage narrower than the (virtual) screen
  const width = Math.round(MONTAGE_SCENES.length * 370 * zoom);
  const height = Math.round(640 * zoom);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: PH; src: url(data:font/woff2;base64,${font}); }
    html { zoom: ${zoom}; overflow: hidden; }
    body { margin: 0; width: ${MONTAGE_SCENES.length * 370}px; height: 640px; display: flex; justify-content: center; gap: 4px;
      background: linear-gradient(160deg, #b9e3ff 0%, #e9dcff 50%, #ffd9ea 100%); font-family: PH, cursive; }
    figure { margin: 0; display: flex; flex-direction: column; align-items: center; }
    .shot { width: 360px; height: 565px; background-position: 0 -55px; background-repeat: no-repeat; }
    figcaption { margin-top: 6px; font-size: 26px; color: #3b2c5a; }
  </style></head><body>${tiles}</body></html>`;
  const shot = new BrowserWindow({ width, height, show: false, frame: false, webPreferences: { offscreen: true } });
  await shot.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await sleep(500);
  const image = await shot.webContents.capturePage();
  fs.mkdirSync(path.dirname(MONTAGE), { recursive: true });
  fs.writeFileSync(MONTAGE, image.toPNG());
  shot.destroy();
  console.log('saved docs/screenshot.png');
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
