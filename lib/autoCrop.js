/**
 * スマホ画面を撮影した写真から、画面部分だけを自動で検出して
 * 台形補正（射影変換）＋正立回転して切り出すためのライブラリ。
 *
 * 外部ライブラリ不要・ブラウザのみで動作（Canvas API を使用）。
 *
 * 処理の流れ:
 *   1. 解析用に縮小 → 輝度画像に変換
 *   2. 大津の二値化で「明るい領域」を抽出
 *   3. 連結成分を列挙し、画面らしさをスコアリングして1つ選ぶ
 *   4. 凸包 → 面積最大の四角形（4隅）を求める
 *   5. 4隅から射影変換行列を作り、元解像度で切り出す
 *   6. 縦長になるよう回転し、上下の向きを推定して補正
 */

const ANALYSIS_MAX_SIDE = 640; // 解析時の最大辺（速度と精度のバランス）

/* ------------------------------------------------------------------ *
 * 画像の読み込み
 * ------------------------------------------------------------------ */

export function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

/**
 * 画像を Canvas に描き込む。
 * スマホ（特に iOS Safari）はキャンバスに使えるメモリが限られているため、
 * 既定で長辺 2400px に縮小する（バーコードの読み取りには十分な解像度）。
 */
export function imageToCanvas(img, maxSide = 2400) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * 1〜3. 画面領域の検出
 * ------------------------------------------------------------------ */

function downscale(canvas, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, w, h);
  return { canvas: small, scale };
}

function toLuma(imageData) {
  const { data, width, height } = imageData;
  const luma = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    luma[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return luma;
}

/**
 * 大津の二値化のしきい値を求める。
 * maxValue を指定すると、その値以下の画素だけを対象にする。
 * 明るい物（紙など）に引っ張られずに「暗い側」をさらに分けたいときに使う。
 */
function otsuThreshold(luma, maxValue = 255) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < luma.length; i++) {
    if (luma[i] > maxValue) continue;
    hist[luma[i]]++;
    total++;
  }
  if (total === 0) return maxValue;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * 1次元の最大値/最小値フィルタ（矩形カーネルの膨張・収縮用）。
 * 単調デックを使い、半径によらず一定時間で処理する。
 */
function filter1D(src, width, height, radius, horizontal, useMax) {
  const dst = new Uint8Array(src.length);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  const deque = new Int32Array(inner);

  for (let o = 0; o < outer; o++) {
    const base = horizontal ? o * width : o;
    let head = 0;
    let tail = 0;
    // 先読み分をデックに入れておく
    for (let k = 0; k <= Math.min(inner - 1, radius); k++) {
      const v = src[base + k * step];
      while (tail > head && (useMax ? src[base + deque[tail - 1] * step] <= v
                                    : src[base + deque[tail - 1] * step] >= v)) tail--;
      deque[tail++] = k;
    }
    for (let i = 0; i < inner; i++) {
      const add = i + radius;
      if (add < inner && i > 0) {
        const v = src[base + add * step];
        while (tail > head && (useMax ? src[base + deque[tail - 1] * step] <= v
                                      : src[base + deque[tail - 1] * step] >= v)) tail--;
        deque[tail++] = add;
      }
      while (deque[head] < i - radius) head++;
      dst[base + i * step] = src[base + deque[head] * step];
    }
  }
  return dst;
}

/**
 * クロージング（膨張→収縮）。
 * スマホの画面は「明るい要素（バナー・カード）＋暗い余白」で構成されるため、
 * そのまま二値化すると要素ごとにバラバラになる。膨張で隙間を埋めてから
 * 収縮して元の大きさに戻すことで、画面全体を1つの領域として扱う。
 */
function closeMask(mask, width, height, radius) {
  let m = filter1D(mask, width, height, radius, true, true);
  m = filter1D(m, width, height, radius, false, true);
  m = filter1D(m, width, height, radius, true, false);
  m = filter1D(m, width, height, radius, false, false);
  return m;
}

/**
 * マスクの連結成分を列挙する（4近傍）。
 * 面積が小さすぎるものは捨てる。明るさは元の輝度画像から求める。
 */
