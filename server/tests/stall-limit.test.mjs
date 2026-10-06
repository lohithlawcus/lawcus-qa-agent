import test from 'node:test';
import assert from 'node:assert/strict';
import {withStallLimit} from '../core/impacted-testing.mjs';
import {registerLiveContext,unregisterLiveContext,takeEvidence,captureStalledPage} from '../core/evidence.mjs';

const SHOT=Buffer.from('synthetic-png');
function fakeContext(url){
 const page={screenshot:async()=>SHOT,locator:()=>({}),url:()=>url};
 return {pages:()=>[page]};
}

test('a check that finishes in time returns its outcome unchanged',async()=>{
 const outcome=await withStallLimit(Promise.resolve({passed:true,actual:'ok'}),1000);
 assert.deepEqual(outcome,{passed:true,actual:'ok'});
});

test('a check that stops responding is stopped, photographed, and reports the stop',async()=>{
 const context=fakeContext('https://lohith.fiveriverz.com/contacts?token=abc');
 registerLiveContext(context);
 try{
  await assert.rejects(withStallLimit(new Promise(()=>{}),20),(error)=>{
   assert.match(error.message,/stopped responding/);
   assert.deepEqual(takeEvidence(error),{screenshot:SHOT});
   return true;
  });
 }finally{
  unregisterLiveContext(context);
 }
});

test('with no open browser the stop is still reported, without a screenshot',async()=>{
 await assert.rejects(withStallLimit(new Promise(()=>{}),20),(error)=>{
  assert.match(error.message,/stopped responding/);
  assert.equal(takeEvidence(error),null);
  return true;
 });
});

test('the captured location keeps the path and drops the query string',async()=>{
 const context=fakeContext('https://lohith.fiveriverz.com/contacts?token=abc');
 registerLiveContext(context);
 try{
  const captured=await captureStalledPage();
  assert.equal(captured.where,'/contacts');
  assert.equal(captured.screenshot,SHOT);
 }finally{
  unregisterLiveContext(context);
 }
});
