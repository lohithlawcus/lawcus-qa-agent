import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AI_PROVIDERS,AI_PROVIDER_IDS} from '../ai/providers/catalog.mjs';
import {createChatCompatibleProvider} from '../ai/providers/chat-compatible.mjs';
import {readAiSettings,writeAiSettings} from '../ai/settings.mjs';
import {CredentialSetup} from '../core/setup.mjs';

const SYNTHETIC_KEY='synthetic-provider-key-0123456789';
const plan={title:'Login essentials',scenarios:['valid_login'],summary:'Covers a valid sign-in.',clarification:''};
function chatReply(content,status='stop'){
 return new Response(JSON.stringify({choices:[{finish_reason:status,message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:12,completion_tokens:34}}),{status:200});
}

test('every AI provider has one fixed https base URL and a Keychain slot of its own',()=>{
 const accounts=AI_PROVIDER_IDS.map(id=>AI_PROVIDERS[id].account);
 assert.equal(new Set(accounts).size,accounts.length);
 for(const id of AI_PROVIDER_IDS){
  const url=new URL(AI_PROVIDERS[id].baseUrl);
  assert.equal(url.protocol,'https:');
  assert.equal(url.username+url.password+url.search,'');
 }
});

test('a chat-completions provider sends the key only to its own catalog address',async()=>{
 const seen=[];
 const provider=createChatCompatibleProvider({providerId:'openrouter',getSecret:async()=>SYNTHETIC_KEY,request:async(url,options)=>{seen.push({url,options});return chatReply(plan);}});
 const result=await provider.planLogin({intent:'Test a valid login'},{model:'openai/gpt-4.1-mini'});
 assert.equal(seen.length,1);
 assert.equal(seen[0].url,'https://openrouter.ai/api/v1/chat/completions');
 assert.equal(seen[0].options.redirect,'error');
 assert.equal(seen[0].options.headers.Authorization,`Bearer ${SYNTHETIC_KEY}`);
 assert.deepEqual(result.plan.scenarios,['valid_login']);
 assert.equal(result.source,'openrouter');
 assert.deepEqual(result.usage,{model:'openai/gpt-4.1-mini',inputTokens:12,outputTokens:34});
});

test('a rejected key names the provider and echoes nothing from the provider body',async()=>{
 const provider=createChatCompatibleProvider({providerId:'anthropic',getSecret:async()=>SYNTHETIC_KEY,request:async()=>new Response('{"error":{"message":"account 4421 details"}}',{status:401})});
 await assert.rejects(provider.planLogin({intent:'Test a valid login'},{model:'m'}),(error)=>{
  assert.match(error.message,/Anthropic did not accept this API key/);
  assert.doesNotMatch(error.message,/4421/);
  return true;
 });
});

test('a truncated AI answer is refused rather than saved as a plan',async()=>{
 const provider=createChatCompatibleProvider({providerId:'openrouter',getSecret:async()=>SYNTHETIC_KEY,request:async()=>chatReply(plan,'length')});
 await assert.rejects(provider.planLogin({intent:'Test a valid login'},{model:'m'}),/incomplete/);
});

test('an intent that contains a credential is refused before any key is read or sent',async()=>{
 let read=false,sent=false;
 const provider=createChatCompatibleProvider({providerId:'openrouter',getSecret:async()=>{read=true;return SYNTHETIC_KEY;},request:async()=>{sent=true;return chatReply(plan);}});
 await assert.rejects(provider.planLogin({intent:'Log in with password: hunter2-real'},{model:'m'}),/Enter them only in secure setup/);
 assert.equal(read,false);
 assert.equal(sent,false);
});

test('secure setup accepts a known provider and refuses an unknown one or a model that is really a URL',()=>{
 const good={kind:'ai',provider:'openrouter',model:'openai/gpt-4.1-mini',apiKey:SYNTHETIC_KEY};
 assert.equal(CredentialSetup.safeParse(good).success,true);
 assert.equal(CredentialSetup.safeParse({...good,provider:'evil-host'}).success,false);
 assert.equal(CredentialSetup.safeParse({...good,model:'https://evil.test/collect'}).success,false);
 assert.equal(CredentialSetup.safeParse({...good,baseUrl:'https://evil.test/v1'}).success,false);
});

test('the saved AI choice defaults to OpenAI, round-trips, and rejects an unknown provider',()=>{
 const dir=mkdtempSync(join(tmpdir(),'qa-ai-settings-'));
 try{
  assert.deepEqual(readAiSettings(dir),{provider:'openai',model:AI_PROVIDERS.openai.defaultModel});
  writeAiSettings(dir,{provider:'openrouter',model:'openai/gpt-4.1-mini'});
  assert.deepEqual(readAiSettings(dir),{provider:'openrouter',model:'openai/gpt-4.1-mini'});
  assert.throws(()=>writeAiSettings(dir,{provider:'https://evil.test',model:'m'}));
  assert.doesNotMatch(readFileSync(join(dir,'ai-settings.json'),'utf8'),/sk-|key/i);
 }finally{
  rmSync(dir,{recursive:true,force:true});
 }
});

test('the Keychain helper and the Node allowlist name the same accounts (or the helper refuses the new ones)',async()=>{
 const {readFileSync:read}=await import('node:fs');
 const names=(file,pattern)=>{const m=pattern.exec(read(new URL(file,import.meta.url),'utf8'));return m?[...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x=>x[1]??x[2]).sort():[];};
 const nodeList=names('../core/secrets.mjs',/const accounts=new Set\(\[([^\]]+)\]\)/);
 const swiftList=names('../native/Keychain.swift',/let allowed = Set\(\[([^\]]+)\]\)/);
 for(const id of AI_PROVIDER_IDS)assert.ok(nodeList.includes(AI_PROVIDERS[id].account),`${AI_PROVIDERS[id].account} missing from secrets.mjs`);
 for(const account of nodeList.filter(a=>!a.startsWith('lawcus-persona')))assert.ok(swiftList.includes(account),`${account} missing from Keychain.swift`);
});
