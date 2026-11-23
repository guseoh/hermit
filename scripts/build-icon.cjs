// Builds assets/hermit.ico (and a preview PNG) from the two SVG masters with Electron's renderer.
// Run: npx electron scripts/build-icon.cjs   (or: node_modules\electron\dist\electron.exe scripts/build-icon.cjs)
// 16-32px use assets/hermit-small.svg (full-bleed, thicker strokes); 40px and up use assets/hermit.svg.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
const root = path.join(__dirname, '..');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function render(win, svgFile, size) {
  const svg = fs.readFileSync(path.join(root, svgFile), 'utf8');
  const html = `<html><body style="margin:0;background:transparent">
    <img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  win.setContentSize(size, size);
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise(resolve => setTimeout(resolve, 150));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map(image => image.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true } });
  const images = [];
  for (const size of sizes) {
    images.push({ size, png: await render(win, size <= 32 ? 'assets/hermit-small.svg' : 'assets/hermit.svg', size) });
  }
  fs.writeFileSync(path.join(root, 'assets', 'hermit.ico'), packIco(images));
  fs.writeFileSync(path.join(root, 'assets', 'hermit-256.png'), images.at(-1).png);
  if (process.env.ICON_PREVIEW_DIR) {
    for (const { size, png } of images) fs.writeFileSync(path.join(process.env.ICON_PREVIEW_DIR, `hermit-${size}.png`), png);
  }
  console.log('assets/hermit.ico:', images.map(image => image.size).join(', '));
  app.quit();
});