function findComponents(mask, luma, width, height, minArea) {
  const labels = new Int32Array(width * height).fill(-1);
  const components = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < mask.length; start++) {
    if (labels[start] !== -1 || !mask[start]) continue;

    const id = components.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;

    let area = 0;
    let lumaSum = 0;
    let touchesBorder = false;
    // 行ごとの左端・右端だけ持てば凸包は正しく求まる
    const rowMin = new Int32Array(height).fill(-1);
    const rowMax = new Int32Array(height).fill(-1);

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;

      area++;
      lumaSum += luma[p];
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (rowMin[y] === -1 || x < rowMin[y]) rowMin[y] = x;
      if (rowMax[y] === -1 || x > rowMax[y]) rowMax[y] = x;

      if (x > 0 && labels[p - 1] === -1 && mask[p - 1]) {
        labels[p - 1] = id;
        stack[sp++] = p - 1;
      }
      if (x < width - 1 && labels[p + 1] === -1 && mask[p + 1]) {
        labels[p + 1] = id;
        stack[sp++] = p + 1;
      }
      if (y > 0 && labels[p - width] === -1 && mask[p - width]) {
        labels[p - width] = id;
        stack[sp++] = p - width;
      }
      if (y < height - 1 && labels[p + width] === -1 && mask[p + width]) {
        labels[p + width] = id;
        stack[sp++] = p + width;
      }
    }

    if (area < minArea) continue;

    const points = [];
    for (let y = 0; y < height; y++) {
      if (rowMin[y] === -1) continue;
      points.push({ x: rowMin[y], y });
      if (rowMax[y] !== rowMin[y]) points.push({ x: rowMax[y], y });
    }

    components.push({ area, meanLuma: lumaSum / area, touchesBorder, points });
  }

  return components;
}

/* ------------------------------------------------------------------ *
 * 4. 凸包 → 四角形
 * ------------------------------------------------------------------ */

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return pts;

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper); // 反時計回り（画像座標では時計回り）
}

function triangleArea(a, b, c) {
  return Math.abs(cross(a, b, c)) / 2;
}

/** 面積の減りが最小の頂点を貪欲に削って、頂点数を n まで減らす */
function simplifyHull(hull, n) {
  const pts = hull.slice();
  while (pts.length > n) {
    let worst = 0;
    let worstArea = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const next = pts[(i + 1) % pts.length];
      const a = triangleArea(prev, pts[i], next);
      if (a < worstArea) {
        worstArea = a;
        worst = i;
      }
    }
    pts.splice(worst, 1);
  }
  return pts;
}

function quadArea(q) {
  return triangleArea(q[0], q[1], q[2]) + triangleArea(q[0], q[2], q[3]);
}

/** 凸多角形から面積最大の四角形を選ぶ */
function largestQuad(hull) {
  const pts = hull.length > 12 ? simplifyHull(hull, 12) : hull;
  if (pts.length < 4) return null;
  if (pts.length === 4) return pts;

  let best = null;
  let bestArea = -1;
  const n = pts.length;
  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const quad = [pts[i], pts[j], pts[k], pts[l]];
          const area = quadArea(quad);
          if (area > bestArea) {
            bestArea = area;
            best = quad;
          }
        }
      }
    }
  }
  return best;
}

/** 左上・右上・右下・左下の順に並べ替える */
export function orderCorners(quad) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = quad
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // 左上に最も近い点（x+y が最小）を先頭にする
  let startIdx = 0;
  let minSum = Infinity;
  sorted.forEach((p, i) => {
    if (p.x + p.y < minSum) {
      minSum = p.x + p.y;
      startIdx = i;
    }
  });
  return [0, 1, 2, 3].map((i) => sorted[(startIdx + i) % 4]);
}

/* ------------------------------------------------------------------ *
 * 4.5 辺の直線あてはめによる四隅の精密化
 *
 * 明るい領域の輪郭から求めた四隅は、スマホ画面の「角丸」で角が削れるため、
 * 結んだ辺が実際の画面の縁より傾いてしまう。そこで各辺について
 * 画面の縁（＝強いエッジ）を探して直線をあてはめ、その交点を四隅とする。
 * ------------------------------------------------------------------ */

