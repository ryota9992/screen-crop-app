import { chromium } from 'playwright-core';
import fs from 'fs';
const S=process.env.TEST_DIR || './test/data'; // 写真・出力先
const libPath=process.argv[2]||'/home/user/screen-crop-app/lib/autoCrop.js';
const tag=process.argv[3]||'cur';
const lib=fs.readFileSync(libPath,'utf8').replace(/^export /gm,'');
const all={
  '6407(暗い机)':`${S}/IMG_6407.jpeg`,
  '6681(木の机)':`${S}/IMG_6681.jpeg`,
  '6682(斜めに置いた)':`${S}/IMG_6682.jpeg`,
  '6706(ホーム画面・白机)':`${S}/IMG_6706.jpeg`,
  '7003(水色ケース・暗い机)':`${S}/IMG_7003.jpeg`,
  '7448(黒ケース・明るい机・斜め)':`${S}/IMG_7448.jpeg`,
};
// 手元に無い写真は飛ばす。ただし何を見ていないかは必ず表に出す。
const photos=Object.fromEntries(Object.entries(all).filter(([,f])=>fs.existsSync(f)));
const missing=Object.keys(all).filter(k=>!photos[k]);
if(missing.length) console.log(`[未実行] ${missing.join(', ')} が ${S} に無い\n`);
const b=await chromium.launch({executablePath: process.env.CHROME_PATH || undefined});
const p=await b.newPage(); p.on('pageerror',e=>console.log('[err]',e.message));
await p.setContent('<body></body>'); await p.addScriptTag({content:lib});
for(const [name,path] of Object.entries(photos)){
  const u='data:image/jpeg;base64,'+fs.readFileSync(path).toString('base64');
  const r=await p.evaluate(async u=>{
    const img=await new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src=u;});
    const canvas=imageToCanvas(img);
    const t0=performance.now();
    const quad=detectScreenQuad(canvas);
    const ms=Math.round(performance.now()-t0);
    if(!quad) return {ok:false};
    const o=autoOrient(warpPerspective(canvas,quad));
    const ov=document.createElement('canvas'); ov.width=canvas.width; ov.height=canvas.height;
    const oc=ov.getContext('2d'); oc.drawImage(canvas,0,0);
    oc.strokeStyle='#00e5ff'; oc.lineWidth=Math.max(4,canvas.width/300);
    oc.beginPath(); quad.forEach((q,i)=>i?oc.lineTo(q.x,q.y):oc.moveTo(q.x,q.y)); oc.closePath(); oc.stroke();
    quad.forEach((q,i)=>{oc.fillStyle=['#ff0000','#00ff00','#0088ff','#ffff00'][i];
      oc.beginPath(); oc.arc(q.x,q.y,canvas.width/120,0,7); oc.fill();});
    // ヘッダー帯の下端の傾きを測る。列ごとに「上から下へ暗くなる」段差が
    // 最も強い位置を取り、中央値から離れた点（文字などを拾ったもの）は捨てる。
    const cv=o.canvas, cc=cv.getContext('2d',{willReadFrequently:true});
    const dd=cc.getImageData(0,0,cv.width,cv.height).data;
    const lum=(x,y)=>{const i=(y*cv.width+x)*4; return (dd[i]*299+dd[i+1]*587+dd[i+2]*114)/1000;};
    const raw=[];
    for(let x=Math.round(cv.width*0.1);x<cv.width*0.9;x+=2){
      let best=0,by=null;
      for(let y=Math.round(cv.height*0.03);y<cv.height*0.25;y++){
        const step=lum(x,y-2)-lum(x,y+2);
        if(step>best){best=step;by=y;}
      }
      if(by!==null&&best>30) raw.push({x,y:by});
    }
    const measure=(y0,y1)=>{
      const rows=[];
      for(let x=Math.round(cv.width*0.1);x<cv.width*0.9;x+=2){
        let best=0,by=null;
        for(let y=Math.round(cv.height*y0);y<cv.height*y1;y++){
          const step=Math.abs(lum(x,y-2)-lum(x,y+2));
          if(step>best){best=step;by=y;}
        }
        if(by!==null&&best>30) rows.push({x,y:by});
      }
      if(rows.length<20) return null;
      const med=rows.map(q=>q.y).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
      const pts=rows.filter(q=>Math.abs(q.y-med)<=8);
      if(pts.length<20) return null;
      const n=pts.length;let sx=0,sy=0,sxx=0,sxy=0;
      for(const q of pts){sx+=q.x;sy+=q.y;sxx+=q.x*q.x;sxy+=q.x*q.y;}
      return +(Math.atan((n*sxy-sx*sy)/(n*sxx-sx*sx))*180/Math.PI).toFixed(3);
    };
    const tiltBottom=measure(0.70,0.95);
    // 縦線の傾き（カードの左端が垂直か）。行ごとに左側で最も強い横方向の段差を探す。
    const measureVertical=()=>{
      const rows=[];
      for(let y=Math.round(cv.height*0.15);y<cv.height*0.9;y+=2){
        let best=0,bx=null;
        for(let x=Math.round(cv.width*0.02);x<cv.width*0.3;x++){
          const step=Math.abs(lum(x-2,y)-lum(x+2,y));
          if(step>best){best=step;bx=x;}
        }
        if(bx!==null&&best>30) rows.push({x:bx,y});
      }
      if(rows.length<30) return null;
      const med=rows.map(q=>q.x).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
      const pts=rows.filter(q=>Math.abs(q.x-med)<=10);
      if(pts.length<30) return null;
      const n=pts.length;let sx=0,sy=0,syy=0,sxy=0;
      for(const q of pts){sx+=q.x;sy+=q.y;syy+=q.y*q.y;sxy+=q.x*q.y;}
      return +(Math.atan((n*sxy-sx*sy)/(n*syy-sy*sy))*180/Math.PI).toFixed(3);
    };
    const tiltVert=measureVertical();
    // 左右にベゼル（本体の黒い枠）が写り込んでいないか。
    // ステータスバーの高さでは、画面の内容が幅いっぱいにあるはず。
    const y0=Math.round(cv.height*0.03), y1=Math.round(cv.height*0.06);
    const colBright=(x)=>{let s2=0,n=0;for(let y=y0;y<y1;y++){s2+=lum(x,y);n++;}return s2/n;};
    let bezelLeft=0, bezelRight=0;
    for(let x=0;x<cv.width*0.2;x++){ if(colBright(x)<70) bezelLeft=x+1; else break; }
    for(let x=cv.width-1;x>cv.width*0.8;x--){ if(colBright(x)<70) bezelRight=cv.width-x; else break; }
    let tilt=null, used=0;
    if(raw.length>20){
      const med=raw.map(q=>q.y).sort((a,b)=>a-b)[Math.floor(raw.length/2)];
      const pts=raw.filter(q=>Math.abs(q.y-med)<=8);
      used=pts.length;
      if(pts.length>20){const n=pts.length;let sx=0,sy=0,sxx=0,sxy=0;
        for(const q of pts){sx+=q.x;sy+=q.y;sxx+=q.x*q.x;sxy+=q.x*q.y;}
        tilt=+(Math.atan((n*sxy-sx*sy)/(n*sxx-sx*sx))*180/Math.PI).toFixed(3);}
    }
    return {ok:true, ms, ヘッダー下端の傾き:tilt, 下側の傾き:tiltBottom, 縦線の傾き:tiltVert, ベゼル左:+(bezelLeft/cv.width*100).toFixed(1), ベゼル右:+(bezelRight/cv.width*100).toFixed(1), 測定点:used, 四隅:quad.map(q=>[Math.round(q.x),Math.round(q.y)]),
      出力:[o.canvas.width,o.canvas.height], 縦横比:+(o.canvas.height/o.canvas.width).toFixed(3), 回転:o.rotation,
      overlay:ov.toDataURL('image/jpeg',0.85), result:o.canvas.toDataURL('image/jpeg',0.88)};
  }, u);
  if(!r.ok){ console.log(name,'検出できず'); continue; }
  console.log(name, JSON.stringify({縦横比:r.縦横比, 上の傾き:r.ヘッダー下端の傾き, 下の傾き:r.下側の傾き, 縦線:r.縦線の傾き, ベゼル左右:[r.ベゼル左,r.ベゼル右], 回転:r.回転, ms:r.ms}));
  const f=name.slice(0,4);
  fs.writeFileSync(`${S}/${tag}_${f}_overlay.jpg`,Buffer.from(r.overlay.split(',')[1],'base64'));
  fs.writeFileSync(`${S}/${tag}_${f}_result.jpg`,Buffer.from(r.result.split(',')[1],'base64'));
}
await b.close();
