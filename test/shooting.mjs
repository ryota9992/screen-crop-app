/**
 * 撮り方（机の明るさ・傾き・ケースの明るさ・余白）を振って、検出の誤差が
 * どこで壊れるかを測る。撮影の指針を推測ではなく数字で決めるためのもの。
 *
 *   node test/shooting.mjs lib/autoCrop.js
 *
 * 合成なので実写真の代わりにはならないが、「どの条件が効くか」の傾向は分かる。
 */
import { chromium } from 'playwright-core';
import fs from 'fs';

const S = process.env.TEST_DIR || './test/data';
const lib = fs.readFileSync(process.argv[2] || 'lib/autoCrop.js', 'utf8').replace(/^export /gm, '');
const screenImg = 'data:image/jpeg;base64,' + fs.readFileSync(`${S}/final.jpg`).toString('base64');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[err]', e.message));
await page.setContent('<body></body>');
await page.addScriptTag({ content: lib });

const run = async (cases) =>
  page.evaluate(
    async ({ u, cases }) => {
      const img = await new Promise((r) => {
        const i = new Image();
        i.onload = () => r(i);
        i.src = u;
      });
      const src = document.createElement('canvas');
      src.width = img.naturalWidth;
      src.height = img.naturalHeight;
      src.getContext('2d').drawImage(img, 0, 0);
      const sdata = src
        .getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, src.width, src.height);

      const drawQuad = (dst, quad) => {
        const rect = [
          { x: 0, y: 0 },
          { x: src.width - 1, y: 0 },
          { x: src.width - 1, y: src.height - 1 },
          { x: 0, y: src.height - 1 },
        ];
        const h = computeHomography(quad, rect);
        const xs = quad.map((q) => q.x);
        const ys = quad.map((q) => q.y);
        const x0 = Math.max(0, Math.floor(Math.min(...xs)));
        const x1 = Math.min(dst.width - 1, Math.ceil(Math.max(...xs)));
        const y0 = Math.max(0, Math.floor(Math.min(...ys)));
        const y1 = Math.min(dst.height - 1, Math.ceil(Math.max(...ys)));
        const dctx = dst.getContext('2d', { willReadFrequently: true });
        const dd = dctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        const W = x1 - x0 + 1;
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const w = h[6] * x + h[7] * y + h[8];
            const u2 = (h[0] * x + h[1] * y + h[2]) / w;
            const v2 = (h[3] * x + h[4] * y + h[5]) / w;
            if (!(u2 >= 0 && v2 >= 0 && u2 <= src.width - 1 && v2 <= src.height - 1)) continue;
            const si = (Math.round(v2) * src.width + Math.round(u2)) * 4;
            const di = ((y - y0) * W + (x - x0)) * 4;
            dd.data[di] = sdata.data[si];
            dd.data[di + 1] = sdata.data[si + 1];
            dd.data[di + 2] = sdata.data[si + 2];
            dd.data[di + 3] = 255;
          }
        dctx.putImageData(dd, x0, y0);
      };

      const results = [];
      for (const c of cases) {
        const W = 2400;
        const H = 3200;
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        const x = cv.getContext('2d');
        // 机。desk は 0〜255 の明るさ
        x.fillStyle = `rgb(${c.desk},${Math.round(c.desk * 0.92)},${Math.round(c.desk * 0.8)})`;
        x.fillRect(0, 0, W, H);
        for (let i = 0; i < W; i += 7) {
          x.fillStyle = `rgba(0,0,0,${0.04 + 0.03 * Math.sin(i * 0.3)})`;
          x.fillRect(i, 0, 4, H);
        }
        const cx = W / 2;
        const cy = H / 2;
        const sw = c.scale * W / 2;
        const sh = sw * (src.height / src.width);
        const rad = (c.rot * Math.PI) / 180;
        const base = [
          { x: -sw / 2, y: -sh / 2 },
          { x: sw / 2, y: -sh / 2 },
          { x: sw / 2, y: sh / 2 },
          { x: -sw / 2, y: sh / 2 },
        ];
        const truth = base.map((q, i) => {
          const k = i === 0 || i === 1 ? 1 - c.persp : 1 + c.persp;
          const qx = q.x * k;
          const qy = q.y;
          return {
            x: cx + qx * Math.cos(rad) - qy * Math.sin(rad),
            y: cy + qx * Math.sin(rad) + qy * Math.cos(rad),
          };
        });
        // 本体（黒）とケースの縁
        const body = truth.map((q) => ({ x: cx + (q.x - cx) * 1.1, y: cy + (q.y - cy) * 1.16 }));
        const rim = truth.map((q) => ({ x: cx + (q.x - cx) * 1.16, y: cy + (q.y - cy) * 1.22 }));
        if (c.rim > 0) {
          x.fillStyle = `rgb(${Math.round(c.rim * 0.5)},${c.rim},${Math.round(c.rim * 0.95)})`;
          x.beginPath();
          rim.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)));
          x.closePath();
          x.fill();
        }
        x.fillStyle = '#0d0d0f';
        x.beginPath();
        body.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)));
        x.closePath();
        x.fill();
        drawQuad(cv, truth);
        // 画面の明るさ（表示の輝度を下げた状態を模擬する）
        if (c.dim != null && c.dim < 1) {
          const xs2 = truth.map((q) => q.x);
          const ys2 = truth.map((q) => q.y);
          const bx = Math.max(0, Math.floor(Math.min(...xs2)));
          const by = Math.max(0, Math.floor(Math.min(...ys2)));
          const bw = Math.min(cv.width - bx, Math.ceil(Math.max(...xs2)) - bx);
          const bh = Math.min(cv.height - by, Math.ceil(Math.max(...ys2)) - by);
          const ctx2 = cv.getContext('2d', { willReadFrequently: true });
          const d2 = ctx2.getImageData(bx, by, bw, bh);
          for (let i = 0; i < d2.data.length; i += 4) {
            d2.data[i] *= c.dim;
            d2.data[i + 1] *= c.dim;
            d2.data[i + 2] *= c.dim;
          }
          ctx2.putImageData(d2, bx, by);
        }

        const quad = detectScreenQuad(cv);
        if (!quad) {
          results.push({ ...c, 検出: '失敗' });
          continue;
        }
        const ang = (q) => (Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180) / Math.PI;
        const err = quad.map((q, i) => Math.hypot(q.x - truth[i].x, q.y - truth[i].y));
        results.push({
          ...c,
          角度誤差: +(ang(quad) - ang(truth)).toFixed(2),
          ずれpx: Math.round(err.reduce((a, b) => a + b, 0) / 4),
        });
      }
      return results;
    },
    { u: screenImg, cases }
  );

