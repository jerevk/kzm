import {assert,normalize,cleanName,integer,cycleFor} from './rules.js';
/** Validates the prepared, credential-hashed snapshot BEFORE a single transactional batch. */
export function validateDataset(b,owner,season){
 assert(b.format==='kzm-prepared-v1','Nepoznat format uvoza. Koristi npm run import.');
 assert(b.season===Number(season),'Sezona izvora nije jednaka sezoni ove instalacije.');
 for(const key of ['players','teams','rounds','fixtures','picks','payments'])assert(Array.isArray(b[key]),`Nedostaje ${key}.`);
 assert(b.players.length>=1&&b.players.length<=200,'Uvoz podrzava 1-200 igraca.');assert(b.teams.length===20,'Ocekuje se 20 klubova; uvoz je zaustavljen.');assert(b.rounds.length===38,'Ocekuje se svih 38 kola.');
 const ids=new Set(),names=new Set();
 for(const p of b.players){cleanName(p.name);assert(typeof p.id==='string'&&/^[a-zA-Z0-9-]{1,50}$/.test(p.id),'Neispravna oznaka igraca.');assert(!ids.has(p.id)&&!names.has(normalize(p.name)),'Dupliciran igrac.');ids.add(p.id);names.add(normalize(p.name));assert(p.active===0||p.active===1,'Neispravna aktivnost.');assert(/^[a-f0-9]{64}$/.test(p.password_hash)&&/^[a-f0-9]{32}$/.test(p.salt)&&p.iterations===100000,'Neispravan zapis lozinke.');}
 const op=b.players.find(x=>x.id===owner.id);assert(op&&normalize(op.name)===normalize(owner.name),'Administrator se ne poklapa s izvorom.');
 const tids=new Set(),tnames=new Set(),apiIds=new Set();for(const t of b.teams){cleanName(t.name);assert(typeof t.id==='string'&&/^[a-zA-Z0-9-]{1,50}$/.test(t.id)&&!tids.has(t.id)&&!tnames.has(normalize(t.name)),'Dupliciran ili neispravan klub.');tids.add(t.id);tnames.add(normalize(t.name));integer(t.base,0,100,'bodovi kluba');assert(/^#[a-f0-9]{6}$/i.test(t.color),'Neispravna boja.');if(t.api_id!==null){integer(t.api_id,1,999999999,'API ID');assert(!apiIds.has(t.api_id),'Dupliciran API ID kluba.');apiIds.add(t.api_id);}}
 const ns=new Set();for(const r of b.rounds){integer(r.number,1,38,'kolo');assert(!ns.has(r.number),'Duplicirano kolo.');ns.add(r.number);assert(r.deadline===null||Number.isInteger(r.deadline)&&r.deadline>0,'Neispravan rok.');}
 const fids=new Set(),occupied=new Set(),matchApi=new Set();for(const f of b.fixtures){assert(b.fixtures.length<=380,'Previse utakmica.');assert(typeof f.id==='string'&&/^[a-zA-Z0-9-]{1,50}$/.test(f.id)&&!fids.has(f.id),'Duplicirana utakmica.');fids.add(f.id);integer(f.round_no,1,38,'kolo utakmice');assert(tids.has(f.home_id)&&tids.has(f.away_id)&&f.home_id!==f.away_id,'Nepoznat klub utakmice.');for(const tid of [f.home_id,f.away_id]){const k=f.round_no+':'+tid;assert(!occupied.has(k),'Klub ima dvije utakmice u istom kolu. Ne nagadjamo bodovanje.');occupied.add(k);}
 assert(f.kickoff===null||Number.isInteger(f.kickoff)&&f.kickoff>0,'Neispravan termin.');assert((f.home_score===null)===(f.away_score===null),'Nedostaje jedan rezultat.');if(f.home_score!==null){integer(f.home_score,0,99,'golovi');integer(f.away_score,0,99,'golovi');}
 assert(['SCHEDULED','TIMED','IN_PLAY','PAUSED','FINISHED','AWARDED','POSTPONED','CANCELLED','SUSPENDED'].includes(f.status),'Neispravan status utakmice.');assert(f.manual_score===0||f.manual_score===1,'Neispravna zastita rezultata.');if(f.api_id!==null){integer(f.api_id,1,999999999,'ID utakmice');assert(!matchApi.has(f.api_id),'Dupliciran API ID utakmice.');matchApi.add(f.api_id);}}
 const picks=new Set(),used=new Set(),doubles=new Set();for(const p of b.picks){assert(b.picks.length<=7600,'Previse odabira.');assert(ids.has(p.player_id)&&tids.has(p.team_id),'Odabir ima nepoznatog igraca/klub.');integer(p.round_no,1,38,'kolo odabira');integer(p.base,0,100,'osnovni bodovi odabira');assert(p.cycle===cycleFor(p.round_no),'Pogresan krug.');assert(p.is_double===0||p.is_double===1,'Neispravan DOUBLE.');assert(p.imported_points===null||Number.isFinite(p.imported_points)&&p.imported_points>=0&&p.imported_points<=202,'Neispravni povijesni bodovi.');
 const pk=p.player_id+':'+p.round_no,uk=p.player_id+':'+p.cycle+':'+p.team_id,dk=p.player_id+':'+p.cycle;assert(!picks.has(pk),'Vise odabira istog igraca u kolu.');assert(!used.has(uk),'Igrac je isti klub koristio dvaput u krugu. Ispravi izvor prije uvoza.');assert(!p.is_double||!doubles.has(dk),'Igrac ima dva DOUBLE u krugu.');picks.add(pk);used.add(uk);if(p.is_double)doubles.add(dk);}
 const pay=new Set();for(const p of b.payments){assert(ids.has(p.player_id),'Uplata ima nepoznatog igraca.');integer(p.cycle,1,4,'krug placanja');assert(p.paid===null||p.paid===0||p.paid===1,'Neispravno placanje.');const k=p.player_id+':'+p.cycle;assert(!pay.has(k),'Duplicirano placanje.');pay.add(k);}
 return {players:b.players.length,teams:b.teams.length,rounds:38,fixtures:b.fixtures.length,picks:b.picks.length,payments:b.payments.length};
}
export async function importDataset(env,u,b){
 const summary=validateDataset(b,u,env.SEASON||2026),db=env.DB;
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(b)));
 const fingerprint=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
 const flags=await db.prepare("SELECT value FROM meta WHERE key='dataset_imported'").first();assert(flags.value==='0','Uvoz je jednokratan. Za novu probu napravi novu instalaciju, ne prepisuj bazu.',409);
 const current=await db.prepare('SELECT (SELECT COUNT(*) FROM teams) AS teams,(SELECT COUNT(*) FROM picks) AS picks,(SELECT COUNT(*) FROM players) AS players,(SELECT COUNT(*) FROM payments) AS payments').first();
 assert(current.teams===0&&current.picks===0&&current.players===1&&current.payments===0,'Uvoz je dopusten samo u praznu novu bazu s jednim administratorom.',409);
 const sql=(s,...a)=>db.prepare(s).bind(...a);
 const arr=(table,cols,rows)=>sql(`INSERT INTO ${table}(${cols.join(',')}) SELECT ${cols.map(c=>`json_extract(value,'$.${c}')`).join(',')} FROM json_each(?)`,JSON.stringify(rows));
 const players=b.players.filter(p=>p.id!==u.id).map(p=>({...p,name_key:normalize(p.name)}));
 await db.batch([
  sql("INSERT INTO import_history(id,summary) SELECT 'initial',CASE WHEN (SELECT COUNT(*) FROM teams)=0 AND (SELECT COUNT(*) FROM picks)=0 AND (SELECT COUNT(*) FROM players)=1 AND (SELECT COUNT(*) FROM payments)=0 THEN ? ELSE NULL END",JSON.stringify(summary)),
  sql("UPDATE meta SET value='1' WHERE key='importing'"),
  arr('players',['id','name','name_key','password_hash','salt','iterations','active'],players),
  arr('teams',['id','name','name_key','base','color','api_id'],b.teams.map(t=>({...t,name_key:normalize(t.name)}))),
  sql("UPDATE rounds SET deadline=(SELECT json_extract(value,'$.deadline') FROM json_each(?) WHERE json_extract(value,'$.number')=rounds.number)",JSON.stringify(b.rounds)),
  arr('fixtures',['id','round_no','home_id','away_id','kickoff','home_score','away_score','status','api_id','manual_score'],b.fixtures),
  arr('picks',['player_id','round_no','cycle','team_id','is_double','base','imported_points'],b.picks),
  arr('payments',['player_id','cycle','paid'],b.payments),
  sql("UPDATE meta SET value='0' WHERE key IN('importing','picks_enabled')"),
  sql("UPDATE meta SET value='1' WHERE key='dataset_imported'"),
  sql("INSERT INTO meta(key,value) VALUES('import_fingerprint',?)",fingerprint),
  sql("INSERT INTO audit(actor_id,action,target) VALUES(?,'initial-import',?)",u.id,JSON.stringify(summary))
 ]);
 return {ok:true,summary,fingerprint};
}
