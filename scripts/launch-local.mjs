import {buildKeychain} from './build-keychain.mjs';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
buildKeychain();
const children=[];
let stopping=false;
function stop(code=0){
 if(stopping)return;
 stopping=true;
 for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}
 process.exitCode=code;
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
async function ready(url,service=false){
 try{
  const r=await fetch(url,{signal:AbortSignal.timeout(1000),headers:service?{Origin:'http://127.0.0.1:5173','X-QA-Client':'lawcus-workspace'}:{}});
  return service?r.status===401:r.ok;
 }catch{return false;}
}
const serviceAlready=await ready('http://127.0.0.1:4319/state',true);
const uiAlready=await ready('http://127.0.0.1:5173/');
const jobs=[];
if(!serviceAlready)jobs.push(['--watch','server/index.mjs']);
if(!uiAlready)jobs.push(['scripts/run-framework.mjs','dev']);
for(const args of jobs){
 const child=spawn(process.execPath,args,{cwd:process.cwd(),stdio:'inherit',detached:true});children.push(child);
 child.on('error',()=>{console.error('The local application could not start.');stop(1);});
 child.on('exit',code=>{if(!stopping){console.error(`A local component stopped (code ${code}). Share the error above, without credentials.`);stop(code||1);}});
}
console.log('Starting Lawcus QA Agent. Keep this window open while using the app.');
let connected=false;
for(let attempt=0;attempt<60&&!stopping;attempt++){
 if(await ready('http://127.0.0.1:4319/state',true)&&await ready('http://127.0.0.1:5173/')){
  console.log('QA service listening. Open http://127.0.0.1:5173/');
  if(process.platform==='darwin')spawn('open',['http://127.0.0.1:5173/'],{stdio:'ignore'});
  connected=true;break;
 }
 await pause(500);
}
if(!connected&&!stopping)console.error('The app is not ready yet. Share the startup error above, without credentials.');
