import {normalize,cycleFor,assert} from '../src/rules.js';
import {passwordHash} from '../src/auth.js';
import {validateDataset} from '../src/import-data.js';
import crypto from 'node:crypto';
export async function prepareSnapshot(raw,owner,pepper,season=2026){
 assert(raw.format==='kzm-export-v1','Datoteka nije KZM izvoz.');assert(raw.season===Number(season),'Pogresna sezona.');
 assert(Array.isArray(raw.players)&&Array.isArray(raw.teams)&&Array.isArray(raw.rounds),'Nepotpun izvoz.');
 const out={format:'kzm-prepared-v1',season:Number(season),players:[],teams:[],rounds:[],fixtures:[],picks:[],payments:[]},credentials=[],warnings=[...(raw.warnings||[])];
 const pmap=new Map(),tmap=new Map();
 for(const p of raw.players){const key=normalize(p.name);assert(!pmap.has(key),'Duplicirano ime igraca: '+p.name);const id=key===normalize(owner.name)?owner.id:crypto.randomUUID();const password=crypto.randomBytes(12).toString('base64url');const h=await passwordHash(password,pepper);out.players.push({id,name:p.name,active:p.active===false?0:1,...h});pmap.set(key,id);if(id!==owner.id)credentials.push({name:p.name,password});for(let c=1;c<=4;c++){const v=p.payments?.[c];assert(v===undefined||v===null||typeof v==='boolean','Nepoznat status placanja za '+p.name);out.payments.push({player_id:id,cycle:c,paid:v==null?null:Number(v)});}}
 assert(out.players.some(p=>p.id===owner.id),'Ime administratora nije pronadjeno u izvezenoj ligi. Ime mora biti isto, ukljucujuci dijakritike.');
 for(const t of raw.teams){const key=normalize(t.name);assert(!tmap.has(key),'Dupliciran klub: '+t.name);assert(typeof t.base==='number','Nedostaju osnovni bodovi za '+t.name);const id=crypto.randomUUID();out.teams.push({id,name:t.name,base:t.base,color:t.color||'#37003c',api_id:t.apiId??null});tmap.set(key,id);}
 for(const r of raw.rounds){const deadline=r.deadline===null?null:Math.floor(Date.parse(r.deadline)/1000);out.rounds.push({number:r.number,deadline});if(deadline===null)warnings.push('Kolo '+r.number+' nema rok: bit ce zatvoreno za odabire.');
 for(const f of r.fixtures||[]){const h=tmap.get(normalize(f.home)),a=tmap.get(normalize(f.away));assert(h&&a,'Nepoznat klub u rasporedu kola '+r.number);out.fixtures.push({id:crypto.randomUUID(),round_no:r.number,home_id:h,away_id:a,kickoff:f.kickoff?Math.floor(Date.parse(f.kickoff)/1000):null,home_score:f.homeScore??null,away_score:f.awayScore??null,status:f.status||'SCHEDULED',api_id:f.apiId??null,manual_score:f.manualScore?1:0});}
 for(const p of r.picks||[]){const pid=pmap.get(normalize(p.player)),tid=tmap.get(normalize(p.team));assert(pid&&tid,'Nepoznat igrac/klub u odabiru kola '+r.number);const team=out.teams.find(t=>t.id===tid);out.picks.push({player_id:pid,round_no:r.number,cycle:cycleFor(r.number),team_id:tid,is_double:p.double?1:0,base:p.base??team.base,imported_points:p.points??null});}
 }
 const summary=validateDataset(out,owner,season);
 if(raw.totals){for(const [name,total]of Object.entries(raw.totals)){const pid=pmap.get(normalize(name));if(!pid||!Number.isFinite(total))continue;const sum=out.picks.filter(p=>p.player_id===pid).reduce((n,p)=>n+(p.imported_points||0),0);if(Math.abs(sum-total)>0.001)warnings.push(`Razlika povijesnih bodova za ${name}: odabiri ${sum}, list Rezultati ${total}. Provjeri izvor prije prijelaza.`);}}
 return {data:out,credentials,summary,warnings};
}
