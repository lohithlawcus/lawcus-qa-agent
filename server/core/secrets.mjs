import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {noteKeychainValue} from './redact.mjs';
// V5 Step 12 — one fixed Keychain slot per persona role (section 18). A
// literal allowlist, not a pattern: a new role needs a deliberate edit
// here, same discipline as a new primitive needing a deliberate hash
// (section 12's "engineering review required for new capability" applied
// to credential storage too).
// V5 "add two more urls" (2026-09-17) — each Lawcus environment has its
// own dedicated account (operator's own answer), so each gets its own
// slot, same discipline as the persona slots above: 'lawcus-login' stays
// Fiveriverz's own slot (unchanged, so its already-saved credential is
// never disturbed by this), the three new environments get their own.
const accounts=new Set(['lawcus-login','lawcus-login-co-server','lawcus-login-prod-usa','lawcus-login-prod-eu','openai-api','ai-openrouter','ai-anthropic','artifact-key','lawcus-persona-admin','lawcus-persona-member','lawcus-persona-co-counsel','lawcus-persona-custom']);
export async function keychain(operation,account,value){
 // Test-safety tripwire: a process that sets QA_FORBID_LIVE (the truthful-
 // accounting tests do) can never reach the real Keychain, so a broken
 // safeguard fails fast instead of falling through to live staging code.
 if(process.env.QA_FORBID_LIVE)throw new Error('Live access (Keychain) is forbidden in this process.');
 if(!accounts.has(account))throw new Error('Unknown credential reference.');
 if(operation==='set')noteKeychainValue(value);
 return await new Promise((resolveResult,reject)=>{
  const child=spawn(resolve('work/bin/qa-keychain'),[],{stdio:['pipe','pipe','ignore']});let output='';let settled=false;
  const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)reject(err);else resolveResult(result);};
  const timer=setTimeout(()=>{child.kill();finish(new Error('Keychain access timed out. Please unlock your Mac and approve its credential prompt.'));},30000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>20000){child.kill();finish(new Error('Invalid credential response.'));}});
  child.once('error',()=>finish(new Error('The macOS credential helper is unavailable. Restart the app using its launcher.')));
  child.once('close',()=>{try{const result=JSON.parse(output);if(!result.ok)throw new Error();finish(null,result);}catch{finish(new Error('macOS Keychain access was not granted. No secret was saved or returned.'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({operation,account,...(value===undefined?{}:{value})}));
 }).then(result=>{
  // Register what this process now holds (a value it read, or is about to
  // save) so redact.mjs can mask it exactly wherever it later shows up in
  // text — e.g. in a Playwright error that quotes a typed value.
  if(operation==='get'&&result?.exists)noteKeychainValue(result.value);
  return result;
 });
}
export async function readSecret(account){const result=await keychain('get',account);if(!result.exists)throw new Error('Complete secure setup before using this connection.');return result.value;}