const REFINE_MAX_SIDE = 1400; // 精密化に使う画像の最大辺
// 初期の四隅は「明るい領域」から求めるため、必ず画面の内側か縁の上にある。
// したがって縁は外側にしかないので、内側はノイズ分だけ見ればよい。
// 外側を広く探しすぎると本体の輪郭に飛びつくため、控えめにする。
const OUTWARD_RATIO = 0.10; // 辺の外側を探す幅（画面サイズ比）
const INWARD_PIXELS = 2; // 辺の内側を探す幅（px）
const WEAK_EDGE_RATIO = 0.35; // 縁が弱い辺で使う閾値の比率

function sobelMagnitude(luma, width, height) {
  const mag = new Float32Array(luma.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = luma[i - width - 1];
      const t = luma[i - width];
      const tr = luma[i - width + 1];
      const l = luma[i - 1];
      const r = luma[i + 1];
      const bl = luma[i + width - 1];
      const b = luma[i + width];
      const br = luma[i + width + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      mag[i] = Math.hypot(gx, gy);
    }
  }
  return mag;
}

function sampleBilinear(arr, width, height, x, y) {
  if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = arr[y0 * width + x0] * (1 - fx) + arr[y0 * width + x1] * fx;
  const bottom = arr[y1 * width + x0] * (1 - fx) + arr[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** 上位パーセンタイル値（エッジの強さの基準に使う） */
function percentile(values, ratio) {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (max === 0) return 0;
  const bins = 256;
  const hist = new Int32Array(bins);
  for (let i = 0; i < values.length; i++) {
    hist[Math.min(bins - 1, Math.floor((values[i] / max) * (bins - 1)))]++;
  }
  const target = values.length * ratio;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= target) return (b / (bins - 1)) * max;
  }
  return max;
}

/** 主成分分析による直線あてはめ。返り値は nx*x + ny*y = c（単位法線） */
function fitLine(points) {
  const n = points.length;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // 分散共分散行列の最小固有ベクトルが法線
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const lambda = tr / 2 - Math.sqrt(disc);
  let nx = sxy;
  let ny = lambda - sxx;
  const len = Math.hypot(nx, ny);
  if (len < 1e-9) {
    nx = 0;
    ny = 1;
  } else {
    nx /= len;
    ny /= len;
  }
  return { nx, ny, c: nx * mx + ny * my };
}

/** 外れ値を落としながら直線をあてはめる */
function fitLineRobust(points) {
  let line = fitLine(points);
  for (let pass = 0; pass < 2 && points.length > 6; pass++) {
    const residuals = points.map((p) => Math.abs(line.nx * p.x + line.ny * p.y - line.c));
    const sorted = residuals.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const limit = Math.max(1.5, median * 2.5);
    const kept = points.filter((_, i) => residuals[i] <= limit);
    if (kept.length < Math.max(6, points.length * 0.5)) break;
    points = kept;
    line = fitLine(points);
  }
  return line;
}

function lineThroughPoints(a, b) {
  let nx = -(b.y - a.y);
  let ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  return { nx, ny, c: nx * a.x + ny * a.y };
}

function intersectLines(l1, l2) {
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < 1e-9) return null;
  return {
    x: (l1.c * l2.ny - l1.ny * l2.c) / det,
    y: (l1.nx * l2.c - l1.c * l2.nx) / det,
  };
}

function angleBetweenLines(l1, l2) {
  const dot = Math.abs(l1.nx * l2.nx + l1.ny * l2.ny);
  return Math.acos(Math.min(1, dot));
}

/**
 * 四隅の初期値を、実際の画面の縁に合わせて精密化する。
 * 縁が見つからない辺（画面下部の黒い余白など、背景と区別できない場合）は
 * 初期値のまま残す。
 */
