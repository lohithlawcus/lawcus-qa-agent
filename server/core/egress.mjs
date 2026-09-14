import {createServer} from 'node:http';
import {connect,isIP} from 'node:net';
import {resolve4} from 'node:dns/promises';
export function publicIPv4(address){
 if(isIP(address)!==4)return false;
 const p=address.split('.').map(Number);if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
 const [a,b,c]=p;
 return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===192&&b===0)||(a===198&&(b===18||b===19))||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113));
}
export async function startEgress(hosts,{dns=resolve4}={}){
 if(hosts.length<1||hosts.length>8)throw new Error('The runner requires a bounded list of authorized hosts.');
 const addresses=new Map();
 for(const host of hosts){
  if(!/^[a-z0-9][a-z0-9.-]+$/.test(host)||host.endsWith('.')||host.includes('..'))throw new Error('Invalid authorized hostname.');
  const resolved=await dns(host);if(!resolved.length||resolved.some(ip=>!publicIPv4(ip)))throw new Error('The staging host resolved to an address that is not permitted.');
  addresses.set(host,resolved[0]);
 }
 const sockets=new Set();let count=0;
 const proxy=createServer((req,res)=>{res.writeHead(403);res.end('HTTPS only');});
 proxy.on('connect',(req,client,head)=>{
  const host=(req.url||'').replace(/:443$/,'');
  if(req.url!==`${host}:443`||!addresses.has(host)||++count>1000){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const upstream=connect({host:addresses.get(host),port:443,timeout:20000});sockets.add(client);sockets.add(upstream);
  const close=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};
  upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});
  upstream.on('error',close);client.on('error',close);upstream.on('timeout',close);client.on('close',close);upstream.on('close',close);
 });
 await new Promise((r,j)=>{proxy.once('error',j);proxy.listen(0,'127.0.0.1',r);});
 return {server:`http://127.0.0.1:${proxy.address().port}`,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>proxy.close(r));}};
}
