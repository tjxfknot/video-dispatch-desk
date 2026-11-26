'use strict';
const {normalizeLocation}=require('./publish-settings.cjs');
const clean=value=>String(value || '').replace(/\s+/g,' ').trim();
const LABEL=/^(?:作品)?(?:定位|地点|位置|所在位置|地理位置)$/;
const EMPTY=/^(?:输入地理位置|添加(?:位置|地点|定位)|选择(?:位置|地点)|不添加(?:位置|地点|定位)|不显示位置|不使用位置|无位置|所在位置|位置|地点|定位)?$/;
const NONE=/^(?:不添加(?:位置|地点|定位)|不显示位置|不使用位置|无位置)$/;

// Native semantic controls only. A unique name and an actual option click are
// required; typing a search query is never treated as a selected place.
function createLocationControl(page,input,{platform,assertRunning=()=>{},waitMs=5000}={}){
  const request=normalizeLocation(input);
  const visible=locator=>locator.filter({visible:true});
  let douyinValue;
  async function field(){
    const matches=visible(page.getByRole('combobox',{name:LABEL})
      .or(page.getByRole('textbox',{name:LABEL}))
      .or(page.locator('input[placeholder="添加位置"], input[placeholder="添加地点"], input[placeholder="所在位置"], input[placeholder="选择地点"], input[placeholder="输入地理位置"]')));
    if(platform==='douyin'){
      // 2026-11-15失败截图：添加标签一行依次为“位置”、
      // “带货模式”和自定义地理位置选择器，空值显示“输入地理位置”。
      // 沿“位置”入口的相邻控件定位整个值容器；占位文字消失后仍可
      // 发现选中的旧地点，不能仅凭占位文字/搜索框为空判定没有定位。
      const labels=visible(page.getByText('位置',{exact:true}));
      if(await labels.count()>1)throw new Error('抖音位置入口不唯一，未提交。');
      if(await labels.count()===1){
        if(douyinValue){if(await douyinValue.count()!==1)throw new Error('抖音地理位置值控件已改变，未提交。');return douyinValue;}
        // 真实页面的控件间有多层包装，不能假设第几个父层就是一行。
        // 由唯一“位置”入口和唯一地理位置占位共同确定最小容器，
        // 再锁定占位所在的整个值分支。路径由实际DOM计算，后续读取
        // 不依赖占位仍存在，也不把空搜索框冒充空的已选地点。
        let empty=visible(page.getByText('输入地理位置',{exact:true}));
        if(!await empty.count())empty=visible(page.locator('input[placeholder="输入地理位置"]'));
        if(await empty.count()>1)throw new Error('抖音地理位置占位不唯一，未提交。');
        if(await empty.count()===1){
          const target=await empty.elementHandle();let descriptor;
          try{descriptor=await labels.evaluate((label,target)=>{
            const cleanText=el=>String(el.innerText || '').replace(/\s+/g,' ').trim();
            const isIgnored=el=>!el.getClientRects().length || el.matches('svg,i,[role="img"],[aria-hidden="true"]') || !cleanText(el) || /^[⌄⌃∨∧▼▽▾×]+$/.test(cleanText(el)) || /^(?:带货模式|添加标签)$/.test(cleanText(el));
            const hasModeNoiseOutside=(container,node)=>[...container.querySelectorAll('*')].some(el=>!el.contains(node) && !node.contains(el) && el.getClientRects().length && !el.matches('svg,i,[role="img"],[aria-hidden="true"]') && /^(?:带货模式|添加标签)$/.test(cleanText(el)));
            let root=label,up=0;
            while(root && !root.contains(target)){root=root.parentElement;up++;}
            if(!root || root.matches('body,html') || root===target || (root.innerText || '').length>400 || /作品描述|设置封面|自主声明|关联热点/.test(root.innerText || ''))return null;
            let branch=target;while(branch.parentElement!==root){branch=branch.parentElement;if(!branch)return null;}
            let labelBranch=label;while(labelBranch.parentElement!==root){labelBranch=labelBranch.parentElement;if(!labelBranch)return null;}
            const extra=[...root.children].filter(el=>el!==branch && el!==labelBranch && !isIgnored(el));
            if(extra.length)return {ambiguous:true};
            const path=[[...root.children].indexOf(branch)];
            // 2026-11-21 抖音开通“带货模式”的账号在 .anchor-component-* 内把“带货模式”
            // 与地理位置下拉包进同一个子容器；向 target 收缩至不含“带货模式”的最小分支，
            // 避免把“带货模式 输入地理位置”误判为已填定位。
            let cur=branch;
            while(cur && cur!==target && hasModeNoiseOutside(cur,target)){
              const children=[...cur.children];
              const next=children.find(ch=>ch.contains(target));
              if(!next)break;
              const levelExtra=children.filter(el=>el!==next && !isIgnored(el));
              if(levelExtra.length)return {ambiguous:true};
              path.push(children.indexOf(next));
              cur=next;
            }
            return {up,path};
          },target);}finally{await target?.dispose();}
          if(descriptor?.ambiguous)throw new Error('抖音地理位置值控件不唯一，未提交。');
          if(descriptor && descriptor.path?.length && descriptor.path.every(i=>i>=0)){
            let node=labels;for(let i=0;i<descriptor.up;i++)node=node.locator('..');
            for(const idx of descriptor.path)node=node.locator(':scope > *').nth(idx);
            douyinValue=visible(node);
            if(await douyinValue.count()!==1)throw new Error('抖音地理位置值容器无法唯一核对，未提交。');
            return douyinValue;
          }
        }
        let anchor=labels;
        for(let depth=0;depth<3;depth++,anchor=anchor.locator('..')){
          const siblings=visible(anchor.locator('xpath=following-sibling::*')),candidates=[];
          for(let i=0;i<await siblings.count();i++){
            const item=siblings.nth(i),text=clean(await item.innerText());
            if(await item.evaluate(el=>el.matches('svg,i,[role="img"],[aria-hidden="true"]')) || /^[⌄⌃∨∧▼▽▾×]+$/.test(text))continue;
            if(/^带货模式$/.test(text))continue;
            if(text || await item.locator('input,[role="combobox"]').count())candidates.push(item);
          }
          if(candidates.length>1)throw new Error('抖音地理位置值控件不唯一，未提交。');
          if(candidates.length===1){
            const unwrapped=await candidates[0].evaluate(container=>{
              const cleanText=el=>String(el.innerText || '').replace(/\s+/g,' ').trim();
              const hasMode=el=>[...el.querySelectorAll('*')].some(n=>n.getClientRects().length && !n.matches('svg,i,[role="img"],[aria-hidden="true"]') && /^(?:带货模式|添加标签)$/.test(cleanText(n)));
              let cur=container;const path=[];
              while(hasMode(cur)){
                const meaningful=[];
                for(let i=0;i<cur.children.length;i++){
                  const child=cur.children[i];
                  if(!child.getClientRects().length || child.matches('svg,i,[role="img"],[aria-hidden="true"]'))continue;
                  const text=cleanText(child);
                  if(/^[⌄⌃∨∧▼▽▾×]+$/.test(text) || /^(?:带货模式|添加标签)$/.test(text))continue;
                  if(text || child.matches('input,[role="combobox"]') || child.querySelector('input,[role="combobox"]'))meaningful.push({child,index:i});
                }
                if(meaningful.length>1)return {ambiguous:true};
                if(meaningful.length!==1)break;
                path.push(meaningful[0].index);cur=meaningful[0].child;
              }
              return {path};
            });
            if(unwrapped?.ambiguous)throw new Error('抖音地理位置值控件不唯一，未提交。');
            let narrowed=candidates[0];
            for(const idx of unwrapped?.path || [])narrowed=narrowed.locator(':scope > *').nth(idx);
            return visible(narrowed);
          }
        }
        throw new Error('抖音显示了位置入口，但当前地理位置状态无法核对，未提交。');
      }
    }
    const count=await matches.count();
    if(count>1)throw new Error('平台定位控件不唯一，未提交；请核对官方页面。');
    if(count===1)return matches;
    if(platform==='xiaohongshu'){
      const empty=visible(page.locator('.d-select-main').filter({has:page.locator('.d-select-placeholder').filter({hasText:/^添加地点$/})}));
      const n=await empty.count();
      if(n!==1)throw new Error('小红书当前作品定位状态无法唯一核对，未提交；不会沿用旧地点。');
      if(request.mode==='place')throw new Error('小红书指定地点的选择尚未实测，不能忽略本条添加地点要求。');
      return empty;
    }
    if(platform==='tencent'){
      // 2026-11-22 真实视频号发布页 DOM：位置区固定由 .post-position-wrap 包裹，
      // 展示层 .position-display 初始可能是“暂无可用位置 / 重新定位”，随后异步按 IP 预填城市（如 Ottawa），
      // 点击 .position-display-wrap 展开 .location-filter-wrap 后选择“不显示位置”才能清除。
      const wrap=visible(page.locator('.post-position-wrap'));
      const wrapCount=await wrap.count();
      if(wrapCount>1)throw new Error('视频号位置控件不唯一，未提交。');
      if(wrapCount===1)return wrap;
      // 兼容既有模拟页与简化结构：按“位置”标签旁唯一的值容器定位，不能把整张表单当成定位控件。
      const label=visible(page.getByText(LABEL));
      const labels=await label.count();
      if(labels>1)throw new Error('视频号位置标签不唯一，未提交。');
      if(labels===1){
        let anchor=label;
        for(let depth=0;depth<3;depth++,anchor=anchor.locator('..')){
          const siblings=visible(anchor.locator('xpath=following-sibling::*'));
          const candidates=[];
          for(let i=0;i<await siblings.count();i++){
            const item=siblings.nth(i);
            if(await item.getByText(/^(?:视频描述|短标题|添加到合集|链接|活动|定时发表|视频标注)$/).count())break;
            if(await item.evaluate(el=>!!String(el.innerText || '').trim() || el.matches('input,select,button,[role="combobox"]') || !!el.querySelector('input,select,button,[role="combobox"]')))candidates.push(item);
          }
          if(candidates.length>1)throw new Error('视频号位置值控件不唯一，未提交。');
          if(candidates.length===1)return candidates[0];
        }
        throw new Error('视频号显示了位置入口，但无法核对或清除默认地点，未提交。');
      }
    }
    const marker=visible(page.getByText(/^(?:作品定位|添加位置|添加地点|所在位置|地理位置|位置|地点|定位)$/));
    if(await marker.count())throw new Error('平台有定位入口，但当前控件无法可靠核对，未提交。');
    return null;
  }
  async function valueOf(control){
    return clean(await control.evaluate((el,platform)=>{
      const explicit=el.getAttribute('aria-valuetext');if(explicit!==null)return explicit;
      if(el.matches('input,select,textarea'))return el.value;
      if(!['tencent','douyin'].includes(platform))return el.innerText;
      if(platform==='tencent'){
        const display=el.matches('.position-display')?el:el.querySelector('.position-display');
        if(display){
          const locName=display.querySelector('.location-name');
          if(locName && locName.getClientRects().length)return locName.textContent || '';
          const parts=[],w=document.createTreeWalker(display,NodeFilter.SHOW_TEXT);let n;
          while(n=w.nextNode())if(n.parentElement?.getClientRects().length && !n.parentElement.closest('svg,i,button,a.refresh-coords,[aria-hidden="true"]'))parts.push(n.textContent);
          return parts.join(' ');
        }
      }
      // A select can retain a chosen place while rendering an empty search
      // input. Inspect the whole selected-value container, not that query.
      const values=[],walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
      while(node=walker.nextNode())if(node.parentElement?.getClientRects().length && !node.parentElement.closest('svg,i,button,[aria-hidden="true"]'))values.push(node.textContent);
      const text=values.join(' '),inputs=[...el.querySelectorAll('input,select,textarea')].filter(n=>n.getClientRects().length && n.value?.trim() && !text.includes(n.value.trim())).map(n=>n.value);
      return [text,...inputs].join(' ');
    },platform));
  }
  async function isTencentNoCoords(control){
    if(platform!=='tencent')return false;
    const raw=await valueOf(control);
    if(raw!=='暂无可用位置')return false;
    return await control.locator('.position-display .location-name').count()===0;
  }
  async function read(){
    assertRunning();const control=await field();
    if(!control){
      if(request.mode==='place')throw new Error('当前平台尚未提供可核对的指定定位入口，不能忽略添加地点要求。');
      return {mode:'none',value:'',evidence:'no_visible_location_control'};
    }
    if(request.mode==='none' && await isTencentNoCoords(control)){
      return {mode:'none',value:'',evidence:'tencent_no_available_location'};
    }
    const raw=await valueOf(control),value=EMPTY.test(raw)?'':raw;
    if(request.mode==='none' && value)throw new Error('平台仍带有作品定位，未提交；请清除地点后重新核对。');
    if(request.mode==='place' && value!==request.name)throw new Error('平台所选地点与本条指定定位不一致，未提交。');
    return {mode:request.mode,value,evidence:'native_location_control'};
  }
  async function waitRead(){
    const deadline=Date.now()+waitMs;let error;
    do{assertRunning();try{return await read();}catch(e){error=e;}await page.waitForTimeout(100);}while(Date.now()<deadline);
    throw error;
  }
  async function apply(){
    assertRunning();
    if(request.mode==='place' && !request.name)throw new Error('添加定位需要填写准确地点名称。');
    const control=await field();
    if(!control)return read();
    if(request.mode==='none' && await isTencentNoCoords(control)){
      // 视频号打开后常短暂显示“暂无可用位置”，随后异步按 IP 自动填上城市（如 Ottawa）。
      // 短暂观察是否异步填出城市；若填出则立刻清除，若仍无可用位置则绝不点“重新定位”。
      const settleUntil=Date.now()+Math.min(waitMs,2500);
      while(Date.now()<settleUntil && await isTencentNoCoords(control)){
        assertRunning();
        await page.waitForTimeout(250);
      }
      if(await isTencentNoCoords(control))return read();
    }
    const raw=await valueOf(control);
    if(request.mode==='none' && EMPTY.test(raw))return read();
    if(request.mode==='none'){
      const clear=visible(control.locator('..').getByRole('button',{name:/^(?:清除位置|清除地点|移除地点|删除位置|清空定位)$/}));
      if(await clear.count()===1){assertRunning();await clear.click();return waitRead();}
      assertRunning();
      const txTrigger=platform==='tencent'?visible(control.locator('.position-display-wrap')):null;
      const txFilter=platform==='tencent'?visible(control.locator('.location-filter-wrap')):null;
      if(txTrigger && await txTrigger.count()===1){
        if(!await txFilter.count())await txTrigger.click();
      }else{
        await control.click();
      }
      let none=platform==='tencent' && await control.locator('.location-filter-wrap').count()
        ? visible(control.locator('.location-filter-wrap').getByText(NONE))
        : visible(page.getByRole('option',{name:NONE}));
      if(!await none.count())none=visible(page.getByRole('option',{name:NONE}));
      if(['tencent','douyin'].includes(platform) && !await none.count())none=visible(page.getByText(NONE));
      await none.first().waitFor({state:'visible',timeout:waitMs}).catch(()=>{});
      if(platform==='tencent' && await control.locator('.location-filter-wrap').count()){
        const scoped=visible(control.locator('.location-filter-wrap').getByText(NONE));
        if(await scoped.count()===1)none=scoped;
      }
      if(await none.count()!==1)throw new Error('平台已带定位，但没有可核对的清除选项，未提交；不会沿用平台旧地点。');
      assertRunning();await none.click();return waitRead();
    }
    assertRunning();
    const txTriggerPlace=platform==='tencent'?visible(control.locator('.position-display-wrap')):null;
    if(txTriggerPlace && await txTriggerPlace.count()===1)await txTriggerPlace.click();
    else await control.click();
    const search=visible(page.getByRole('textbox',{name:/^(?:搜索地点|搜索位置|地点搜索)$/})
      .or(page.locator('input[placeholder*="搜索地点"], input[placeholder*="搜索位置"], input[placeholder*="搜索附近位置"], input[placeholder="输入地理位置"]')));
    if(await search.count()===1){assertRunning();await search.fill(request.name);}
    else if(await control.evaluate(el=>el.matches('input') && !el.readOnly && !el.disabled)){assertRunning();await control.fill(request.name);}
    const candidate=visible(page.getByRole('option',{name:request.name,exact:true}));
    await candidate.first().waitFor({state:'visible',timeout:waitMs}).catch(()=>{});
    if(await candidate.count()!==1)throw new Error('指定地点未匹配唯一的平台候选，未提交；请填写更准确的地点，程序不会选第一个结果。');
    assertRunning();await candidate.click();
    try{await candidate.waitFor({state:'hidden',timeout:waitMs});}
    catch{throw new Error('地点候选尚未完成选择，不能把搜索文字当作已添加定位；未提交。');}
    return waitRead();
  }
  return {apply,read};
}
module.exports={createLocationControl};