export function refineQuadToEdges(canvas, quad) {
  const { canvas: work, scale } = downscale(canvas, REFINE_MAX_SIDE);
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const luma = toLuma(ctx.getImageData(0, 0, work.width, work.height));
  const strongEdge = percentile(sobelMagnitude(luma, work.width, work.height), 0.98) * 0.09;

  const q = quad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const size = Math.min(
    Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y),
    Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y)
  );
  const outward = Math.max(3, Math.round(size * OUTWARD_RATIO));
  const inward = INWARD_PIXELS;

  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const original = lineThroughPoints(a, b);

    // 外向きの法線にそろえる
    let { nx, ny } = original;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    if (nx * (midX - cx) + ny * (midY - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }

    // 辺にそって縁の候補点を集める。
    // 画面の縁が暗い（黒い画面と本体の境目など）と強いエッジが出ないため、
    // candidate が少なければ閾値を下げてもう一度探す。
    const collect = (minScore) => {
      const found = [];
      let samples = 0;
      for (let t = 0.08; t <= 0.92; t += 0.015) {
        samples++;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;

        // 「外へ向かって暗くなる」段差がいちばん大きい位置を画面の縁とみなす。
        // 本体の外周（黒い本体 → 明るい机）は逆に明るくなるので、符号で除外できる。
        // 辺にそって少し離れた3点の平均を使い、文字や模様の影響を減らす。
        const tx = (b.x - a.x) / Math.hypot(b.x - a.x, b.y - a.y);
        const ty = (b.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y);
        const stepAt = (d) => {
          let sum = 0;
          for (const o of [-2, 0, 2]) {
            const ox = px + tx * o;
            const oy = py + ty * o;
            sum += sampleBilinear(luma, work.width, work.height, ox + nx * (d - 2), oy + ny * (d - 2))
                 - sampleBilinear(luma, work.width, work.height, ox + nx * (d + 2), oy + ny * (d + 2));
          }
          return sum / 3;
        };

        let bestScore = 0;
        let bestD = 0;
        for (let d = -inward; d <= outward; d += 0.5) {
          const s = stepAt(d);
          if (s > bestScore) {
            bestScore = s;
            bestD = d;
          }
        }
        // 放物線あてはめで、頂点を0.5px刻みより細かく求める
        if (bestScore > 0) {
          const prev = stepAt(bestD - 0.5);
          const next = stepAt(bestD + 0.5);
          const denom = prev - 2 * bestScore + next;
          if (denom < 0) bestD += (0.5 * (prev - next)) / (2 * denom);
        }
        if (bestScore < minScore) continue;
        found.push({ x: px + nx * bestD, y: py + ny * bestD });
      }
      return { found, samples };
    };

    let { found: points, samples } = collect(strongEdge);
    if (points.length < samples * 0.4) {
      const weak = collect(strongEdge * WEAK_EDGE_RATIO);
      if (weak.found.length > points.length) points = weak.found;
    }

    // 支持点が少ない辺（縁がまったく見えない辺）は初期値を使う
    if (points.length < Math.max(12, samples * 0.3)) {
      lines.push(original);
      continue;
    }
    const fitted = fitLineRobust(points);
    // 元の辺から大きく傾いた場合は誤検出とみなす
    if (angleBetweenLines(fitted, original) > (12 * Math.PI) / 180) {
      lines.push(original);
      continue;
    }

    lines.push(fitted);
  }

  const refined = [];
  for (let i = 0; i < 4; i++) {
    const corner = intersectLines(lines[(i + 3) % 4], lines[i]);
    // 交点が求まらない、または元の四隅から離れすぎる場合は元の点を使う
    if (!corner || Math.hypot(corner.x - q[i].x, corner.y - q[i].y) > size * 0.25) {
      refined.push(q[i]);
    } else {
      refined.push(corner);
    }
  }
  return refined.map((p) => ({ x: p.x / scale, y: p.y / scale }));
}

const NEIGHBOR_RATIO = 0.06; // まとめる距離の上限（画像の最大辺に対する比）
const GROUP_GAP_RATIO = 0.6; // まとめる距離（対象の対角線に対する比）
const MIN_PART_RATIO = 0.0004; // 部品として扱う最小面積（画像に対する比）
const ZOOM_AREA_RATIO = 0.35; // これより小さく写っていたら周辺を切り出して再検出
const BODY_MIN_AREA_RATIO = 0.03; // 本体とみなす最小面積（画像に対する比）
const BODY_MIN_RECTANGULARITY = 0.75; // 本体とみなす四角形へのフィット具合
const DETAIL_REFERENCE_RATIO = 0.5; // 「中身がある」とみなすエッジの強さの基準

