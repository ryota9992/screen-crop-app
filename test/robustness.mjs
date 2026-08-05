import { chromium } from 'playwright-core';
import fs from 'fs';
const lib=fs.readFileSync(process.argv[2]||'lib/autoCrop.js','utf8').replace(/^export /gm,'');
const b=await chromium.launch({executablePath: process.env.CHROME_PATH || undefined});
const p=await b.newPage(); p.on('pageerror',e=>console.log('[err]',e.message));
await p.setContent('<body></body>'); await p.addScriptTag({content:lib});
for(const n of ['IMG_6407','IMG_6681','IMG_6682','IMG_6706']){
  const u='data:image/jpeg;base64,'+fs.readFileSync(`${process.env.TEST_DIR||'./test/data'}/${n}.jpeg`).toString('base64');
  const r=await p.evaluate(async u=>{
    const img=await new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src=u;});
    const base=imageToCanvas(img);
    const out={};
    // 色プロファイルの扱いの違いを模擬する（明るさ・ガンマ・コントラスト）
    for(const [name,f] of Object.entries({
      'そのまま':(v)=>v,
      '明るさ+20%':(v)=>Math.min(255,v*1.2),
      '明るさ-20%':(v)=>v*0.8,
      'ガンマ0.8':(v)=>255*Math.pow(v/255,0.8),
      'ガンマ1.25':(v)=>255*Math.pow(v/255,1.25),
    })){
      const c=document.createElement('canvas'); c.width=base.width; c.height=base.height;
      const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(base,0,0);
      if(name!=='そのまま'){
        const d=x.getImageData(0,0,c.width,c.height);
        for(let i=0;i<d.data.length;i+=4){d.data[i]=f(d.data[i]);d.data[i+1]=f(d.data[i+1]);d.data[i+2]=f(d.data[i+2]);}
        x.putImageData(d,0,0);
      }
      const q=detectScreenQuad(c);
      const o=autoOrient(warpPerspective(c,q));
      out[name]=o.rotation;
    }
    return out;
  }, u);
  console.log(n, JSON.stringify(r));
}
await b.close();
