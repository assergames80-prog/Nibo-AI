'use strict';

// Dev helper: launches Nibo against a fake Groq API, plays a few scenes and
// saves screenshots (plus docs/screenshot.png, the README montage). Run with:
//   npx electron scripts/screenshot.js [--out=dir]     (xvfb-run -a ... on Linux)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startMockGroq } = require('../test/mock-groq');

const OUT = path.resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) || 'screenshots');
const MONTAGE = path.join(__dirname, '..', 'docs', 'screenshot.png');
const MONTAGE_SCENES = [
  ['greeting', 'Floats on your desktop'],
  ['menu', 'Right-click for silly presets'],
  ['answer', 'Ask him anything (Groq)'],
  ['feed-happy', 'Feed him carrots 🥕'],
  ['dance', 'Dance party!'],
];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-shots-'));
app.setPath('userData', profile);

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
  { name: 'feed-throw', js: `document.getElementById('feed-btn').click();`, wait: 420 },
  { name: 'feed-munch', wait: 900 },
  { name: 'feed-happy', wait: 1500 },
  { name: 'dance', js: `document.querySelector('[data-preset="dance"]').click();`, wait: 900 },
  { name: 'organize', js: `document.querySelector('[data-preset="organize"]').click();`, wait: 1900 },
  { name: 'nap', js: `document.querySelector('[data-preset="nap"]').click(); window.NiboBubble.hide();`, wait: 2600 },
];

async function main() {
  const mock = await startMockGroq({
    reply: 'Bunnies munch on hay, leafy greens and the occasional carrot treat! 🥕 Hay should be most of the menu.',
    chunkDelayMs: 60,
  });
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

  await montage(win);
  await mock.close();
  app.exit(0);
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
  const height = Math.round(600 * zoom);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: PH; src: url(data:font/woff2;base64,${font}); }
    html { zoom: ${zoom}; overflow: hidden; }
    body { margin: 0; width: ${MONTAGE_SCENES.length * 370}px; height: 600px; display: flex; justify-content: center; gap: 4px;
      background: linear-gradient(160deg, #b9e3ff 0%, #e9dcff 50%, #ffd9ea 100%); font-family: PH, cursive; }
    figure { margin: 0; display: flex; flex-direction: column; align-items: center; }
    .shot { width: 360px; height: 520px; background-position: 0 -100px; background-repeat: no-repeat; }
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