/** 領域の外接矩形 */
function boundsOf(comp) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of comp.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 外接矩形どうしの隙間（重なっていれば 0） */
function gapBetween(a, b) {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

/** 外接矩形の対角線の長さ */
function diagonalOf(b) {
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
}

/**
 * 近い領域どうしをまとめる（Union-Find）。
 * ひとつの画面が、バナーやカードごとに分かれて検出されるため。
 *
 * まとめる距離は、対象自身の大きさに応じて決める。画面が小さく写っている
 * 写真でも、画面が大きく写っている写真でも、同じ基準で判断できる。
 */
function groupNearbyComponents(components, maxGap) {
  const bounds = components.map(boundsOf);
  const gapLimit = (i, j) =>
    Math.min(maxGap, Math.max(3, GROUP_GAP_RATIO * Math.min(diagonalOf(bounds[i]), diagonalOf(bounds[j]))));
  const parent = components.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (gapBetween(bounds[i], bounds[j]) <= gapLimit(i, j)) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  components.forEach((comp, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(comp);
  });
  return [...groups.values()];
}

/**
 * 候補の内側に「中身」があるかを見る。
 * スマホの画面には文字やバーコードがあり、細かい濃淡が詰まっている。
 * 机の上の白い紙のようにのっぺりした物と区別するために使う。
 * 返り値は 0.2〜1 の係数。
 */
function contentDetail(grad, width, height, quad, reference) {
  if (reference <= 0) return 1;
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  let sum = 0;
  let count = 0;
  // 四隅から中心に寄せた格子点を見る
  for (let u = 0.1; u <= 0.9; u += 0.08) {
    for (let v = 0.1; v <= 0.9; v += 0.08) {
      const top = { x: quad[0].x + (quad[1].x - quad[0].x) * u, y: quad[0].y + (quad[1].y - quad[0].y) * u };
      const bottom = { x: quad[3].x + (quad[2].x - quad[3].x) * u, y: quad[3].y + (quad[2].y - quad[3].y) * u };
      const x = top.x + (bottom.x - top.x) * v;
      const y = top.y + (bottom.y - top.y) * v;
      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) continue;
      sum += sampleBilinear(grad, width, height, x, y);
      count++;
    }
  }
  if (count === 0) return 1;
  void cx;
  void cy;
  return Math.min(1, Math.max(0.2, sum / count / reference));
}

/**
 * 候補の四角形のすぐ外側の暗さを見る。
 * スマホの画面はベゼル（黒い枠）に囲まれているので、外周は内側よりずっと暗い。
 * 机や壁のような背景は外周も明るいままなので、これで区別できる。
 * 返り値は 0.05〜1 の係数。
 */
function surroundingDarkness(luma, width, height, quad, meanInside) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const offset = Math.max(2, length * 0.04);
    for (let t = 0.15; t <= 0.85; t += 0.05) {
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      // 中心から外向きに offset だけ離れた点を見る
      const dx = px - cx;
      const dy = py - cy;
      const len = Math.hypot(dx, dy) || 1;
      const x = px + (dx / len) * offset;
      const y = py + (dy / len) * offset;
      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) continue;
      sum += sampleBilinear(luma, width, height, x, y);
      count++;
    }
  }
  if (count === 0 || meanInside <= 0) return 1;
  const ratio = (meanInside - sum / count) / meanInside;
  return Math.min(1, Math.max(0.05, ratio));
}

/**
 * スマホ本体の輪郭を探す。
 *
 * 明るい机や床の上に置いて撮った写真では、本体（黒い枠やケース）が
 * 背景に対してはっきりした暗い塊になる。ここを先に切り出しておくと、
 * 画面の検出を本体の内側だけで行えるので、背景に惑わされない。
 *
 * 背景が暗くて本体と区別がつかない写真では null を返す（従来の処理に任せる）。
 */
