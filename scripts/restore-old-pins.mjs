import fs from 'node:fs';
import path from 'node:path';
import {root,verifyConfig,readJSON,ask,hidden,request,fail} from './common.mjs';
import {normalize} from '../src/rules.js';

async function main(){
  const {state}=verifyConfig();
  if(!state.completed) throw new Error('Prvo dovrsi setup ove instalacije.');
  const file=process.argv[2];
  if(!file) throw new Error('Primjer: node scripts/restore-old-pins.mjs "C:\\Users\\dinoj\\Downloads\\kzm-pinovi.json"');
  const raw=JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
  if(raw.format!=='kzm-pin-export-v1'||!Array.isArray(raw.players)) throw new Error('Datoteka nije KZM izvoz PIN-ova.');

  const input=new Map();
  for(const p of raw.players){
    const name=String(p?.name||'').normalize('NFC').trim().replace(/\s+/g,' ');
    const pin=String(p?.pin||'').trim();
    if(!name) throw new Error('Pronadjen je igrac bez imena.');
    if(!/^\d{4,12}$/.test(pin)) throw new Error('PIN za '+name+' mora imati 4-12 znamenki.');
    const key=normalize(name);
    if(input.has(key)) throw new Error('Dupliciran igrac u PIN izvozu: '+name);
    input.set(key,{name,pin});
  }

  let auth;
  try{
    auth=await request(state.url,'/api/login',{name:state.adminName,password:state.adminPassword});
  }catch{
    const current=await hidden('Trenutni administratorski PIN/lozinka (unos je skriven): ');
    auth=await request(state.url,'/api/login',{name:state.adminName,password:current});
  }
  const panel=(await request(state.url,'/api/admin/panel',undefined,auth.cookie)).data;
  const dbMap=new Map(panel.players.map(p=>[normalize(p.name),p]));
  const missing=[...dbMap.entries()].filter(([k])=>!input.has(k)).map(([,p])=>p.name);
  const extra=[...input.entries()].filter(([k])=>!dbMap.has(k)).map(([,p])=>p.name);
  if(missing.length||extra.length){
    throw new Error('PIN izvoz i nova baza se ne podudaraju. Nedostaju PIN-ovi za: '+(missing.join(', ')||'-')+'; visak u izvozu: '+(extra.join(', ')||'-')+'.');
  }
  if(input.size!==dbMap.size) throw new Error('Broj igraca u PIN izvozu i bazi nije isti.');

  console.log(`\nProvjereno: ${input.size} igraca. Cilj: ${state.url}`);
  console.log('Svi igraci ce ponovno koristiti svoje STARE PIN-ove. Aktivne sesije bit ce odjavljene.');
  if(await ask('Za nastavak upisi VRATI STARE PINOVE: ')!=='VRATI STARE PINOVE') return;

  const adminKey=normalize(state.adminName);
  const ordered=[...input.entries()].sort(([a],[b])=>a===adminKey?1:b===adminKey?-1:a.localeCompare(b,'hr'));
  let done=0;
  for(const [key,p] of ordered){
    const target=dbMap.get(key);
    await request(state.url,`/api/admin/players/${target.id}/password`,{password:p.pin},auth.cookie);
    done++;
    process.stdout.write(`\rVracam stare PIN-ove: ${done}/${ordered.length}`);
  }
  process.stdout.write('\n');

  const access=path.join(root,'private','PRISTUP-ADMIN.txt');
  fs.writeFileSync(access,`PRIVATNO - ADMIN PRISTUP\n\nURL: ${state.url}\nAdministrator: ${state.adminName}\nPrijava: koristi STARI PIN iz originalnog KZM-a.\n\nGenerirana setup lozinka vise ne vrijedi nakon vracanja starih PIN-ova.\n`,{mode:0o600});
  console.log('\nGOTOVO: svi igraci sada koriste stare PIN-ove.');
  console.log('Datoteka kzm-pinovi.json sadrzi osjetljive podatke; nakon provjere je obrisi iz Downloads.');
  console.log('Odjavi se i testiraj prijavu starim PIN-om prije slanja URL-a igracima.');
}
main().catch(fail);
