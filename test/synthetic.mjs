import { chromium } from 'playwright-core';
import fs from 'fs';
const S = process.env.TEST_DIR || './test/data'; // 画面画像・出力先
const libPath = process.argv[2] || '/home/user/screen-crop-app/lib/autoCrop.js';
const lib = fs.readFileSync(libPath, 'utf8').replace(/^export /gm, '');
const screenImg = 'data:image/jpeg;base64,' + fs.readFileSync(`${S}/final.jpg`).toString('base64');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[err]', e.message));
await p.setContent('<body></body>');
await p.addScriptTag({ content: lib });
const out = await p.evaluate(async ({ u, cases }) => {
  const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const src = document.createElement('canvas'); src.width = img.naturalWidth; src.height = img.naturalHeight;
  src.getContext('2d').drawImage(img, 0, 0);
  const sdata = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
  const drawQuad = (dst, quad) => {
    const rect = [{x:0,y:0},{x:src.width-1,y:0},{x:src.width-1,y:src.height-1},{x:0,y:src.height-1}];
    const h = computeHomography(quad, rect);
    const xs = quad.map(q=>q.x), ys = quad.map(q=>q.y);
    const x0=Math.max(0,Math.floor(Math.min(...xs))), x1=Math.min(dst.width-1,Math.ceil(Math.max(...xs)));
    const y0=Math.max(0,Math.floor(Math.min(...ys))), y1=Math.min(dst.height-1,Math.ceil(Math.max(...ys)));
    const dctx = dst.getContext('2d', { willReadFrequently: true });
    const dd = dctx.getImageData(x0, y0, x1-x0+1, y1-y0+1); const W = x1-x0+1;
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
      const w=h[6]*x+h[7]*y+h[8];
      const u2=(h[0]*x+h[1]*y+h[2])/w, v2=(h[3]*x+h[4]*y+h[5])/w;
      if(!(u2>=0&&v2>=0&&u2<=src.width-1&&v2<=src.height-1)) continue;
      const si=(Math.round(v2)*src.width+Math.round(u2))*4, di=((y-y0)*W+(x-x0))*4;
      dd.data[di]=sdata.data[si]; dd.data[di+1]=sdata.data[si+1]; dd.data[di+2]=sdata.data[si+2]; dd.data[di+3]=255;
    }
    dctx.putImageData(dd, x0, y0);
  };
  const results = [];
  for (const c of cases) {
    const W=2400, H=3200;
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
    const x=cv.getContext('2d');
    x.fillStyle=c.dark?'#2a1f16':'#a97c50'; x.fillRect(0,0,W,H);
    for(let i=0;i<W;i+=7){ x.fillStyle=`rgba(0,0,0,${0.04+0.03*Math.sin(i*0.3)})`; x.fillRect(i,0,4,H); }
    const cx=W/2, cy=H/2, sw=c.scale*W/2, sh=sw*(src.height/src.width);
    const rad=c.rot*Math.PI/180;
    const base=[{x:-sw/2,y:-sh/2},{x:sw/2,y:-sh/2},{x:sw/2,y:sh/2},{x:-sw/2,y:sh/2}];
    const truth=base.map((q,i)=>{
      const k=(i===0||i===1)?1-c.persp:1+c.persp;
      const qx=q.x*k, qy=q.y;
      return {x:cx+qx*Math.cos(rad)-qy*Math.sin(rad), y:cy+qx*Math.sin(rad)+qy*Math.cos(rad)};
    });
    const bez=truth.map(q=>({x:cx+(q.x-cx)*1.10, y:cy+(q.y-cy)*1.16}));
    x.fillStyle='#0d0d0f'; x.beginPath();
    bez.forEach((q,i)=>i?x.lineTo(q.x,q.y):x.moveTo(q.x,q.y)); x.closePath(); x.fill();
    drawQuad(cv, truth);
    if (c.paper) { x.fillStyle='#f2efe6';
      x.fillRect(W*0.02,H*0.05,W*0.20,H*0.35);
      x.fillRect(W*0.80,H*0.62,W*0.18,H*0.30); }
    if (c.sticker) { // 本体の下部にシールのような明るい模様を置く
      const s0=truth[3], s1=truth[2];
      x.fillStyle='#8d2b1f'; x.beginPath();
      x.ellipse((s0.x+s1.x)/2+sw*0.25,(s0.y+s1.y)/2+sh*0.10, sw*0.16, sh*0.05, rad, 0, 7); x.fill(); }
    const t0=performance.now();
    const quad=detectScreenQuad(cv);
    const ms=Math.round(performance.now()-t0);
    if(!quad){ results.push({name:c.name, 検出:'失敗'}); continue; }
    const ang=q=>Math.atan2(q[1].y-q[0].y,q[1].x-q[0].x)*180/Math.PI;
    const err=quad.map((q,i)=>Math.hypot(q.x-truth[i].x,q.y-truth[i].y));
    results.push({name:c.name, 角度誤差:+(ang(quad)-ang(truth)).toFixed(2),
      平均ずれpx:Math.round(err.reduce((a,b)=>a+b,0)/4), ms});
  }
  return results;
}, { u: screenImg, cases: [
  {name:'正面・大', scale:0.75, rot:0, persp:0},
  {name:'正面・小', scale:0.35, rot:0, persp:0},
  {name:'回転3度', scale:0.5, rot:3, persp:0},
  {name:'回転-5度', scale:0.5, rot:-5, persp:0},
  {name:'遠近8%', scale:0.5, rot:0, persp:0.08},
  {name:'回転3度+遠近8%', scale:0.5, rot:3, persp:0.08},
  {name:'小さく回転2度+遠近5%', scale:0.32, rot:2, persp:0.05},
  {name:'暗い背景・回転3度', scale:0.5, rot:3, persp:0.04, dark:true},
  {name:'暗い背景・小さい', scale:0.33, rot:-2, persp:0.06, dark:true},
  {name:'隣に白い紙', scale:0.42, rot:2, persp:0.05, paper:true},
  {name:'隣に白い紙・小さい', scale:0.3, rot:-3, persp:0.04, paper:true},
  {name:'隣に白い紙・暗い背景', scale:0.42, rot:2, persp:0.05, paper:true, dark:true},
  {name:'本体にシール', scale:0.5, rot:2, persp:0.04, sticker:true},
  {name:'本体にシール・暗い背景', scale:0.5, rot:-2, persp:0.05, sticker:true, dark:true},
]});
for (const r of out) console.log(JSON.stringify(r));
const ang=out.map(r=>Math.abs(r.角度誤差??99)), px=out.map(r=>r.平均ずれpx??999);
console.log(`角度 平均${(ang.reduce((a,b)=>a+b,0)/ang.length).toFixed(2)} 最大${Math.max(...ang).toFixed(2)} / ずれ 平均${Math.round(px.reduce((a,b)=>a+b,0)/px.length)} 最大${Math.max(...px)}`);
await b.close();
