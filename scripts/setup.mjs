import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {root,readJSON,saveJSON,ask,wrangler,safeUrl,request,fail} from './common.mjs';
async function main(){
 if(Number(process.versions.node.split('.')[0])<22)throw new Error('Potreban je Node.js 22 ili noviji.');
 if(!fs.existsSync(path.join(root,'.kzm-new-project')))throw new Error('Pogresna mapa.');
 process.chdir(root);fs.mkdirSync(path.join(root,'private'),{recursive:true});
 let state;const forceNew=process.argv.includes('--new');
 if(fs.existsSync(path.join(root,'private/setup.json'))&&!forceNew)state=readJSON('private/setup.json');
 else {
  if(forceNew){
   const a=await ask('Ovo pravi DRUGU novu probnu bazu i adresu. Stara proba ostaje. Upisi NOVO: ');if(a!=='NOVO')return;
   if(fs.existsSync(path.join(root,'private/setup.json'))){
    const archive=path.join(root,'private','arhiva-'+Date.now());fs.mkdirSync(archive,{recursive:true});
    for(const file of ['private/setup.json','private/secrets.json','private/PRISTUP-ADMIN.txt','wrangler.json','private/import-pending.json']){
     const from=path.join(root,file);if(fs.existsSync(from))fs.copyFileSync(from,path.join(archive,path.basename(file)));
    }
    if(fs.existsSync(path.join(root,'private/import-pending.json')))fs.unlinkSync(path.join(root,'private/import-pending.json'));
    console.log('Podaci prethodne probe sacuvani su u '+archive);
   }
  }
  const suffix=crypto.randomBytes(3).toString('hex');
  state={name:'kzm-novi-'+suffix,projectId:crypto.randomUUID(),adminName:'Dino Jerki\u0107',adminPassword:crypto.randomBytes(18).toString('base64url'),createdAt:new Date().toISOString()};
  const name=await ask('Ime administratora [Dino Jerki\u0107; upisi tocno ime iz lige]: ');if(name)state.adminName=name;
  console.log(`\nNOVI projekt: ${state.name}\nNOVA baza: ${state.name}-db\nNema promjena na kzm-frontend-test, kzm-push-bridge ni Apps Scriptu.`);
  if(await ask('Za stvaranje ove nove instalacije upisi NOVO: ')!=='NOVO')return;
  state.accountId=await ask('Cloudflare Account ID (Enter ako koristis jedan racun): ');if(state.accountId&&!/^[a-f0-9]{32}$/i.test(state.accountId))throw new Error('Account ID mora imati 32 heksadekadska znaka.');
  saveJSON('private/setup.json',state);
  const secrets={AUTH_PEPPER:crypto.randomBytes(32).toString('hex'),BOOTSTRAP_KEY:crypto.randomBytes(32).toString('hex')};saveJSON('private/secrets.json',secrets);
 }
 if(state.completed){console.log(`\nOva instalacija vec postoji: ${state.url}\nUpute i pristupni podaci su u private/PRISTUP-ADMIN.txt. Za obnovu koda: npm run deploy.\nZa drugu odvojenu probu: npm run setup -- --new`);return;}
 const secrets=readJSON('private/secrets.json');
 try{const who=await wrangler(['whoami']);if(/not authenticated|not logged in/i.test(who))await wrangler(['login']);}catch{await wrangler(['login']);}
 const base=readJSON('wrangler.example.json');base.name=state.name;base.vars.PROJECT_ID=state.projectId;base.d1_databases[0].database_name=state.name+'-db';if(state.accountId){base.account_id=state.accountId;process.env.CLOUDFLARE_ACCOUNT_ID=state.accountId;}
 if(!state.databaseId){
  const idPattern=/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
  let output='';
  // Recover only our exact generated name after an interrupted create.
  if(state.databaseCreateAttempted){try{output=await wrangler(['d1','info',state.name+'-db','--json']);}catch{}}
  if(!output.match(idPattern)){
   state.databaseCreateAttempted=true;saveJSON('private/setup.json',state);
   output=await wrangler(['d1','create',state.name+'-db','--location','weur']);
  }
  const ids=output.match(idPattern)||[];
  if(!ids.length)throw new Error('ID nove baze nije prepoznat. Sacuvaj CMD ispis. Ponovni setup pokusat ce provjeriti samo ovu novu bazu.');
  state.databaseId=ids[0];saveJSON('private/setup.json',state);
 }
 base.d1_databases[0].database_id=state.databaseId;saveJSON('wrangler.json',base);
 if(!state.migrated){await wrangler(['d1','migrations','apply',state.name+'-db','--remote','--config','wrangler.json']);state.migrated=true;saveJSON('private/setup.json',state);}
 if(!state.url){const out=await wrangler(['deploy','--config','wrangler.json']);const pattern=new RegExp('https://'+state.name+'\\.[a-zA-Z0-9-]+\\.workers\\.dev');state.url=out.match(pattern)?.[0]||await ask('Zalijepi NOVI workers.dev URL iz ispisa iznad: ');state.url=safeUrl(state.url,state.name);saveJSON('private/setup.json',state);}
 if(!state.secretSet){await wrangler(['secret','bulk','private/secrets.json','--config','wrangler.json']);state.secretSet=true;saveJSON('private/setup.json',state);}
 console.log('\nPostavljam administratora u NOVOJ bazi...');
 try{await request(state.url,'/api/setup',{key:secrets.BOOTSTRAP_KEY,name:state.adminName,password:state.adminPassword});}catch(e){if(!e.message.includes('vec postavljena'))throw new Error(e.message+' Pokreni npm run setup ponovno; postojeci koraci ne brisu se.');}
 // Verify the generated credentials rather than claiming setup worked merely from a deploy exit code.
 await request(state.url,'/api/login',{name:state.adminName,password:state.adminPassword});
 fs.writeFileSync(path.join(root,'private/PRISTUP-ADMIN.txt'),`PRIVATNO - NE SALJI OVAJ FILE IGRACIMA\n\nNovi URL: ${state.url}\nAdministrator: ${state.adminName}\nNova lozinka: ${state.adminPassword}\n\nOvo NIJE stari PIN. Lozinku mozes promijeniti u novoj administraciji.\nSacuvaj private/secrets.json u privatnoj sigurnosnoj kopiji; potreban je pri uvozu.\n`,{mode:0o600});
 state.completed=true;saveJSON('private/setup.json',state);
 console.log(`\nGOTOVO: ${state.url}\nPristup: otvori private/PRISTUP-ADMIN.txt\nSljedeci korak je UVOZ PODATAKA prema uputama. Baza je zasad prazna, a odabiri zaustavljeni.`);
}
main().catch(fail);
