import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {createInterface} from 'node:readline/promises';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const readJSON=p=>JSON.parse(fs.readFileSync(path.resolve(root,p),'utf8'));
export const saveJSON=(p,x)=>fs.writeFileSync(path.resolve(root,p),JSON.stringify(x,null,2)+'\n',{mode:0o600});
export function fail(e){console.error('\nZAUSTAVLJENO: '+e.message+'\nOriginalni projekt nije mijenjan.');process.exitCode=1;}
export async function ask(q){const r=createInterface({input:process.stdin,output:process.stdout});try{return (await r.question(q)).trim();}finally{r.close();}}
export async function hidden(q){
 if(!process.stdin.isTTY)return ask(q);
 process.stdout.write(q);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
 return new Promise((resolve,reject)=>{let value='';const done=(err)=>{process.stdin.off('data',on);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');err?reject(err):resolve(value);};const on=c=>{for(const ch of c){if(ch==='\u0003'){done(new Error('Prekinuto.'));return;}if(ch==='\r'||ch==='\n'){done();return;}if(ch==='\u007f'||ch==='\b'){value=value.slice(0,-1);}else if(ch>=' '){value+=ch;}}};process.stdin.on('data',on);});
}
export async function wrangler(args,{capture=false,quiet=false}={}){
 const script=path.join(root,'node_modules','wrangler','bin','wrangler.js');if(!fs.existsSync(script))throw new Error('Prvo pokreni npm install u ovoj NOVOJ mapi.');
 return new Promise((resolve,reject)=>{let out='';const child=spawn(process.execPath,[script,...args],{cwd:root,stdio:['inherit','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{out+=b.toString();if(!quiet)process.stdout.write(b);});child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(new Error(`Wrangler nije uspio (${args.slice(0,3).join(' ')}, kod ${code}). Provjeri ispis iznad.`)));});
}
export function verifyConfig(){
 if(!fs.existsSync(path.join(root,'.kzm-new-project')))throw new Error('Nije mapa novog KZM projekta.');
 const state=readJSON('private/setup.json'),config=readJSON('wrangler.json');
 if(!/^kzm-novi-[a-f0-9]{6}$/.test(config.name)||config.name!==state.name||config.d1_databases?.[0]?.database_id!==state.databaseId||config.d1_databases?.[0]?.database_name!==state.name+'-db'||config.routes||config.route||config.vars?.PROJECT_ID!==state.projectId)throw new Error('Konfiguracija ne odgovara ovoj zasebnoj instalaciji. Necu objavljivati.');
 return {state,config};
}
export function safeUrl(url,name){const u=new URL(url);if(u.protocol!=='https:'||!u.hostname.startsWith(name+'.')||!u.hostname.endsWith('.workers.dev')||u.username||u.password)throw new Error('Ocekuje se nova HTTPS workers.dev adresa ovog projekta.');return u.origin;}
export async function request(url,path,body,cookie=''){
 const origin=new URL(url).origin,headers={};if(cookie)headers.Cookie=cookie;const init={headers,signal:AbortSignal.timeout(60000)};
 if(body!==undefined){init.method='POST';headers.Origin=origin;headers['X-KZM-Request']='1';headers['Content-Type']='application/json';init.body=JSON.stringify(body);}
 const res=await fetch(origin+path,init);const data=await res.json().catch(()=>({error:'Odgovor nije JSON.'}));if(!res.ok||data.ok===false)throw new Error(data.error||'HTTP '+res.status);return {data,cookie:res.headers.get('set-cookie')?.split(';')[0]||cookie};
}
