'use strict';

// Renders assets/icon.svg into the PNG icons Nibo ships with.
// Run with: npx electron scripts/make-icons.js   (needs a display, e.g. xvfb-run on Linux)

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const OUTPUTS = [
  { file: 'icon.png', size: 512 },
  { file: 'tray.png', size: 16 },
  { file: 'tray@2x.png', size: 32 },
  { file: 'tray@3x.png', size: 48 },
];

app.disableHardwareAcceleration();

// Each size is rasterized from the SVG directly, so small icons stay crisp.
async function render(win, svg, size) {
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${sized}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  for (const { file, size } of OUTPUTS) {
    fs.writeFileSync(path.join(ASSETS, file), await render(win, svg, size));
    console.log(`wrote assets/${file} (${size}px)`);
  }
  win.destroy();
  app.quit();
});