function detectDeviceBody(canvas) {
  const { canvas: small, scale } = downscale(canvas, ANALYSIS_MAX_SIDE);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  const luma = toLuma(ctx.getImageData(0, 0, small.width, small.height));
  // 画面と違い、本体は「暗い側」の塊として探す。
  // 机の上に白い紙などがあると、1回の二値化では「紙」と「それ以外」で
  // 分かれてしまい、机と本体が同じ塊になる。そこで暗い側にもう一度
  // 二値化をかけて、本体だけを取り出す。
  const first = otsuThreshold(luma);
  const threshold = otsuThreshold(luma, first);
  const dark = new Uint8Array(luma.length);
  for (let i = 0; i < luma.length; i++) dark[i] = luma[i] <= threshold ? 1 : 0;

  // 画面（明るい）は本体の中の穴になるので、隙間を埋めてひとつの塊にする
  const radius = Math.max(3, Math.round(Math.max(small.width, small.height) * 0.02));
  const closed = closeMask(dark, small.width, small.height, radius);

  const minArea = small.width * small.height * BODY_MIN_AREA_RATIO;
  const parts = findComponents(closed, luma, small.width, small.height, minArea);

  let best = null;
  let bestScore = -1;
  for (const comp of parts) {
    // 本体全体が写っていない（＝画像の端で切れている）ものは使わない
    if (comp.touchesBorder) continue;
    const quad = largestQuad(convexHull(comp.points));
    if (!quad) continue;
    const qArea = quadArea(quad);
    if (qArea <= 0) continue;
    // スマホは角の丸い長方形なので、四角形によく収まるはず
    const rectangularity = Math.min(1, comp.area / qArea);
    if (rectangularity < BODY_MIN_RECTANGULARITY) continue;
    const score = qArea * rectangularity;
    if (score > bestScore) {
      bestScore = score;
      best = quad;
    }
  }
  if (!best) return null;
  return orderCorners(best).map((p) => ({ x: p.x / scale, y: p.y / scale }));
}

/** 明るい領域から、画面らしい四角形をおおまかに求める */
function detectRoughQuad(canvas) {
  const { canvas: small, scale } = downscale(canvas, ANALYSIS_MAX_SIDE);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, small.width, small.height);
  const luma = toLuma(imageData);
  const threshold = otsuThreshold(luma);

  const mask = new Uint8Array(luma.length);
  for (let i = 0; i < luma.length; i++) mask[i] = luma[i] > threshold ? 1 : 0;

  const maxSide = Math.max(small.width, small.height);
  const grad = sobelMagnitude(luma, small.width, small.height);
  const detailReference = percentile(grad, 0.9) * DETAIL_REFERENCE_RATIO;
  const minArea = small.width * small.height * MIN_PART_RATIO;
  const parts = findComponents(mask, luma, small.width, small.height, minArea);
  if (parts.length === 0) return null;

  // 画面全体が写っていれば、画面の領域は画像の端に接しない。
  // 端に接する領域（机や壁）は、そうでない候補があるかぎり使わない。
  const inside = parts.filter((p) => !p.touchesBorder);
  const usable = inside.length > 0 ? inside : parts;

  // 画面は「バナー」「カード」のように明るい部分が分かれて写る。
  // 近いものどうしをまとめ直して、画面全体を1つの候補として扱う。
  const groups = groupNearbyComponents(usable, maxSide * NEIGHBOR_RATIO);

  let best = null;
  let bestScore = -1;
  for (const group of groups) {
    const points = [];
    let area = 0;
    let lumaSum = 0;
    for (const comp of group) {
      for (const p of comp.points) points.push(p);
      area += comp.area;
      lumaSum += comp.meanLuma * comp.area;
    }
    const meanLuma = lumaSum / area;
    const quad = largestQuad(convexHull(points));
    if (!quad) continue;
    const qArea = quadArea(quad);
    if (qArea <= 0) continue;

    // 画面らしさ = 面積 × 四角形へのフィット具合 × 明るさ × 周囲の暗さ × 中身の細かさ
    const rectangularity = Math.min(1, area / qArea);
    const score =
      qArea *
      rectangularity * rectangularity *
      (meanLuma / 255) *
      surroundingDarkness(luma, small.width, small.height, quad, meanLuma) *
      contentDetail(grad, small.width, small.height, quad, detailReference);

    if (score > bestScore) {
      bestScore = score;
      best = quad;
    }
  }
  if (!best) return null;

  return orderCorners(best).map((p) => ({ x: p.x / scale, y: p.y / scale }));
}

/**
 * 写真から画面の四隅（元画像の座標）を検出する。
 * 見つからない場合は null。
 *
 * 画面が小さく写っていると、解析用の縮小画像ではステータスバーのような
 * 細い部分が潰れてしまい、画面の一部しか取れない。その場合は見つけた
 * 範囲の周辺だけを切り出し、実質的に高い解像度でもう一度検出する。
 */
