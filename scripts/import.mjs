import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {root,verifyConfig,readJSON,saveJSON,ask,hidden,request,fail} from './common.mjs';import {prepareSnapshot} from './prepare-data.mjs';
async function main(){
 const {state,config}=verifyConfig();if(!state.completed)throw new Error('Prvo dovrsi postavljanje.');const file=process.argv[2];if(!file)throw new Error('Primjer: npm run import -- "C:\\Users\\dinoj\\Downloads\\kzm-izvoz.json"');
 let auth;try{auth=await request(state.url,'/api/login',{name:state.adminName,password:state.adminPassword});}catch{const password=await hidden('Trenutna administratorska lozinka (unos je skriven): ');auth=await request(state.url,'/api/login',{name:state.adminName,password});}
 const status=(await request(state.url,'/api/admin/import-status',undefined,auth.cookie)).data;
 const dir=path.join(root,'private'),pendingStateFile=path.join(dir,'import-pending.json');
 function finalize(p,summary){
  const pending=path.join(dir,p.pending),final=path.join(dir,p.final);const text=fs.readFileSync(pending,'utf8');
  fs.writeFileSync(final,text.replace('uvoz jos nije potvrdjen','UVOZ POTVRDJEN'),{mode:0o600});fs.unlinkSync(pending);fs.unlinkSync(pendingStateFile);
  console.log('\nUVOZ POTVRDJEN.');console.table(summary);console.log(`Pristupni kodovi: ${final}\nIzvjestaj: ${path.join(dir,p.report)}\nSpremanje odabira je ZAUSTAVLJENO. Usporedi tablice, uplate i odabire prije ukljucivanja.`);
 }
 if(file==='--recover'){
  const p=readJSON('private/import-pending.json');if(p.projectId!==state.projectId)throw new Error('Zapis pripada drugoj instalaciji.');
  if(!status.imported||status.fingerprint!==p.fingerprint)throw new Error('Posluzitelj nije potvrdio taj uvoz. Ne salji pristupne kodove. Sacuvaj private i prijavi ispis.');
  finalize(p,status.summary);await request(state.url,'/api/logout',{},auth.cookie).catch(()=>{});return;
 }
 if(status.imported)throw new Error('Ova baza vec ima uvoz. Ne prepisujem nista. Za izgubljenu potvrdu: npm run import -- --recover. Za novu probu: npm run setup -- --new.');
 if(fs.existsSync(pendingStateFile))throw new Error('Postoji nepotvrdjeni uvoz. Prvo pokreni npm run import -- --recover; ne stvaraj nove kodove dok se stanje ne razjasni.');
 const st=fs.statSync(file);if(st.size>1800000)throw new Error('Izvoz je prevelik.');const raw=JSON.parse(fs.readFileSync(file,'utf8'));
 const pepper=readJSON('private/secrets.json').AUTH_PEPPER;
 console.log('\nPripremam zasebnu kopiju podataka i NOVE pristupne kodove. Stari PIN-ovi se ne uvoze.');
 const prepared=await prepareSnapshot(raw,{id:'owner',name:state.adminName},pepper,Number(config.vars.SEASON));
 console.log('Odrediste: '+state.url);console.table(prepared.summary);for(const warning of prepared.warnings)console.log('UPOZORENJE: '+warning);
 if(await ask('Za jednokratni uvoz u praznu NOVU bazu upisi UVEZI: ')!=='UVEZI')return;
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const p={projectId:state.projectId,fingerprint:crypto.createHash('sha256').update(JSON.stringify(prepared.data)).digest('hex'),pending:`PRISTUPI-${stamp}.pending.txt`,final:`PRISTUPI-${stamp}.txt`,report:`UVOZ-${stamp}.json`};
 fs.writeFileSync(path.join(dir,p.report),JSON.stringify({source:path.basename(file),sourceExportedAt:raw.exportedAt,summary:prepared.summary,warnings:prepared.warnings,fingerprint:p.fingerprint},null,2));
 fs.writeFileSync(path.join(dir,p.pending),`PRIVATNO - uvoz jos nije potvrdjen\nNovi URL: ${state.url}\nSvakom igracu posalji SAMO njegov red i novi URL.\nAdministrator zadrzava svoju postavljenu lozinku.\n\n`+prepared.credentials.map(p=>`${p.name}\nNovi pristupni kod: ${p.password}\n`).join('\n'),{mode:0o600});saveJSON('private/import-pending.json',p);
 let result;
 try{result=(await request(state.url,'/api/admin/import',prepared.data,auth.cookie)).data;}
 catch(e){
  const check=await request(state.url,'/api/admin/import-status',undefined,auth.cookie).catch(()=>null);
  if(check?.data?.fingerprint===p.fingerprint&&check.data.imported)result=check.data;
  else throw new Error(e.message+' Pristupni kodovi su sacuvani, ali uvoz NIJE potvrdjen. Ne ponavljaj uvoz; provjera: npm run import -- --recover.');
 }
 finalize(p,result.summary);await request(state.url,'/api/logout',{},auth.cookie).catch(()=>{});
}
main().catch(fail);
