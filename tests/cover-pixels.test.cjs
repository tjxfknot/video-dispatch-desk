'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {browserAvailability}=require('../app/core/browser-driver.cjs');
const {sampleCoverPixels}=require('../app/core/cover-pixels.cjs');
const {coverPixelsMatch}=require('../app/core/douyin-publish-driver.cjs');
const available=browserAvailability().find(b=>b.available);

test('封面不同尺寸和压缩预览按区域比较，同图不过度误报，错图仍拒绝',{skip:!available},async t=>{
 const browser=await chromium.launch({channel:available.id,headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.abort());const page=await context.newPage();
 const sources=await page.evaluate(()=>{
  const c=document.createElement('canvas');c.width=1080;c.height=1440;const ctx=c.getContext('2d'),data=ctx.createImageData(c.width,c.height);let seed=1234;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
   seed=(Math.imul(seed,1664525)+1013904223)|0;const noise=((seed>>>24)/255-0.5)*120,at=(y*c.width+x)*4;
   data.data[at]=50+x/c.width*130+noise;data.data[at+1]=60+y/c.height*120+noise;data.data[at+2]=(x<c.width/2?80:170)+noise;data.data[at+3]=255;
  }
  ctx.putImageData(data,0,0);const small=document.createElement('canvas');small.width=240;small.height=320;small.getContext('2d').drawImage(c,0,0,small.width,small.height);
  const wrong=document.createElement('canvas');wrong.width=240;wrong.height=320;const w=wrong.getContext('2d');w.fillStyle='#ff00ff';w.fillRect(0,0,240,320);
  return {original:c.toDataURL(),preview:small.toDataURL('image/jpeg',0.85),wrong:wrong.toDataURL()};
 });
 const pixels={};for(const [key,source] of Object.entries(sources))pixels[key]=await page.evaluate(sampleCoverPixels,{source});
 assert.equal(coverPixelsMatch(pixels.original,pixels.preview),true);
 assert.equal(coverPixelsMatch(pixels.original,pixels.wrong),false);
 const old=[];for(const source of [sources.original,sources.preview])old.push(await page.evaluate(async source=>{const i=new Image();i.src=source;await i.decode();const c=document.createElement('canvas');c.width=c.height=16;const ctx=c.getContext('2d');ctx.drawImage(i,0,0,16,16);return [...ctx.getImageData(0,0,16,16).data].filter((_,i)=>i%4!==3);},source));
 assert.equal(coverPixelsMatch(...old),false,'合成细节图应能复现旧版直接缩小的误报');
});
