import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../core/store.mjs';
import {openStagingLeases,bindSignInRecorder,recordSignInAttempt} from '../core/staging-lease.mjs';

// Nothing here may reach staging: no browser, no Keychain.
process.env.QA_FORBID_LIVE='1';

function withLeases(fn){
 const dir=mkdtempSync(join(tmpdir(),'qa-lease-'));
 try{
  const {db,audit}=openStore(dir);
  return fn({db,audit,leases:openStagingLeases(db,audit)});
 }finally{
  rmSync(dir,{recursive:true,force:true});
 }
}

test('one staging operation at a time per environment; the holder is named when refused',()=>{
 withLeases(({leases})=>{
  const first=leases.acquire({environmentId:'lawcus',kind:'run'});
  assert.equal(first.ok,true);
  const second=leases.acquire({environmentId:'lawcus',kind:'deletion'});
  assert.deepEqual([second.ok,second.holder],[false,'run']);
  assert.equal(leases.release(first.id),true);
  assert.equal(leases.acquire({environmentId:'lawcus',kind:'sweep'}).ok,true);
 });
});

test('a released lease cannot be released again, and a lease cannot be released by another status',()=>{
 withLeases(({leases})=>{
  const lease=leases.acquire({environmentId:'lawcus',kind:'run'});
  assert.equal(leases.release(lease.id),true);
  assert.equal(leases.release(lease.id),false);
 });
});

test('a sign-in is refused without an active lease and recorded under the active one',()=>{
 withLeases(({db,leases})=>{
  assert.throws(()=>leases.recordSignIn({environmentId:'lawcus',purpose:'check'}),/needs an active staging operation/);
  const lease=leases.acquire({environmentId:'lawcus',kind:'impacted_run'});
  for(let i=0;i<5;i++)leases.recordSignIn({environmentId:'lawcus',purpose:'check'});
  assert.equal(leases.signInsSince('lawcus','1970-01-01T00:00:00.000Z'),5);
  const row=db.prepare("SELECT lease_id FROM staging_sign_ins LIMIT 1").get();
  assert.equal(row.lease_id,lease.id);
 });
});

test('the browser helper cannot sign in until the service binds the recorder',()=>{
 withLeases(({leases})=>{
  bindSignInRecorder(null);
  assert.throws(()=>recordSignInAttempt('check'),/Nothing was signed in/);
  leases.acquire({environmentId:'lawcus',kind:'run'});
  bindSignInRecorder((purpose)=>leases.recordSignIn({environmentId:'lawcus',purpose}));
  assert.equal(typeof recordSignInAttempt('check'),'string');
  bindSignInRecorder(null);
 });
});

test('a lease left active by a stopped service is abandoned at startup, freeing the environment and leaving an audit trail',()=>{
 withLeases(({db,audit,leases})=>{
  const stale=leases.acquire({environmentId:'lawcus',kind:'deletion'});
  assert.equal(leases.abandonStale(),1);
  assert.equal(db.prepare("SELECT status FROM staging_leases WHERE id=?").get(stale.id).status,'abandoned');
  assert.equal(leases.acquire({environmentId:'lawcus',kind:'run'}).ok,true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='staging_lease.abandoned'").get().n,1);
  assert.equal(typeof audit,'function');
 });
});
