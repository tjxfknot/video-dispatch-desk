'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {routeManagedRequest}=require('../app/core/browser-driver.cjs');
test('无页面框架的导航安全终止，平台范围和普通资源请求仍受原规则控制',async()=>{
 const cases=[
  {navigation:true,frame:()=>{throw new Error('frame not created');},url:'https://creator.douyin.com/creator-micro/home',expected:'abort'},
  {navigation:true,frame:()=>({parentFrame:()=>null}),url:'https://unrelated.example/',expected:'abort'},
  {navigation:true,frame:()=>({parentFrame:()=>null}),url:'https://creator.douyin.com/creator-micro/home',expected:'continue'},
  {navigation:false,frame:()=>{throw new Error('resource must not ask frame');},url:'https://media.example/cover.jpg',expected:'continue'}
 ];
 for(const c of cases){const actions=[];await routeManagedRequest({request:()=>({isNavigationRequest:()=>c.navigation,frame:c.frame,url:()=>c.url}),abort:async()=>{actions.push('abort');},continue:async()=>{actions.push('continue');}},'douyin');assert.deepEqual(actions,[c.expected]);}
});
