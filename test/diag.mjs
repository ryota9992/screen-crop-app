/**
 * 1枚の写真について、検出のどの経路が動いたか・向き判定のどの分岐で
 * 決まったかを調べる。原因の切り分け用。テストではない。
 *
 *   node test/diag.mjs lib/autoCrop.js IMG_7003
 */
import { chromium } from 'playwright-core';
import fs from 'fs';

const S = process.env.TEST_DIR || './test/data';
const lib = fs.readFileSync(process.argv[2] || 'lib/autoCrop.js', 'utf8').replace(/^export /gm, '');
const name = process.argv[3] || 'IMG_7003';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[err]', e.message));
page.on('console', (m) => console.log('[log]', m.text()));
await page.setContent('<body></body>');
await page.addScriptTag({ content: lib });

const url = 'data:image/jpeg;base64,' + fs.readFileSync(`${S}/${name}.jpeg`).toString('base64');

const out = await page.evaluate(async (u) => {
  const img = await new Promise((r) => {
    const i = new Image();
    i.onload = () => r(i);
    i.src = u;
  });
  const base = imageToCanvas(img);
  const info = { 読み込み: `${img.naturalWidth}x${img.naturalHeight}`, 解析元: `${base.width}x${base.height}` };

  // --- どちらの経路が動いたか ---
  const body = detectDeviceBody(base);
  info.本体検出 = body ? body.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' / ') : 'なし（画面経路）';

  // どんな明るい領域が見つかり、どれが画面の候補として使われたか
  {
    const { canvas: small } = downscale(base, 640);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const luma = toLuma(sctx.getImageData(0, 0, small.width, small.height));
    const th = otsuThreshold(luma);
    const mask = new Uint8Array(luma.length);
    for (let i = 0; i < luma.length; i++) mask[i] = luma[i] > th ? 1 : 0;
    const maxSide = Math.max(small.width, small.height);
    const raw = findComponents(mask, luma, small.width, small.height, small.width * small.height * 0.004);
    const box = (c) => {
      let a = 1e9, b = 1e9, x2 = -1e9, y2 = -1e9;
      for (const p of c.points) {
        a = Math.min(a, p.x); x2 = Math.max(x2, p.x);
        b = Math.min(b, p.y); y2 = Math.max(y2, p.y);
      }
      return `${a},${b}-${x2},${y2}`;
    };
    info.解析サイズ = `${small.width}x${small.height}`;
    info.二値化しきい値 = th;
    info.成分 = raw.map((c) => ({
      位置: box(c),
      面積: c.area,
      輝度: Math.round(c.meanLuma),
      端に接する: c.touchesBorder,
      縁と判定: isThinRim(c, maxSide),
    }));
  }

  const quad = detectScreenQuad(base);
  if (!quad) return { ...info, 結果: '検出失敗' };
  info.四隅 = quad.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' / ');

  const w = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const h = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  info.四隅の縦横比 = +(Math.max(w, h) / Math.min(w, h)).toFixed(3);
  info.画像に対する面積比 = +(((w * h) / (base.width * base.height)) * 100).toFixed(1) + '%';

  const warped = warpPerspective(base, quad);
  info.切り出し = `${warped.width}x${warped.height}`;

  // --- 向き判定の中身を再現して、どの分岐で決まったかを見る ---
  const FLIP_SIDE = 160;
  const scale = FLIP_SIDE / Math.max(warped.width, warped.height);
  const sm = document.createElement('canvas');
  sm.width = Math.max(1, Math.round(warped.width * scale));
  sm.height = Math.max(1, Math.round(warped.height * scale));
  const sx = sm.getContext('2d', { willReadFrequently: true });
  sx.drawImage(warped, 0, 0, sm.width, sm.height);
  const d = sx.getImageData(0, 0, sm.width, sm.height).data;
  const rowL = new Float64Array(sm.height);
  const rowS = new Float64Array(sm.height);
  for (let y = 0; y < sm.height; y++) {
    let l = 0;
    let s = 0;
    for (let x = 0; x < sm.width; x++) {
      const i = (y * sm.width + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      l += (r * 299 + g * 587 + b * 114) / 1000;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      s += mx === 0 ? 0 : (mx - mn) / mx;
    }
    rowL[y] = l / sm.width;
    rowS[y] = s / sm.width;
  }
  // 比較用: 行の平均ではなく「暗いピクセルが行の何割か」で測るとどうなるか
  const darkFrac = (limit) => {
    const f = new Float64Array(sm.height);
    for (let y = 0; y < sm.height; y++) {
      let n = 0;
      for (let x = 0; x < sm.width; x++) {
        const i = (y * sm.width + x) * 4;
        if ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < limit) n++;
      }
      f[y] = n / sm.width;
    }
    return f;
  };
  const sorted = Array.from(rowL).sort((a, b) => a - b);
  const bright = sorted[Math.floor(sorted.length * 0.9)];
  const darkLimit = bright * 0.35;
  let top = 0;
  let bottom = sm.height - 1;
  while (top < sm.height * 0.25 && rowL[top] < darkLimit) top++;
  while (bottom > sm.height * 0.75 && rowL[bottom] < darkLimit) bottom--;
  const topDark = top;
  const bottomDark = sm.height - 1 - bottom;
  const significant = sm.height * 0.02;
  const band = Math.max(1, Math.round((bottom - top) * 0.06));
  const avg = (from, n, arr) => {
    let t = 0;
    for (let i = 0; i < n; i++) t += arr[from + i];
    return t / n;
  };
  info.向き判定 = {
    縮小: `${sm.width}x${sm.height}`,
    明るい行: +bright.toFixed(1),
    暗い基準: +darkLimit.toFixed(1),
    上の黒帯: topDark,
    下の黒帯: bottomDark,
    黒帯で判断できる: Math.max(topDark, bottomDark) > significant && Math.min(topDark, bottomDark) < Math.max(topDark, bottomDark) * 0.5,
    上の彩度: +avg(top, band, rowS).toFixed(3),
    下の彩度: +avg(bottom - band + 1, band, rowS).toFixed(3),
    上の明るさ: +avg(top, band, rowL).toFixed(1),
    下の明るさ: +avg(bottom - band + 1, band, rowL).toFixed(1),
  };

  // 「行の大部分が暗い」で測り直したらどうなるか
  const frac = darkFrac(darkLimit);
  for (const ratio of [0.6, 0.75, 0.9]) {
    let t = 0;
    let b = sm.height - 1;
    while (t < sm.height * 0.25 && frac[t] >= ratio) t++;
    while (b > sm.height * 0.75 && frac[b] >= ratio) b--;
    info[`割合${ratio}での黒帯`] = `上${t} / 下${sm.height - 1 - b}`;
  }
  info.行ごとの暗い割合上10 = Array.from(frac.slice(0, 10)).map((v) => +v.toFixed(2)).join(' ');
  info.行ごとの暗い割合下10 = Array.from(frac.slice(-10)).map((v) => +v.toFixed(2)).join(' ');

  const oriented = autoOrient(warped);
  info.適用した回転 = oriented.rotation;

  // 目視用に画像を返す
  const overlay = document.createElement('canvas');
  overlay.width = base.width;
  overlay.height = base.height;
  const ox = overlay.getContext('2d');
  ox.drawImage(base, 0, 0);
  ox.strokeStyle = '#00e5ff';
  ox.lineWidth = Math.max(4, base.width * 0.006);
  ox.beginPath();
  quad.forEach((p, i) => (i ? ox.lineTo(p.x, p.y) : ox.moveTo(p.x, p.y)));
  ox.closePath();
  ox.stroke();
  if (body) {
    ox.strokeStyle = '#ff3b6b';
    ox.beginPath();
    body.forEach((p, i) => (i ? ox.lineTo(p.x, p.y) : ox.moveTo(p.x, p.y)));
    ox.closePath();
    ox.stroke();
  }
  return { ...info, overlay: overlay.toDataURL('image/jpeg', 0.85), result: oriented.canvas.toDataURL('image/jpeg', 0.85) };
}, url);

const { overlay, result, ...info } = out;
console.log(JSON.stringify(info, null, 2));
for (const [key, data] of Object.entries({ overlay, result })) {
  if (!data) continue;
  fs.writeFileSync(`${S}/${name}_${key}.jpg`, Buffer.from(data.split(',')[1], 'base64'));
  console.log(`書き出し: ${S}/${name}_${key}.jpg`);
}
await browser.close();
