'use strict';

// Runs in the browser. Average each image region before comparison: directly
// shrinking differently sized encoded images to 16px aliases text and edges.
// Keep the existing comparison thresholds; normalize the sampling instead.
async function sampleCoverPixels({source,aspect=null}) {
  const img=new Image();img.src=source;await img.decode();
  let w=img.naturalWidth,h=img.naturalHeight;
  if(!w || !h)throw new Error('封面图片尚未加载。');
  if(aspect){if(w/h>aspect)w=h*aspect;else h=w/aspect;}
  const scale=Math.min(1,2048/Math.max(w,h)),canvas=document.createElement('canvas');
  canvas.width=Math.max(16,Math.round(w*scale));canvas.height=Math.max(16,Math.round(h*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(img,(img.naturalWidth-w)/2,(img.naturalHeight-h)/2,w,h,0,0,canvas.width,canvas.height);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data,result=[];
  for(let y=0;y<16;y++)for(let x=0;x<16;x++){
    const sum=[0,0,0];let count=0;
    for(let yy=Math.floor(y*canvas.height/16);yy<Math.floor((y+1)*canvas.height/16);yy++){
      for(let xx=Math.floor(x*canvas.width/16);xx<Math.floor((x+1)*canvas.width/16);xx++){
        const at=(yy*canvas.width+xx)*4;
        for(let channel=0;channel<3;channel++)sum[channel]+=pixels[at+channel];
        count++;
      }
    }
    result.push(...sum.map(value=>Math.round(value/count)));
  }
  return result;
}
module.exports={sampleCoverPixels};
