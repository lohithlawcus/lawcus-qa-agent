import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {publicIPv4,startEgress} from '../core/egress.mjs';
import {permitLiveRequest,permitContactsRequest,permitLeadsRequest,STAGING,API_ORIGIN,ASSETS} from '../core/live-runner.mjs';
import {sealEvidence,openEvidence,CredentialSetup} from '../core/setup.mjs';
import {createOpenAIProvider} from '../ai/providers/openai.mjs';

test('Staging blocks other tenants, metadata, credentialed URLs and business writes',()=>{
 for(const [url,method,type='fetch'] of [
  ['http://169.254.169.254/latest/meta-data','GET'],['http://127.0.0.1:4319/setup/credentials','POST'],
  ['https://other.fiveriverz.com/login','GET'],[STAGING+'@evil.test','GET'],
  ['https://user:password@api.fiveriverz.com/login','POST'],[API_ORIGIN+':444/login','POST'],
  [API_ORIGIN+'/matters','POST'],[API_ORIGIN+'/login','DELETE'],[ASSETS+'/collect','POST'],
  [ASSETS+'/collect','GET','fetch'],['file:///etc/passwd','GET'],
 ])assert.equal(permitLiveRequest(url,method,type),false,url);
 assert.equal(permitLiveRequest(API_ORIGIN+'/login','POST','fetch'),true);
 assert.equal(permitLiveRequest(API_ORIGIN+'/forcelogout','POST','fetch'),true);
 assert.equal(permitLiveRequest(API_ORIGIN+'/forcelogout','DELETE','fetch'),false);
 assert.equal(permitLiveRequest(ASSETS+'/app.js','GET','script'),true);
});
test('Contacts policy is permitLiveRequest plus exactly two write shapes — PUT /contacts/:uuid and POST /contacts — nothing broader',()=>{
 assert.equal(permitContactsRequest(API_ORIGIN+'/login','POST','fetch'),true);
 assert.equal(permitContactsRequest(ASSETS+'/app.js','GET','script'),true);
 assert.equal(permitContactsRequest(API_ORIGIN+'/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381','PUT','fetch'),true);
 assert.equal(permitContactsRequest(API_ORIGIN+'/contacts','POST','fetch'),true);
 assert.equal(permitContactsRequest(API_ORIGIN+'/v2/contacts','POST','fetch'),true);
 for(const [url,method] of [
  [API_ORIGIN+'/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381','DELETE'],
  [API_ORIGIN+'/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381','POST'],
  [API_ORIGIN+'/contacts/not-a-uuid','PUT'],
  [API_ORIGIN+'/contacts','PUT'],
  [API_ORIGIN+'/contacts','DELETE'],
   [API_ORIGIN+'/customfields','PUT'],
  [API_ORIGIN+'/matters/e2bf71a0-ae87-11f1-ab8e-f18331cbd381','PUT'],
  ['https://user:password@'+API_ORIGIN.replace('https://','')+'/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381','PUT'],
 ])assert.equal(permitContactsRequest(url,method,'fetch'),false,`${method} ${url}`);
});
test('Leads policy is permitLiveRequest plus exactly one write path (/leads, PUT for update or POST for create, no :uuid segment) — nothing broader',()=>{
 assert.equal(permitLeadsRequest(API_ORIGIN+'/login','POST','fetch'),true);
 assert.equal(permitLeadsRequest(ASSETS+'/app.js','GET','script'),true);
 assert.equal(permitLeadsRequest(API_ORIGIN+'/leads','PUT','fetch'),true);
 assert.equal(permitLeadsRequest(API_ORIGIN+'/leads','POST','fetch'),true);
 for(const [url,method] of [
  [API_ORIGIN+'/leads','DELETE'],
  [API_ORIGIN+'/leads/c59e9ec0-b115-11f1-b4fe-1feb32eda16d','POST'],
  [API_ORIGIN+'/leads/c59e9ec0-b115-11f1-b4fe-1feb32eda16d','PUT'],
  [API_ORIGIN+'/v2/leads','PUT'],
  [API_ORIGIN+'/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381','PUT'],
  [API_ORIGIN+'/matters/c59e9ec0-b115-11f1-b4fe-1feb32eda16d','PUT'],
  ['https://user:password@'+API_ORIGIN.replace('https://','')+'/leads','PUT'],
 ])assert.equal(permitLeadsRequest(url,method,'fetch'),false,`${method} ${url}`);
});
test('DNS rebinding to private or mixed address sets fails before the proxy opens',async()=>{
 for(const addresses of [['127.0.0.1'],['169.254.169.254'],['93.184.216.34','10.0.0.1'],[]])
  await assert.rejects(startEgress(['approved.example'],{dns:async()=>addresses}));
 for(const value of ['0.0.0.0','10.1.2.3','100.64.0.1','172.16.0.1','192.168.0.1','198.18.0.1','224.0.0.1','999.1.1.1','::1'])assert.equal(publicIPv4(value),false);
 assert.equal(publicIPv4('93.184.216.34'),true);
});
test('Encrypted evidence round-trips and rejects tampering, wrong keys and truncation',async()=>{
 const secret=randomBytes(32).toString('base64');const options={keyLoader:async()=>secret};
 const original=Buffer.from('synthetic sensitive evidence');
 const first=await sealEvidence(original,options),second=await sealEvidence(original,options);
 assert.notDeepEqual(first,second);assert.equal(first.includes(original),false);
 assert.deepEqual(await openEvidence(first,options),original);
 const tampered=Buffer.from(first);tampered[tampered.length-1]^=1;
 await assert.rejects(openEvidence(tampered,options));
 await assert.rejects(openEvidence(first,{keyLoader:async()=>randomBytes(32).toString('base64')}));
 await assert.rejects(openEvidence(first.subarray(0,10),options));
});
const valid={title:'Login essentials',scenarios:['valid_login'],summary:'Check dedicated account login.',clarification:''};
function plannerFor(plan,status='completed',http=200,onRequest=()=>{}){
 const provider=createOpenAIProvider({getSecret:async()=> 'synthetic-api-key',request:async(url,options)=>{onRequest(url,options);return new Response(JSON.stringify({status,output:[{content:[{type:'output_text',text:JSON.stringify(plan)}]}],usage:{input_tokens:10,output_tokens:20}}),{status:http});}});
 return (intent)=>provider.planLogin({intent},{model:'gpt-4.1-mini'});
}
test('AI planning sends only intent and fixed contract, then returns a bounded plan',async()=>{
 const result=await plannerFor(valid,'completed',200,(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);
  assert.equal(body.store,false);assert.equal(body.input,'Test login');assert.equal(body.text.format.strict,true);
  assert.equal(body.instructions.includes('synthetic-api-key'),false);
 })('Test login');
 assert.equal(result.source,'openai');assert.deepEqual(result.plan.scenarios,['valid_login']);assert.equal(result.modelCalls,1);
});
test('Untrusted AI output cannot add code, unsupported actions, duplicates or negative attempts',async()=>{
 for(const plan of [{...valid,code:'execute()'},{...valid,scenarios:['delete_user']},{...valid,scenarios:['valid_login','valid_login']},{...valid,scenarios:['invalid_password']}])await assert.rejects(plannerFor(plan)('Test login'));
 await assert.rejects(plannerFor(valid,'incomplete')('Test login'));
 await assert.rejects(plannerFor({...valid,clarification:'Which supported login check do you mean?'})('Test billing'),/Which supported/);
});
test('API authentication and quota errors stay actionable, and obvious secrets never reach the model',async()=>{
 await assert.rejects(plannerFor(valid,'completed',401)('Test login'),/API key/);
 await assert.rejects(plannerFor(valid,'completed',429)('Test login'),/billing/);
 let requested=false;const planner=plannerFor(valid,'completed',200,()=>{requested=true;});
 await assert.rejects(planner('Test login password=synthetic'),/Remove credentials/);assert.equal(requested,false);
});
test('Credential input rejects missing values and arbitrary credential names',()=>{
 for(const input of [{kind:'lawcus',username:'qa@example.com'},{kind:'openai'},{kind:'unknown',apiKey:'sk-synthetic-value-that-is-not-real'}])assert.equal(CredentialSetup.safeParse(input).success,false);
});
test('Credential input defaults environmentId to the primary environment, and rejects an unknown one',()=>{
 const withoutEnvironmentId=CredentialSetup.safeParse({kind:'lawcus',username:'qa@example.com',password:'x'});
 assert.equal(withoutEnvironmentId.success,true);
 assert.equal(withoutEnvironmentId.data.environmentId,'lawcus');
 const named=CredentialSetup.safeParse({kind:'lawcus',environmentId:'prod-eu',username:'qa@example.com',password:'x'});
 assert.equal(named.success,true);
 assert.equal(named.data.environmentId,'prod-eu');
 assert.equal(CredentialSetup.safeParse({kind:'lawcus',environmentId:'made-up',username:'qa@example.com',password:'x'}).success,false);
});


test('AI billing diagnostics distinguish known codes without exposing provider messages',async()=>{
 const provider=createOpenAIProvider({getSecret:async()=> 'synthetic-api-key',request:async()=>new Response(JSON.stringify({error:{code:'credit_balance_exhausted',message:'Sensitive provider account details'}}),{status:429})});
 await assert.rejects(provider.planLogin({intent:'Test login'},{model:'gpt-4.1-mini'}),error=>error.message.includes('credits are exhausted')&&!error.message.includes('Sensitive'));
});
