import {z} from 'zod';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {keychain,readSecret} from './secrets.mjs';
// V5 Step 12 — a persona credential names its own Keychain account
// (validated against secrets.mjs's fixed allowlist by keychain() itself,
// not repeated here) rather than always writing 'lawcus-login'.
const PERSONA_ACCOUNTS=['lawcus-persona-admin','lawcus-persona-member','lawcus-persona-co-counsel','lawcus-persona-custom'];
export const CredentialSetup=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('lawcus'),username:z.string().email().max(254),password:z.string().min(1).max(1024)}).strict(),
 z.object({kind:z.literal('openai'),apiKey:z.string().startsWith('sk-').min(25).max(600)}).strict(),
 z.object({kind:z.literal('lawcus-persona'),account:z.enum(PERSONA_ACCOUNTS),username:z.string().email().max(254),password:z.string().min(1).max(1024)}).strict()
]);
export async function setupStatus(){
 const [login,ai]=await Promise.all([keychain('exists','lawcus-login'),keychain('exists','openai-api')]);
 return {loginConfigured:login.exists,aiConfigured:ai.exists,target:'https://lohith.fiveriverz.com',storage:'macOS Keychain'};
}
export async function saveCredentials(input){
 if(input.kind==='lawcus')await keychain('set','lawcus-login',JSON.stringify({username:input.username,password:input.password}));
 else if(input.kind==='lawcus-persona')await keychain('set',input.account,JSON.stringify({username:input.username,password:input.password}));
 else await keychain('set','openai-api',input.apiKey);
 const key=await keychain('exists','artifact-key');if(!key.exists)await keychain('set','artifact-key',randomBytes(32).toString('base64'));
 return {ok:true,message:input.kind==='openai'?'API key saved in macOS Keychain. It will be checked when you create an AI plan.':'Staging credentials saved in macOS Keychain.'};
}
export async function sealEvidence(data,{keyLoader=readSecret}={}){
 const key=Buffer.from(await keyLoader('artifact-key'),'base64');if(key.length!==32)throw new Error('The evidence key is invalid.');
 const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,nonce);const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);key.fill(0);
 return Buffer.concat([Buffer.from('LQA1'),nonce,cipher.getAuthTag(),ciphertext]);
}
export async function openEvidence(data,{keyLoader=readSecret}={}){
 if(data.length<32||data.subarray(0,4).toString()!=='LQA1')throw new Error('Invalid encrypted evidence.');
 const key=Buffer.from(await keyLoader('artifact-key'),'base64');const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(4,16));decipher.setAuthTag(data.subarray(16,32));
 try{return Buffer.concat([decipher.update(data.subarray(32)),decipher.final()]);}finally{key.fill(0);}
}