export function detectScreenQuad(canvas) {
  // 明るい背景なら、まずスマホ本体の輪郭で切り出しておく。
  // 背景（机や壁）を最初から除外できるので、画面の検出が安定する。
  const body = detectDeviceBody(canvas);
  let source = canvas;
  let baseX = 0;
  let baseY = 0;
  if (body) {
    const bx = body.map((p) => p.x);
    const by = body.map((p) => p.y);
    const pad = (Math.max(...bx) - Math.min(...bx)) * 0.05;
    const cx0 = Math.max(0, Math.floor(Math.min(...bx) - pad));
    const cy0 = Math.max(0, Math.floor(Math.min(...by) - pad));
    const cx1 = Math.min(canvas.width, Math.ceil(Math.max(...bx) + pad));
    const cy1 = Math.min(canvas.height, Math.ceil(Math.max(...by) + pad));
    if (cx1 - cx0 > 40 && cy1 - cy0 > 40) {
      const cropped = document.createElement('canvas');
      cropped.width = cx1 - cx0;
      cropped.height = cy1 - cy0;
      cropped
        .getContext('2d')
        .drawImage(canvas, cx0, cy0, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
      source = cropped;
      baseX = cx0;
      baseY = cy0;
    }
  }

  const rough = detectRoughQuad(source);
  if (!rough) return null;

  // 画面の周辺だけを切り出す。以降の処理を元の解像度のまま行えるので、
  // 画面が小さく写っている写真でも縁を細かく見られる。
  const xs = rough.map((p) => p.x);
  const ys = rough.map((p) => p.y);
  const margin = (Math.max(...xs) - Math.min(...xs)) * 0.35;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - margin));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - margin));
  const x1 = Math.min(source.width, Math.ceil(Math.max(...xs) + margin));
  const y1 = Math.min(source.height, Math.ceil(Math.max(...ys) + margin));
  const areaRatio = ((x1 - x0) * (y1 - y0)) / (source.width * source.height);

  let target = source;
  let quad = rough;
  let offsetX = 0;
  let offsetY = 0;

  if (areaRatio < ZOOM_AREA_RATIO && x1 - x0 > 20 && y1 - y0 > 20) {
    const zoom = document.createElement('canvas');
    zoom.width = x1 - x0;
    zoom.height = y1 - y0;
    zoom
      .getContext('2d')
      .drawImage(source, x0, y0, zoom.width, zoom.height, 0, 0, zoom.width, zoom.height);
    const zoomed = detectRoughQuad(zoom);
    if (zoomed) {
      target = zoom;
      quad = zoomed;
      offsetX = x0;
      offsetY = y0;
    }
  }

  // 1回目でおおよそ縁に乗せ、2回目で仕上げる（1回だけだと初期位置が
  // 縁から遠い辺で、探索範囲の端の弱いエッジに引かれることがある）
  quad = orderCorners(refineQuadToEdges(target, quad));
  quad = orderCorners(refineQuadToEdges(target, quad));
  return orderCorners(quad.map((p) => ({ x: p.x + offsetX + baseX, y: p.y + offsetY + baseY })));
}

/* ------------------------------------------------------------------ *
 * 5. 射影変換（台形補正）
 * ------------------------------------------------------------------ */

