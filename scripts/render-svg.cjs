// Рендер SVG в PNG через Electron: node main.cjs <svg> <png> <ширина> <высота>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [svg, png, w, h] = process.argv.slice(process.argv.indexOf('--') + 1);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const W = Number(w), H = Number(h);
  const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const data = fs.readFileSync(svg, 'utf8');
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(data).toString('base64')}" width="${W}" height="${H}"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
  fs.writeFileSync(png, img.toPNG());
  app.quit();
});
