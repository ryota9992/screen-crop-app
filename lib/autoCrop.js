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

function otsuThreshold(luma) {
  const hist = new Float64Array(256);
  for (let i = 0; i < luma.length; i++) hist[luma[i]]++;

  const total = luma.length;
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

/** 1次元の最大値/最小値フィルタ（矩形カーネルの膨張・収縮用） */
function filter1D(src, width, height, radius, horizontal, useMax) {
  const dst = new Uint8Array(src.length);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  for (let o = 0; o < outer; o++) {
    const base = horizontal ? o * width : o;
    for (let i = 0; i < inner; i++) {
      let v = useMax ? 0 : 1;
      const from = Math.max(0, i - radius);
      const to = Math.min(inner - 1, i + radius);
      for (let k = from; k <= to; k++) {
        const s = src[base + k * step];
        if (useMax ? s > v : s < v) v = s;
      }
      dst[base + i * step] = v;
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
const OUTWARD_RATIO = 0.03; // 辺の外側を探す幅（画面サイズ比）
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
  const grad = sobelMagnitude(luma, work.width, work.height);
  const strongEdge = percentile(grad, 0.98) * 0.35;

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

        // 探索範囲でいちばん強いエッジを画面の縁とみなす
        let bestScore = 0;
        let bestD = 0;
        for (let d = -inward; d <= outward; d += 0.5) {
          const s = sampleBilinear(grad, work.width, work.height, px + nx * d, py + ny * d);
          if (s > bestScore) {
            bestScore = s;
            bestD = d;
          }
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

/**
 * 写真から画面の四隅（元画像の座標）を検出する。
 * 見つからない場合は null。
 */
export function detectScreenQuad(canvas) {
  const { canvas: small, scale } = downscale(canvas, ANALYSIS_MAX_SIDE);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, small.width, small.height);
  const luma = toLuma(imageData);
  const threshold = otsuThreshold(luma);

  const mask = new Uint8Array(luma.length);
  for (let i = 0; i < luma.length; i++) mask[i] = luma[i] > threshold ? 1 : 0;
  const radius = Math.max(4, Math.round(Math.max(small.width, small.height) * 0.035));
  const closed = closeMask(mask, small.width, small.height, radius);

  const minArea = small.width * small.height * 0.02;
  const components = findComponents(closed, luma, small.width, small.height, minArea);
  if (components.length === 0) return null;

  let best = null;
  let bestScore = -1;
  for (const comp of components) {
    const hull = convexHull(comp.points);
    const quad = largestQuad(hull);
    if (!quad) continue;
    const qArea = quadArea(quad);
    if (qArea <= 0) continue;

    // 画面らしさ = 面積 × 四角形へのフィット具合 × 明るさ
    // 画像の端に接する成分（背景や机など）は大きく減点する
    const rectangularity = Math.min(1, comp.area / qArea);
    const score =
      qArea *
      rectangularity * rectangularity *
      (comp.meanLuma / 255) *
      (comp.touchesBorder ? 0.25 : 1);

    if (score > bestScore) {
      bestScore = score;
      best = quad;
    }
  }
  if (!best) return null;

  const rough = orderCorners(best).map((p) => ({ x: p.x / scale, y: p.y / scale }));
  return orderCorners(refineQuadToEdges(canvas, rough));
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
function needsFlip(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const band = Math.max(1, Math.round(canvas.height * 0.15));
  const meanLuma = (data) => {
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    }
    return sum / (data.length / 4);
  };
  const top = meanLuma(ctx.getImageData(0, 0, canvas.width, band).data);
  const bottom = meanLuma(ctx.getImageData(0, canvas.height - band, canvas.width, band).data);
  return bottom > top + 12;
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
