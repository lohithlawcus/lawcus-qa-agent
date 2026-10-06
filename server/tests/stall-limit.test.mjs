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

// P0-2: a stopped check is closed, and the stall is reported only once it has shut down.
test('a stalled check is stopped by closing its browser, and the stall error is what is reported',async()=>{
 let closed=false;
 let rejectRunner;
 const runner=new Promise((_,reject)=>{rejectRunner=reject;});
 const page={screenshot:async()=>SHOT,locator:()=>({}),url:()=>'https://lohith.fiveriverz.com/contacts'};
 const context={pages:()=>[page],close:async()=>{closed=true;rejectRunner(new Error('Target page, context or browser has been closed'));}};
 registerLiveContext(context);
 try{
  await assert.rejects(withStallLimit(runner,20,1000),(error)=>{
   assert.equal(closed,true);
   assert.match(error.message,/stopped responding/);
   assert.equal(error.shutdownUnconfirmed,undefined);
   assert.deepEqual(takeEvidence(error),{screenshot:SHOT});
   return true;
  });
 }finally{
  unregisterLiveContext(context);
 }
});

test('a check that does not shut down after its browser is closed is marked as unconfirmed',async()=>{
 const context={pages:()=>[],close:async()=>{}};
 registerLiveContext(context);
 try{
  await assert.rejects(withStallLimit(new Promise(()=>{}),20,30),(error)=>{
   assert.equal(error.shutdownUnconfirmed,true);
   return true;
  });
 }finally{
  unregisterLiveContext(context);
 }
});