function solveLinearSystem(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      [A[pivot], A[col]] = [A[col], A[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    for (let row = col + 1; row < n; row++) {
      const f = A[row][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[row][c] -= f * A[col][c];
      b[row] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let c = row + 1; c < n; c++) sum -= A[row][c] * x[c];
    x[row] = sum / A[row][row];
  }
  return x;
}

/** dst(出力の矩形) → src(写真上の四角形) への射影変換行列を求める */
function computeHomography(dst, src) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solveLinearSystem(A, b);
  return h ? [...h, 1] : null;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 四隅の大きさから出力サイズを決める */
export function outputSizeFor(quad, maxPixels = 12e6) {
  const [tl, tr, br, bl] = quad;
  let w = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  let h = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  w = Math.max(1, w);
  h = Math.max(1, h);
  const shrink = Math.sqrt(maxPixels / (w * h));
  if (shrink < 1) {
    w = Math.max(1, Math.round(w * shrink));
    h = Math.max(1, Math.round(h * shrink));
  }
  return { width: w, height: h };
}

/** 四隅を切り出して長方形に補正した Canvas を返す（バイリニア補間） */
export function warpPerspective(srcCanvas, quad, size) {
  const { width: outW, height: outH } = size || outputSizeFor(quad);
  const dstCorners = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];
  const h = computeHomography(dstCorners, quad);
  if (!h) throw new Error('切り出し範囲の計算に失敗しました');

  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  const dstData = octx.createImageData(outW, outH);
  const dd = dstData.data;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const w = h[6] * x + h[7] * y + h[8];
      const u = (h[0] * x + h[1] * y + h[2]) / w;
      const v = (h[3] * x + h[4] * y + h[5]) / w;
      const di = (y * outW + x) * 4;

      if (!(u >= 0 && v >= 0 && u <= sw - 1 && v <= sh - 1)) {
        dd[di] = dd[di + 1] = dd[di + 2] = 0;
        dd[di + 3] = 255;
        continue;
      }

      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bottom = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        dd[di + c] = top * (1 - fy) + bottom * fy;
      }
      dd[di + 3] = 255;
    }
  }

  octx.putImageData(dstData, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. 向きの補正
 * ------------------------------------------------------------------ */

export function rotateCanvas(canvas, degrees) {
  const deg = ((degrees % 360) + 360) % 360;
  if (deg === 0) return canvas;
  const swap = deg === 90 || deg === 270;
  const out = document.createElement('canvas');
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/** 上下 15% の明るさを比べる（スマホ画面は上にステータスバー等があり明るいことが多い） */
const SATURATION_DIFF = 0.08; // 彩度で上下を判断できるとみなす差
const LUMA_DIFF = 12; // 明るさで上下を判断できるとみなす差

/**
 * 上下が逆さまかどうかを推定する。
 *
 * 手がかりは端の帯（高さの6%）の色。スマホの画面はいちばん上に
 * ステータスバーやアプリのヘッダーがあり、色が付いていることが多い。
 * 一方、下端は白いカードや黒い余白で、彩度が低い。
 * 彩度で判断がつかないときだけ、明るさ（上の方が暗いことが多い）で判断する。
 */
function needsFlip(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const band = Math.max(1, Math.round(canvas.height * 0.06));
  const stats = (data) => {
    let luma = 0;
    let saturation = 0;
    const count = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      luma += (r * 299 + g * 587 + b * 114) / 1000;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      saturation += max === 0 ? 0 : (max - min) / max;
    }
    return { luma: luma / count, saturation: saturation / count };
  };

  const top = stats(ctx.getImageData(0, 0, canvas.width, band).data);
  const bottom = stats(ctx.getImageData(0, canvas.height - band, canvas.width, band).data);

  if (Math.abs(top.saturation - bottom.saturation) >= SATURATION_DIFF) {
    return bottom.saturation > top.saturation;
  }
  return bottom.luma > top.luma + LUMA_DIFF;
}

/**
 * 縦長になるよう回転し、さらに上下の向きを推定して補正する。
 * 返り値: { canvas, rotation }（rotation は適用した角度）
 */
export function autoOrient(canvas) {
  let rotation = 0;
  let result = canvas;
  if (canvas.width > canvas.height) {
    rotation = 90;
    result = rotateCanvas(canvas, 90);
  }
  if (needsFlip(result)) {
    rotation = (rotation + 180) % 360;
    result = rotateCanvas(result, 180);
  }
  return { canvas: result, rotation };
}

/* ------------------------------------------------------------------ *
 * まとめて実行
 * ------------------------------------------------------------------ */

/**
 * 写真 → 画面部分だけの正立画像。
 * 検出できなかった場合は quad が null（呼び出し側で手動指定させる）。
 */
export function autoCropCanvas(sourceCanvas) {
  const quad = detectScreenQuad(sourceCanvas);
  if (!quad) return { quad: null, canvas: null, rotation: 0 };
  const cropped = warpPerspective(sourceCanvas, quad);
  const { canvas, rotation } = autoOrient(cropped);
  return { quad, canvas, rotation };
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.95) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
