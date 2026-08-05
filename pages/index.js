import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import {
  autoOrient,
  canvasToBlob,
  detectScreenQuad,
  imageToCanvas,
  loadImageFromFile,
  orderCorners,
  rotateCanvas,
  warpPerspective,
} from '../lib/autoCrop';

// 画面に表示するバージョン。変更をデプロイするたびに上げること。
// 表示されている版が最新かどうかを、この番号で確認できる。
const APP_VERSION = 'v1.8.0';

const PREVIEW_MAX_SIDE = 420;

/** 写真1枚ぶんのカード。四隅の調整と回転ができる。 */
function CropItem({ item, onRemove }) {
  const { name, sourceCanvas } = item;
  const [quad, setQuad] = useState(item.quad);
  const [rotation, setRotation] = useState(item.rotation);
  const [resultUrl, setResultUrl] = useState(null);
  const [editing, setEditing] = useState(!item.quad);
  const [busy, setBusy] = useState(false);
  const resultCanvasRef = useRef(null);
  const overlayRef = useRef(null);
  const dragIndexRef = useRef(-1);

  const previewScale = Math.min(
    1,
    PREVIEW_MAX_SIDE / Math.max(sourceCanvas.width, sourceCanvas.height)
  );
  const previewW = Math.round(sourceCanvas.width * previewScale);
  const previewH = Math.round(sourceCanvas.height * previewScale);

  // 四隅または回転が変わったら切り出し直す
  useEffect(() => {
    if (!quad) return;
    let cancelled = false;
    setBusy(true);
    // 重い処理なので描画を1フレーム譲る
    const id = setTimeout(async () => {
      try {
        const warped = warpPerspective(sourceCanvas, quad);
        const rotated = rotateCanvas(warped, rotation);
        resultCanvasRef.current = rotated;
        const blob = await canvasToBlob(rotated);
        if (cancelled) return;
        setResultUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [quad, rotation, sourceCanvas]);

  useEffect(() => () => resultUrl && URL.revokeObjectURL(resultUrl), [resultUrl]);

  // 元画像＋四隅のオーバーレイを描画
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    canvas.width = previewW;
    canvas.height = previewH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, previewW, previewH);
    ctx.drawImage(sourceCanvas, 0, 0, previewW, previewH);
    if (!quad) return;

    const pts = quad.map((p) => ({ x: p.x * previewScale, y: p.y * previewScale }));
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(34, 211, 238, 0.15)';
    ctx.fill();
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#0891b2';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }, [quad, previewW, previewH, previewScale, sourceCanvas, editing]);

  const pointerPos = (e) => {
    const rect = overlayRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * sourceCanvas.width,
      y: ((e.clientY - rect.top) / rect.height) * sourceCanvas.height,
    };
  };

  const handlePointerDown = (e) => {
    if (!quad) {
      // 検出できなかった場合は、まず画像全体を初期値にする
      setQuad([
        { x: 0, y: 0 },
        { x: sourceCanvas.width, y: 0 },
        { x: sourceCanvas.width, y: sourceCanvas.height },
        { x: 0, y: sourceCanvas.height },
      ]);
      return;
    }
    const pos = pointerPos(e);
    let nearest = 0;
    let bestDist = Infinity;
    quad.forEach((p, i) => {
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bestDist) {
        bestDist = d;
        nearest = i;
      }
    });
    dragIndexRef.current = nearest;
    e.currentTarget.setPointerCapture(e.pointerId);
    setQuad((prev) => prev.map((p, i) => (i === nearest ? pos : p)));
  };

  const handlePointerMove = (e) => {
    if (dragIndexRef.current < 0) return;
    const pos = pointerPos(e);
    const clamped = {
      x: Math.max(0, Math.min(sourceCanvas.width, pos.x)),
      y: Math.max(0, Math.min(sourceCanvas.height, pos.y)),
    };
    const idx = dragIndexRef.current;
    setQuad((prev) => prev.map((p, i) => (i === idx ? clamped : p)));
  };

  const handlePointerUp = () => {
    dragIndexRef.current = -1;
  };

  const redetect = () => {
    const detected = detectScreenQuad(sourceCanvas);
    if (!detected) {
      alert('画面を自動検出できませんでした。四隅を手動で合わせてください。');
      return;
    }
    const warped = warpPerspective(sourceCanvas, detected);
    setQuad(detected);
    setRotation(autoOrient(warped).rotation);
  };

  const download = () => {
    if (!resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = name.replace(/\.[^.]+$/, '') + '_crop.jpg';
    a.click();
  };

  return (
    <div className="bg-white rounded-xl shadow p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <p className="font-medium text-sm text-gray-700 truncate">{name}</p>
        <button onClick={onRemove} className="text-gray-400 hover:text-red-500 text-sm">
          削除
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500">元の写真</p>
            <button
              onClick={() => setEditing((v) => !v)}
              className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
            >
              {editing ? '調整を閉じる' : '四隅を調整'}
            </button>
          </div>
          <canvas
            ref={overlayRef}
            onPointerDown={editing ? handlePointerDown : undefined}
            onPointerMove={editing ? handlePointerMove : undefined}
            onPointerUp={editing ? handlePointerUp : undefined}
            onPointerCancel={editing ? handlePointerUp : undefined}
            className={`w-full rounded border ${editing ? 'cursor-crosshair touch-none' : ''}`}
            style={{ maxWidth: previewW }}
          />
          {editing && (
            <p className="text-xs text-gray-500 mt-1">
              青い点をドラッグして画面の四隅に合わせてください
            </p>
          )}
        </div>

        <div>
          <p className="text-xs text-gray-500 mb-2">切り出し結果</p>
          {resultUrl ? (
            <img
              src={resultUrl}
              alt="切り出し結果"
              className="w-full rounded border"
              style={{ maxWidth: PREVIEW_MAX_SIDE }}
            />
          ) : (
            <div className="h-40 flex items-center justify-center text-gray-400 text-sm border rounded">
              {busy ? '処理中…' : '四隅を指定してください'}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-4">
        <button
          onClick={() => setRotation((r) => (r + 270) % 360)}
          className="px-3 py-2 text-sm rounded bg-gray-100 hover:bg-gray-200"
        >
          ↺ 左に回転
        </button>
        <button
          onClick={() => setRotation((r) => (r + 90) % 360)}
          className="px-3 py-2 text-sm rounded bg-gray-100 hover:bg-gray-200"
        >
          ↻ 右に回転
        </button>
        <button
          onClick={redetect}
          className="px-3 py-2 text-sm rounded bg-gray-100 hover:bg-gray-200"
        >
          自動検出をやり直す
        </button>
        <button
          onClick={download}
          disabled={!resultUrl || busy}
          className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
        >
          ダウンロード
        </button>
      </div>
    </div>
  );
}

export default function CropPage() {
  const [items, setItems] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState(null);

  const handleFiles = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    setError(null);
    setProcessing(true);
    try {
      const next = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress({ current: i + 1, total: files.length });
        // 重い処理の前に一度描画させて、進捗表示を更新する
        await new Promise((r) => setTimeout(r, 0));
        try {
          const img = await loadImageFromFile(file);
          const sourceCanvas = imageToCanvas(img);
          const quad = detectScreenQuad(sourceCanvas);
          let rotation = 0;
          if (quad) {
            rotation = autoOrient(warpPerspective(sourceCanvas, quad)).rotation;
          }
          next.push({
            id: `${file.name}-${Date.now()}-${Math.random()}`,
            name: file.name,
            sourceCanvas,
            quad: quad ? orderCorners(quad) : null,
            rotation,
          });
        } catch (err) {
          setError(`${file.name}: ${err.message}`);
        }
      }
      setItems((prev) => [...prev, ...next]);
    } finally {
      setProcessing(false);
      setProgress({ current: 0, total: 0 });
    }
  }, []);

  return (
    <>
      <Head>
        <title>画面写真の自動切り出し</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="切り出し" />
      </Head>

      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-gray-800">画面写真の自動切り出し</h1>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-gray-200 text-gray-600">
                {APP_VERSION}
              </span>
            </div>
            <p className="text-gray-600 text-sm mt-1">
              スマホの画面を撮った写真から、画面部分だけを自動で検出して
              台形補正・正立回転した画像を作ります。処理はすべてブラウザ内で行われ、
              画像はどこにも送信されません。
            </p>
          </div>

          <label className="block bg-white border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 mb-6">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleFiles}
              className="hidden"
              disabled={processing}
            />
            <p className="text-gray-700 font-medium">
              {processing
                ? `処理中… (${progress.current}/${progress.total})`
                : '写真を選択（複数可）'}
            </p>
            <p className="text-gray-500 text-xs mt-1">
              タップしてカメラロールから選ぶか、その場で撮影できます
            </p>
          </label>

          {error && (
            <div className="bg-red-50 text-red-700 text-sm rounded-lg p-3 mb-4">{error}</div>
          )}

          {items.map((item) => (
            <CropItem
              key={item.id}
              item={item}
              onRemove={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
            />
          ))}

          {items.length === 0 && !processing && (
            <p className="text-center text-gray-400 text-sm py-8">
              まだ写真がありません
            </p>
          )}
        </div>
      </div>
    </>
  );
}