const show = (title, rows, keys) => {
  console.log(`\n=== ${title} ===`);
  for (const r of rows) {
    const label = keys.map((k) => `${k}=${r[k]}`).join(' ');
    const ok = r.検出 !== '失敗' && Math.abs(r.角度誤差) <= 0.3 && r.ずれpx <= 50;
    console.log(
      `${ok ? 'OK ' : 'NG '} ${label.padEnd(28)} 角度 ${String(r.角度誤差 ?? '-').padStart(6)}度  ずれ ${String(r.ずれpx ?? '-').padStart(4)}px`
    );
  }
};

// 1. 机の明るさ（ケース無し・真上から）
show(
  '机の明るさ（暗いほど良いか）',
  await run([20, 40, 60, 90, 120, 150, 180, 210, 240].map((desk) => ({ desk, rim: 0, scale: 0.5, rot: 2, persp: 0.02 }))),
  ['desk']
);

// 2. ケースの縁の明るさ（暗い机の上で）
show(
  'ケースの明るさ（暗い机 desk=40 の上）',
  await run([0, 40, 80, 120, 160, 200, 240].map((rim) => ({ desk: 40, rim, scale: 0.5, rot: 2, persp: 0.02 }))),
  ['rim']
);

// 3. 傾き（真上から外れる度合い）
show(
  '遠近（真上から外れるほど）',
  await run([0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16, 0.2].map((persp) => ({ desk: 40, rim: 0, scale: 0.5, rot: 2, persp }))),
  ['persp']
);

// 4. 画面の写る大きさ（寄りすぎ・引きすぎ）
show(
  '画面の大きさ（写真に対する幅の比）',
  await run([0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((scale) => ({ desk: 40, rim: 0, scale, rot: 2, persp: 0.02 }))),
  ['scale']
);

// 5. ケースの明るさの境目を細かく
show(
  'ケースの明るさ（境目を細かく）',
  await run([120, 130, 140, 150, 155, 160, 170].map((rim) => ({ desk: 40, rim, scale: 0.5, rot: 2, persp: 0.02 }))),
  ['rim']
);

// 6. 明るいケースのとき、机を暗くすれば救えるか
show(
  '明るいケース(rim=200)のとき机の明るさは効くか',
  await run([20, 60, 120, 180, 240].map((desk) => ({ desk, rim: 200, scale: 0.5, rot: 2, persp: 0.02 }))),
  ['desk']
);

// 7. 画面の明るさ（表示の輝度）
show(
  '画面の明るさ（1.0=そのまま）',
  await run([1, 0.8, 0.6, 0.45, 0.3, 0.2].map((dim) => ({ desk: 40, rim: 0, scale: 0.5, rot: 2, persp: 0.02, dim }))),
  ['dim']
);

// 8. 明るい机のとき、画面が暗いと壊れるか（IMG_6706 の状況）
show(
  '明るい机(desk=210)で画面が暗いとき',
  await run([1, 0.8, 0.6, 0.45, 0.3].map((dim) => ({ desk: 210, rim: 0, scale: 0.5, rot: 2, persp: 0.02, dim }))),
  ['dim']
);

// 9. 大きく写しすぎて写真の端に接する場合
show(
  '大きさ（1.0を超えると本体が写真の端に接する）',
  await run([0.9, 1.0, 1.1, 1.2, 1.4].map((scale) => ({ desk: 40, rim: 0, scale, rot: 2, persp: 0.02 }))),
  ['scale']
);

await browser.close();
