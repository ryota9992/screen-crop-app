/**
 * 向き判定（autoOrient）のテスト。
 *
 * 実写真ではなく、画面らしい絵をその場で描いて使う。個人の写真を用意しなくても
 * 走るので、CI でもそのまま回せる。
 *
 * 考え方: 正立した画面 U を k 度回した画像を入れたら、autoOrient は
 * 「k を打ち消す回転」を返さなければならない。つまり (k + rotation) % 360 === 0。
 * 横向き（k=90/270）は、実際に横向きで撮った写真に対応する。
 */
import { chromium } from 'playwright-core';
import fs from 'fs';

const lib = fs.readFileSync(process.argv[2] || 'lib/autoCrop.js', 'utf8').replace(/^export /gm, '');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[err]', e.message));
await page.setContent('<body></body>');
await page.addScriptTag({ content: lib });

const results = await page.evaluate(() => {
  const W = 700;

  /** 角丸の四角形 */
  const roundRect = (x, cx, cy, w, h, r, fill) => {
    x.fillStyle = fill;
    x.beginPath();
    x.moveTo(cx + r, cy);
    x.arcTo(cx + w, cy, cx + w, cy + h, r);
    x.arcTo(cx + w, cy + h, cx, cy + h, r);
    x.arcTo(cx, cy + h, cx, cy, r);
    x.arcTo(cx, cy, cx + w, cy, r);
    x.closePath();
    x.fill();
  };

  /** バーコードらしい縦縞 */
  const barcode = (x, cx, cy, w, h) => {
    x.fillStyle = '#111';
    let px = cx;
    let seed = 7;
    while (px < cx + w) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const bar = 2 + (seed % 5);
      const gap = 2 + ((seed >> 8) % 5);
      x.fillRect(px, cy, bar, h);
      px += bar + gap;
    }
  };

  /** 文字らしい細い横棒の列 */
  const textLines = (x, cx, cy, w, rows, color, lineH) => {
    x.fillStyle = color;
    for (let i = 0; i < rows; i++) {
      x.fillRect(cx, cy + i * lineH * 2, w * (i % 2 ? 0.72 : 0.94), lineH);
    }
  };

  /**
   * 画面の絵を描く。frame でどこまで含めた切り出しかを変えられる。
   *   'none'  … 表示面ぴったり（理想）
   *   'bezel' … 表示面＋本体の黒い枠。iPhone はホームボタン側のほうが広い
   *   'case'  … さらに明るい色のケースの縁まで（検出が本体の外周を拾った状態）
   */
  const render = (kind, frame) => {
    const inner = { w: W, h: Math.round(W * 1.779) };
    const pad =
      frame === 'none'
        ? { top: 0, bottom: 0, side: 0 }
        : { top: Math.round(inner.h * 0.045), bottom: Math.round(inner.h * 0.095), side: Math.round(inner.w * 0.035) };
    const rim = frame === 'case' ? Math.round(inner.w * 0.03) : 0;
    const cv = document.createElement('canvas');
    cv.width = inner.w + pad.side * 2 + rim * 2;
    cv.height = inner.h + pad.top + pad.bottom + rim * 2;
    const x = cv.getContext('2d', { willReadFrequently: true });
    if (rim) {
      // 明るい色のケース。外周だけが明るく、内側は本体の黒。
      x.fillStyle = '#7fd4cf';
      x.fillRect(0, 0, cv.width, cv.height);
    }
    x.fillStyle = '#000';
    x.fillRect(rim, rim, cv.width - rim * 2, cv.height - rim * 2);
    if (rim) {
      // ホームボタン（下）とインカメラ・スピーカー（上）
      const cx = cv.width / 2;
      x.fillStyle = '#141414';
      x.beginPath();
      x.arc(cx, cv.height - rim - pad.bottom * 0.5, pad.bottom * 0.3, 0, 7);
      x.fill();
      x.fillRect(cx - inner.w * 0.09, rim + pad.top * 0.4, inner.w * 0.18, pad.top * 0.2);
    }
    x.save();
    x.translate(pad.side + rim, pad.top + rim);
    const w = inner.w;
    const h = inner.h;

    if (kind === 'barcode') {
      // 失敗報告と同じ構成: 上に色付きのバー、真ん中に白いカード、
      // 下 3 割が真っ黒（アプリの背景）。
      x.fillStyle = '#10131a';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#cfe4f5';
      x.fillRect(0, 0, w, h * 0.085);
      textLines(x, w * 0.05, h * 0.015, w * 0.35, 1, '#2a3542', 6);
      textLines(x, w * 0.4, h * 0.05, w * 0.3, 1, '#2a3542', 6);
      roundRect(x, w * 0.06, h * 0.11, w * 0.88, h * 0.27, 16, '#f4f2ec');
      roundRect(x, w * 0.09, h * 0.13, w * 0.28, h * 0.035, 6, '#c8352a');
      barcode(x, w * 0.16, h * 0.24, w * 0.68, h * 0.07);
      textLines(x, w * 0.12, h * 0.325, w * 0.76, 2, '#3a3a3a', 5);
      roundRect(x, w * 0.06, h * 0.41, w * 0.88, h * 0.22, 16, '#f4f2ec');
      barcode(x, w * 0.16, h * 0.46, w * 0.68, h * 0.07);
      x.fillStyle = '#8fc866';
      x.fillRect(w * 0.06, h * 0.56, w * 0.88, h * 0.03);
      textLines(x, w * 0.12, h * 0.6, w * 0.7, 1, '#3a3a3a', 5);
      roundRect(x, w * 0.06, h * 0.66, w * 0.88, h * 0.06, 12, '#efe9e0');
      textLines(x, w * 0.12, h * 0.68, w * 0.7, 1, '#8a2a22', 5);
      // ここから下は真っ黒。ベゼルと地続きに見える領域。
      x.fillStyle = '#000';
      x.fillRect(0, h * 0.74, w, h * 0.26);
    } else if (kind === 'home') {
      // ホーム画面: 暗い壁紙に明るいアイコン。上下逆の報告があった構成。
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#1b2436');
      g.addColorStop(1, '#3a2a3d');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      textLines(x, w * 0.06, h * 0.02, w * 0.22, 1, '#f2f2f2', 6);
      textLines(x, w * 0.74, h * 0.02, w * 0.2, 1, '#f2f2f2', 6);
      const colors = ['#e8524a', '#4aa3e8', '#5fc36a', '#f0b429', '#8f6ed5', '#e87ab0'];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 4; c++) {
          roundRect(x, w * (0.08 + c * 0.22), h * (0.09 + r * 0.115), w * 0.15, w * 0.15, 18, colors[(r * 4 + c) % colors.length]);
        }
      }
      x.fillStyle = 'rgba(255,255,255,0.22)';
      x.fillRect(w * 0.04, h * 0.87, w * 0.92, h * 0.11);
      for (let c = 0; c < 4; c++) {
        roundRect(x, w * (0.08 + c * 0.22), h * 0.885, w * 0.15, w * 0.15, 18, colors[c]);
      }
    } else if (kind === 'list') {
      // 明るいリスト画面: 上に色付きのナビゲーションバー、下に淡いタブバー。
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#2b7de9';
      x.fillRect(0, 0, w, h * 0.105);
      textLines(x, w * 0.32, h * 0.055, w * 0.36, 1, '#ffffff', 7);
      for (let i = 0; i < 9; i++) {
        textLines(x, w * 0.08, h * (0.15 + i * 0.075), w * 0.7, 2, '#4a4a4a', 6);
        x.fillStyle = '#e6e6e6';
        x.fillRect(w * 0.08, h * (0.19 + i * 0.075), w * 0.84, 2);
      }
      x.fillStyle = '#f2f2f4';
      x.fillRect(0, h * 0.93, w, h * 0.07);
    }
    x.restore();
    return cv;
  };

  const rotate = (cv, deg) => (deg === 0 ? cv : rotateCanvas(cv, deg));

  const out = [];
  for (const kind of ['barcode', 'home', 'list']) {
    for (const frame of ['none', 'bezel', 'case']) {
      for (const k of [0, 90, 180, 270]) {
        const upright = render(kind, frame);
        const input = rotate(upright, k);
        const { rotation } = autoOrient(input);
        out.push({
          name: `${kind}${frame === 'none' ? '' : '+' + frame} を${k}度回した`,
          期待: (360 - k) % 360,
          結果: rotation,
          ok: (k + rotation) % 360 === 0,
        });
      }
    }
  }
  return out;
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'OK  ' : 'NG  '} ${r.name}: 期待 ${r.期待}度 / 結果 ${r.結果}度`);
}
console.log(`\n${results.length - failed}/${results.length} 合格`);
await browser.close();
process.exit(failed ? 1 : 0);
