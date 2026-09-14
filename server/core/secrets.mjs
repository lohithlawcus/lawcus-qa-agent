import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const accounts=new Set(['lawcus-login','openai-api','artifact-key']);
export async function keychain(operation,account,value){
 if(!accounts.has(account))throw new Error('Unknown credential reference.');
 return await new Promise((resolveResult,reject)=>{
  const child=spawn(resolve('work/bin/qa-keychain'),[],{stdio:['pipe','pipe','ignore']});let output='';let settled=false;
  const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)reject(err);else resolveResult(result);};
  const timer=setTimeout(()=>{child.kill();finish(new Error('Keychain access timed out. Please unlock your Mac and approve its credential prompt.'));},30000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>20000){child.kill();finish(new Error('Invalid credential response.'));}});
  child.once('error',()=>finish(new Error('The macOS credential helper is unavailable. Restart the app using its launcher.')));
  child.once('close',()=>{try{const result=JSON.parse(output);if(!result.ok)throw new Error();finish(null,result);}catch{finish(new Error('macOS Keychain access was not granted. No secret was saved or returned.'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({operation,account,...(value===undefined?{}:{value})}));
 });
}
export async function readSecret(account){const result=await keychain('get',account);if(!result.exists)throw new Error('Complete secure setup before using this connection.');return result.value;}
