import {randomUUID} from 'node:crypto';
import {now} from './store.mjs';

// One staging operation at a time per environment, and every staging sign-in is
// recorded under the operation that made it. The database enforces the single active
// lease (a partial unique index), so two requests racing cannot both start.
export const LEASE_KINDS=['run','impacted_run','suite_run','sweep','deletion'];

export function openStagingLeases(db, audit){
 function active(environmentId){
  return db.prepare("SELECT * FROM staging_leases WHERE environment_id=? AND status='active'").get(environmentId)||null;
 }
 function acquire({environmentId,kind}){
  if(!LEASE_KINDS.includes(kind))throw new Error('Unknown staging operation kind.');
  const id=randomUUID();
  try{
   db.prepare("INSERT INTO staging_leases(id,environment_id,kind,status,acquired_at) VALUES(?,?,?,'active',?)").run(id,environmentId,kind,now());
  }catch(error){
   if(!/UNIQUE constraint failed/.test(String(error?.message)))throw error;
   return {ok:false,reason:'busy',holder:active(environmentId)?.kind??null};
  }
  audit?.('staging_lease.acquired',id,{environmentId,kind});
  return {ok:true,id};
 }
 function release(id,{status='released'}={}){
  if(!['released','abandoned'].includes(status))throw new Error('Unknown lease status.');
  const row=db.prepare("UPDATE staging_leases SET status=?,released_at=? WHERE id=? AND status='active' RETURNING environment_id,kind").get(status,now(),id);
  if(row)audit?.(status==='released'?'staging_lease.released':'staging_lease.abandoned',id,{environmentId:row.environment_id,kind:row.kind});
  return Boolean(row);
 }
 // Refuses unless an operation currently holds the environment's lease. A sign-in
 // without one is never allowed to start.
 function recordSignIn({environmentId,purpose}){
  const lease=active(environmentId);
  if(!lease)throw new Error('A staging sign-in needs an active staging operation. Nothing was signed in.');
  const id=randomUUID();
  db.prepare("INSERT INTO staging_sign_ins(id,lease_id,environment_id,purpose,attempted_at) VALUES(?,?,?,?,?)").run(id,lease.id,environmentId,String(purpose).slice(0,80),now());
  audit?.('staging_sign_in.recorded',id,{leaseId:lease.id,environmentId,purpose:String(purpose).slice(0,80)});
  return id;
 }
 function signInsSince(environmentId,sinceIso){
  return db.prepare("SELECT COUNT(*) n FROM staging_sign_ins WHERE environment_id=? AND attempted_at>?").get(environmentId,sinceIso).n;
 }
 // Run once at startup: a lease still active belongs to a process that has exited.
 function abandonStale(){
  const rows=db.prepare("UPDATE staging_leases SET status='abandoned',released_at=? WHERE status='active' RETURNING id,environment_id,kind").all(now());
  for(const row of rows)audit?.('staging_lease.abandoned',row.id,{environmentId:row.environment_id,kind:row.kind,reason:'service restarted while the operation was active'});
  return rows.length;
 }
 return {active,acquire,release,recordSignIn,signInsSince,abandonStale};
}

// The sign-in helper in live-runner.mjs records through this hook, which the service
// binds to the lease ledger at startup. Unbound means no sign-in can be recorded, so none starts.
let recorder=null;
export function bindSignInRecorder(fn){recorder=fn;}
export function recordSignInAttempt(purpose){
 if(!recorder)throw new Error('Staging sign-ins are not available in this process. Nothing was signed in.');
 return recorder(purpose);
}
