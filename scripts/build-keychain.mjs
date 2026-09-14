import {spawnSync} from 'node:child_process';
import {mkdirSync,statSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
export function buildKeychain(){
 if(process.platform!=='darwin')throw new Error('This V1 credential provider requires macOS Keychain.');
 const source=resolve('server/native/Keychain.swift');const binary=resolve('work/bin/qa-keychain');
 mkdirSync(resolve('work/bin'),{recursive:true,mode:0o700});
 if(existsSync(binary)&&statSync(binary).mtimeMs>=statSync(source).mtimeMs)return binary;
 const result=spawnSync('/usr/bin/swiftc',['-O','-module-cache-path',resolve('work/swift-cache'),source,'-o',binary],{encoding:'utf8',timeout:120000});
 if(result.status!==0)throw new Error('The macOS credential helper could not be built. Apple Command Line Tools are required.');
 return binary;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){buildKeychain();console.log('Credential helper built. No secrets accessed.');}
