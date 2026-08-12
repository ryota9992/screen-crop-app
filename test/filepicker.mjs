/**
 * 「写真を選択」をタップしたときに、写真の選択画面が開く作りになっているかを
 * 確かめる。
 *
 * 動かしているアプリに対して実行する:
 *   npm run build && npx next start -p 3111
 *   APP_URL=http://localhost:3111 node test/filepicker.mjs
 *
 * 【このテストで分かること・分からないこと】
 * iOS では display:none のファイル入力はタップしても選択画面が開かないことが
 * ある（v1.14.1 で実際に起きた）。ところが Chromium は display:none でも開くため、
 * 「タップで開いたか」だけを見ても iOS の不具合は捕まえられない。手元で確かめて
 * あるが、旧実装（display:none）でも Chromium では開いてしまう。
 *
 * そこで、iOS で開くための必要条件である「入力要素が実際に描画されていること」を
 * 主な判定にする。旧実装はここで落ちる（大きさ 0x0）。
 * iOS の実機での動作そのものは、このテストでは保証できない。
 */
import { chromium } from 'playwright-core';

const base = process.env.APP_URL || 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[err]', e.message));
await page.goto(base, { waitUntil: 'networkidle' });

const shape = await page.evaluate(() => {
  const el = document.querySelector('input[type=file]');
  if (!el) return { ある: false };
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    ある: true,
    display: style.display,
    visibility: style.visibility,
    大きさ: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    描画されている: rect.width > 0 && rect.height > 0,
  };
});
console.log('ファイル入力:', JSON.stringify(shape));

let opened = false;
page.on('filechooser', () => {
  opened = true;
});
await page.getByText('写真を選択（複数可）').click();
await page.waitForTimeout(500);
console.log(`タップで選択画面が開いた（Chromium では旧実装でも開く）: ${opened}`);

const ok = shape.ある && shape.描画されている && shape.display !== 'none' && opened;
console.log(ok ? 'OK   iOS でも開く作りになっている' : 'NG   iOS では開かない作りになっている');
await browser.close();
process.exit(ok ? 0 : 1);
