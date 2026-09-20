import {assert,normalize} from './rules.js';

const aliases={
 'man united':'manchester utd','manchester united':'manchester utd','man utd':'manchester utd',
 'man city':'manchester city','brighton hove':'brighton','brighton and hove albion':'brighton',
 'leeds united':'leeds','newcastle united':'newcastle','tottenham hotspur':'tottenham',
 'afc bournemouth':'bournemouth','coventry city':'coventry','ipswich town':'ipswich','hull city':'hull',
 'wolverhampton wanderers':'wolves','wolverhampton':'wolves','nottingham forest':'nottm forest',
 'west ham united':'west ham','sunderland afc':'sunderland'
};
const LIVE_WINDOW_SECONDS=4*60*60;
const LIVE_MIN_INTERVAL_SECONDS=20;
const TERMINAL_STATUSES=['FINISHED','AWARDED','POSTPONED','CANCELLED'];

function teamKey(s){
 const n=normalize(s).replace(/\b(fc|afc)\b/g,'').replace(/\s+/g,' ').trim();
 return aliases[n]||n;
}

export function mapMatches(matches,teams){
 const byApi=new Map(teams.filter(x=>x.api_id).map(x=>[x.api_id,x]));
 const byName=new Map(teams.map(x=>[teamKey(x.name),x]));
 const missing=new Set();
 const bindings=new Map();
 const get=t=>{
  let x=byApi.get(t?.id);
  if(!x)for(const s of [t?.shortName,t?.name]){x=byName.get(teamKey(s));if(x)break;}
  if(!x)missing.add(t?.shortName||t?.name||'Nepoznat klub');
  else if(t?.id)bindings.set(x.id,t.id);
  return x;
 };
 const fixtures=[],seen=new Set();
 for(const m of matches){
  const n=Number(m.matchday);
  if(!Number.isInteger(n)||n<1||n>38)continue;
  const h=get(m.homeTeam),a=get(m.awayTeam);
  if(!h||!a)continue;
  assert(h.id!==a.id,'API je pogresno povezao klubove.');
  for(const id of [h.id,a.id]){
   const k=n+':'+id;
   assert(!seen.has(k),'API ima dvostruko kolo; sinkronizacija je zaustavljena radi provjere pravila.');
   seen.add(k);
  }
  const ts=Date.parse(m.utcDate);
  assert(Number.isFinite(ts),'API je vratio neispravan datum.');
  const ft=m.score?.fullTime||{};
  const hs=ft.home==null?null:Number(ft.home),as=ft.away==null?null:Number(ft.away);
  assert((hs===null&&as===null)||(Number.isInteger(hs)&&Number.isInteger(as)&&hs>=0&&as>=0&&hs<=99&&as<=99),'API rezultat nije ispravan.');
  assert(Number.isInteger(m.id)&&m.id>0,'Nedostaje ID utakmice.');
  fixtures.push({
   id:'api-'+m.id,round_no:n,home_id:h.id,away_id:a.id,kickoff:Math.floor(ts/1000),
   home_score:hs,away_score:as,status:m.status||'SCHEDULED',api_id:m.id
  });
 }
 assert(missing.size===0,'Nepovezani klubovi: '+[...missing].join(', ')+'. U administraciji klubova upisi tocan API ID.');
 return {fixtures,bindings:[...bindings].map(([id,api_id])=>({id,api_id}))};
}

export function shouldPollFixture(f,now=Math.floor(Date.now()/1000)){
 const kickoff=Number(f?.kickoff||0);
 if(Number(f?.manual_score)===1||!kickoff)return false;
 return kickoff<=now&&kickoff>=now-LIVE_WINDOW_SECONDS;
}

async function fetchJson(env,url,s,now){
 const response=await fetch(url,{headers:{'X-Auth-Token':env.FOOTBALL_DATA_API_KEY},signal:AbortSignal.timeout(20000)});
 if(response.status===429){
  const retry=Math.max(300,Number(response.headers.get('Retry-After')||3600));
  await s("INSERT INTO meta(key,value) VALUES('api_backoff',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now+retry)).run();
  throw new Error(`API ogranicenje 429: novi pokusaj za oko ${Math.ceil(retry/60)} min.`);
 }
 assert(response.ok,`Nogometni API odgovorio je HTTP ${response.status}.`);
 return response.json();
}

async function fetchEspn(now){
 const date=new Date(now*1000).toISOString().slice(0,10).replace(/-/g,'');
 const response=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${date}`,{
  headers:{
   'Accept':'application/json, text/plain, */*',
   'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
   'Referer':'https://www.espn.com/',
   'Origin':'https://www.espn.com'
  },
  signal:AbortSignal.timeout(12000)
 });
 assert(response.ok,`ESPN odgovorio je HTTP ${response.status}.`);
 return response.json();
}


export async function testEspnSource(now=Math.floor(Date.now()/1000)){
 const raw=await fetchEspn(now);
 const events=Array.isArray(raw?.events)?raw.events:[];
 return {ok:true,source:'ESPN',events:events.length,checkedAt:Math.floor(Date.now()/1000)};
}

function espnStatus(c){
 const t=c?.status?.type||{},name=String(t.name||'').toUpperCase(),state=String(t.state||'').toLowerCase();
 if(t.completed===true||name.includes('FULL_TIME')||name.includes('FINAL'))return 'FINISHED';
 if(name.includes('POSTPON'))return 'POSTPONED';
 if(name.includes('CANCEL'))return 'CANCELLED';
 if(name.includes('SUSPEND'))return 'SUSPENDED';
 if(name.includes('HALF')||name.includes('BREAK')||name.includes('PAUSE'))return 'PAUSED';
 if(state==='in'||name.includes('IN_PROGRESS'))return 'IN_PLAY';
 return 'SCHEDULED';
}

async function ensureSourceRace(env){
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS source_race(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id TEXT NOT NULL,
  source TEXT NOT NULL,
  home_name TEXT NOT NULL,
  away_name TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL,
  observed_at INTEGER NOT NULL
 )`).run();
 await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_source_race_fixture_source_time ON source_race(fixture_id,source,observed_at DESC)').run();
}

async function recordRaceSnapshot(env,x){
 if(!x?.fixture_id||!x?.source)return false;
 const prev=await env.DB.prepare(`SELECT home_score,away_score,status FROM source_race
  WHERE fixture_id=? AND source=? ORDER BY observed_at DESC,id DESC LIMIT 1`).bind(x.fixture_id,x.source).first();
 const hs=x.home_score==null?null:Number(x.home_score),as=x.away_score==null?null:Number(x.away_score),status=String(x.status||'UNKNOWN');
 if(prev&&Number(prev.home_score)===Number(hs)&&Number(prev.away_score)===Number(as)&&String(prev.status)===status)return false;
 await env.DB.prepare(`INSERT INTO source_race(fixture_id,source,home_name,away_name,home_score,away_score,status,observed_at)
  VALUES(?,?,?,?,?,?,?,?)`).bind(x.fixture_id,x.source,x.home_name,x.away_name,hs,as,status,Number(x.observed_at)).run();
 return true;
}

function footballRaceRows(raw,active,observedAt){
 const byApi=new Map(active.map(f=>[Number(f.api_id),f])),out=[];
 for(const m of raw?.matches||[]){
  const f=byApi.get(Number(m.id));if(!f)continue;
  const ft=m.score?.fullTime||{};
  out.push({fixture_id:f.id,source:'football-data.org',home_name:f.home_name,away_name:f.away_name,home_score:ft.home==null?null:Number(ft.home),away_score:ft.away==null?null:Number(ft.away),status:String(m.status||'UNKNOWN'),observed_at:observedAt});
 }
 return out;
}

function espnRaceRows(raw,active,observedAt){
 const byNames=new Map(active.map(f=>[teamKey(f.home_name)+'|'+teamKey(f.away_name),f])),out=[];
 for(const event of raw?.events||[]){
  const c=event?.competitions?.[0];if(!c)continue;
  const home=(c.competitors||[]).find(x=>x.homeAway==='home'),away=(c.competitors||[]).find(x=>x.homeAway==='away');
  if(!home||!away)continue;
  const hname=home.team?.displayName||home.team?.name||home.team?.shortDisplayName||'';
  const aname=away.team?.displayName||away.team?.name||away.team?.shortDisplayName||'';
  const f=byNames.get(teamKey(hname)+'|'+teamKey(aname));if(!f)continue;
  const hs=home.score==null||home.score===''?null:Number(home.score),as=away.score==null||away.score===''?null:Number(away.score);
  out.push({fixture_id:f.id,source:'ESPN',home_name:f.home_name,away_name:f.away_name,home_score:Number.isFinite(hs)?hs:null,away_score:Number.isFinite(as)?as:null,status:espnStatus(c),observed_at:observedAt});
 }
 return out;
}

async function recordRaceRows(env,rows){
 let inserted=0;for(const row of rows)if(await recordRaceSnapshot(env,row))inserted++;return inserted;
}

export async function sourceRaceData(env){
 await ensureSourceRace(env);
 const now=Math.floor(Date.now()/1000);
 const rows=(await env.DB.prepare('SELECT * FROM source_race ORDER BY observed_at DESC,id DESC LIMIT 250').all()).results;
 const active=(await env.DB.prepare(`SELECT COUNT(*) AS n FROM fixtures WHERE manual_score=0 AND kickoff IS NOT NULL AND kickoff<=? AND kickoff>=? AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key='live-terminal:'||fixtures.id)`).bind(now,now-LIVE_WINDOW_SECONDS).first())?.n||0;
 const errs=await env.DB.batch([
  env.DB.prepare("SELECT value FROM meta WHERE key='source_race_espn_error'"),
  env.DB.prepare("SELECT value FROM meta WHERE key='source_race_football_error'")
 ]);
 return {rows,active:Number(active),espnError:errs[0].results?.[0]?.value||'',footballError:errs[1].results?.[0]?.value||''};
}

async function saveFootball(env,s,teams,matches,{manual=false}={}){
 assert(Array.isArray(matches)&&matches.length>0,'API nije vratio utakmice.');
 const {fixtures,bindings}=mapMatches(matches,teams);
 assert(fixtures.length>0&&fixtures.length<=380,'Neispravan broj utakmica.');
 const now=Math.floor(Date.now()/1000);
 const batch=[
  s("UPDATE teams SET api_id=(SELECT json_extract(value,'$.api_id') FROM json_each(?) WHERE json_extract(value,'$.id')=teams.id) WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?))",JSON.stringify(bindings),JSON.stringify(bindings)),
  s(`INSERT INTO fixtures(id,round_no,home_id,away_id,kickoff,home_score,away_score,status,api_id)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.round_no'),json_extract(value,'$.home_id'),json_extract(value,'$.away_id'),json_extract(value,'$.kickoff'),json_extract(value,'$.home_score'),json_extract(value,'$.away_score'),json_extract(value,'$.status'),json_extract(value,'$.api_id') FROM json_each(?) WHERE true
 ON CONFLICT(round_no,home_id,away_id) DO UPDATE SET kickoff=excluded.kickoff,api_id=excluded.api_id,
 home_score=CASE WHEN fixtures.manual_score=1 THEN fixtures.home_score ELSE excluded.home_score END,
 away_score=CASE WHEN fixtures.manual_score=1 THEN fixtures.away_score ELSE excluded.away_score END,
 status=CASE WHEN fixtures.manual_score=1 THEN fixtures.status ELSE excluded.status END`,JSON.stringify(fixtures)),
  s(`UPDATE rounds SET deadline=(SELECT MIN(kickoff)-7200 FROM fixtures WHERE round_no=rounds.number AND status NOT IN('CANCELLED','POSTPONED')) WHERE manual_deadline=0 AND(deadline IS NULL OR deadline>unixepoch()) AND EXISTS(SELECT 1 FROM fixtures WHERE round_no=rounds.number AND kickoff IS NOT NULL AND status NOT IN('CANCELLED','POSTPONED'))`),
  s("INSERT INTO meta(key,value) VALUES('last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now)),
  s("INSERT INTO meta(key,value) VALUES('last_sync_error','') ON CONFLICT(key) DO UPDATE SET value=''"),
  s("INSERT INTO meta(key,value) VALUES('last_sync_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",manual?'manual-full':'live-active')
 ];
 if(manual)batch.push(s("INSERT INTO audit(action,target) VALUES('football-sync',?)",String(fixtures.length)));
 await env.DB.batch(batch);
 return fixtures;
}

async function activeFixtures(s,now){
 const rows=(await s(`SELECT f.id,f.api_id,f.kickoff,f.status,f.manual_score,f.home_score,f.away_score,h.name AS home_name,a.name AS away_name
  FROM fixtures f JOIN teams h ON h.id=f.home_id JOIN teams a ON a.id=f.away_id
  WHERE f.manual_score=0 AND f.kickoff IS NOT NULL
    AND f.kickoff<=? AND f.kickoff>=?
    AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key='live-terminal:'||f.id)
  ORDER BY f.kickoff,f.api_id`,now,now-LIVE_WINDOW_SECONDS).all()).results;
 return rows.filter(f=>shouldPollFixture(f,now));
}

function usefulLiveRow(row){
 if(!row?.fixture_id)return false;
 const status=String(row.status||'SCHEDULED').toUpperCase();
 return status!=='SCHEDULED';
}

async function applyLiveRows(env,s,rows,source){
 const useful=rows.filter(usefulLiveRow),ops=[];
 for(const row of useful){
  const hs=row.home_score==null?null:Number(row.home_score),as=row.away_score==null?null:Number(row.away_score),status=String(row.status||'IN_PLAY').toUpperCase();
  ops.push(s(`UPDATE fixtures SET
   home_score=CASE WHEN ? IS NULL OR ? IS NULL THEN home_score ELSE ? END,
   away_score=CASE WHEN ? IS NULL OR ? IS NULL THEN away_score ELSE ? END,
   status=CASE
    WHEN status IN('FINISHED','AWARDED') AND ? NOT IN('FINISHED','AWARDED') THEN status
    WHEN ?='SCHEDULED' AND status IN('IN_PLAY','PAUSED','SUSPENDED') THEN status
    ELSE ? END
   WHERE id=? AND manual_score=0`,hs,as,hs,hs,as,as,status,status,status,row.fixture_id));
  const terminal=TERMINAL_STATUSES.includes(status)&&(!(status==='FINISHED'||status==='AWARDED')||(hs!==null&&as!==null));
  const key='live-terminal:'+row.fixture_id;
  if(terminal)ops.push(s('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(row.observed_at||Math.floor(Date.now()/1000))));
  else ops.push(s('DELETE FROM meta WHERE key=?',key));
 }
 if(ops.length)await env.DB.batch(ops);
 if(useful.length)await env.DB.batch([
  s("INSERT INTO meta(key,value) VALUES('last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(Math.floor(Date.now()/1000))),
  s("INSERT INTO meta(key,value) VALUES('last_sync_source',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",source),
  s("INSERT INTO meta(key,value) VALUES('last_sync_error','') ON CONFLICT(key) DO UPDATE SET value=''")
 ]);
 return new Set(useful.map(x=>String(x.fixture_id)));
}

export async function syncFootball(env,manual=false){
 const db=env.DB,now=Math.floor(Date.now()/1000),s=(sql,...a)=>db.prepare(sql).bind(...a);
 await s("INSERT OR IGNORE INTO meta(key,value) VALUES('sync_lease','0')").run();
 const lease=await s("UPDATE meta SET value=? WHERE key='sync_lease' AND CAST(value AS INTEGER)<? RETURNING value",String(now+90),now).first();
 assert(lease,'Sinkronizacija vec traje.');
 try{
  const teams=(await s('SELECT * FROM teams').all()).results;
  assert(teams.length===20,'Prvo uvezi 20 klubova i njihove stvarne osnovne bodove.');

  if(manual){
   assert(env.FOOTBALL_DATA_API_KEY,'API kljuc nije postavljen. Koristi npm run football-key.');
   const backoff=await s("SELECT value FROM meta WHERE key='api_backoff'").first();
   assert(!backoff||Number(backoff.value)<=now,'Football-data odgoda je aktivna. Pokusaj kasnije.');
   const last=await s("SELECT value FROM meta WHERE key='last_manual_sync'").first();
   assert(!last||now-Number(last.value)>=120,'Rucno osvjezavanje dostupno je svake dvije minute.');
   const raw=await fetchJson(env,`https://api.football-data.org/v4/competitions/PL/matches?season=${Number(env.SEASON||2026)}`,s,now);
   const fixtures=await saveFootball(env,s,teams,raw.matches,{manual:true});
   await env.DB.batch([
    s("INSERT INTO meta(key,value) VALUES('last_manual_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now)),
    s("INSERT INTO meta(key,value) VALUES('last_sync_source','football-data.org') ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
    s("INSERT INTO meta(key,value) VALUES('api_backoff','0') ON CONFLICT(key) DO UPDATE SET value='0'")
   ]);
   return {ok:true,mode:'manual-full',fixtures:fixtures.length,lastSync:now,source:'football-data.org',notice:'Puni raspored je osvjezen. Povijesni bodovi i rucno zasticeni rezultati ostali su sacuvani.'};
  }

  const active=await activeFixtures(s,now);
  if(!active.length)return {ok:true,mode:'idle',skipped:true,fixtures:0,lastSync:null,notice:'Nema utakmica koje su trenutno u vremenu igranja; vanjski live izvori nisu pozvani.'};
  const lastLive=await s("SELECT value FROM meta WHERE key='last_live_poll'").first();
  if(lastLive&&now-Number(lastLive.value)<LIVE_MIN_INTERVAL_SECONDS)return {ok:true,mode:'throttled',skipped:true,fixtures:active.length,lastSync:Number(lastLive.value)};
  await s("INSERT INTO meta(key,value) VALUES('last_live_poll',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now)).run();

  await ensureSourceRace(env);
  const ids=active.filter(f=>Number(f.api_id)>0).map(f=>Number(f.api_id));
  const backoff=await s("SELECT value FROM meta WHERE key='api_backoff'").first(),backoffUntil=Number(backoff?.value||0);
  const fdAllowed=!!env.FOOTBALL_DATA_API_KEY&&ids.length>0&&backoffUntil<=now;
  const espnPromise=fetchEspn(now).then(data=>({data,observedAt:Math.floor(Date.now()/1000)}));
  const fdPromise=fdAllowed?fetchJson(env,'https://api.football-data.org/v4/matches?ids='+encodeURIComponent(ids.join(','))+'&limit=20',s,now).then(data=>({data,observedAt:Math.floor(Date.now()/1000)})):Promise.resolve(null);
  const [espnResult,fdResult]=await Promise.allSettled([espnPromise,fdPromise]);

  let espnRows=[],fdRows=[],espnApplied=new Set(),fdApplied=new Set();
  if(espnResult.status==='fulfilled'){
   espnRows=espnRaceRows(espnResult.value.data,active,espnResult.value.observedAt);
   await recordRaceRows(env,espnRows);
   if(espnRows.length){
    espnApplied=await applyLiveRows(env,s,espnRows,'ESPN');
    await s("INSERT INTO meta(key,value) VALUES('source_race_espn_error','') ON CONFLICT(key) DO UPDATE SET value='' ").run();
   }else{
    await s("INSERT INTO meta(key,value) VALUES('source_race_espn_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",'ESPN nije povezao nijednu trenutno aktivnu KZM utakmicu.').run();
   }
  }else{
   await s("INSERT INTO meta(key,value) VALUES('source_race_espn_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(espnResult.reason?.message||espnResult.reason||'ESPN greska').slice(0,300)).run();
  }

  if(fdResult.status==='fulfilled'&&fdResult.value){
   fdRows=footballRaceRows(fdResult.value.data,active,fdResult.value.observedAt);
   await recordRaceRows(env,fdRows);
   const fallbackRows=fdRows.filter(row=>!espnApplied.has(String(row.fixture_id)));
   fdApplied=await applyLiveRows(env,s,fallbackRows,'football-data.org');
   await env.DB.batch([
    s("INSERT INTO meta(key,value) VALUES('source_race_football_error','') ON CONFLICT(key) DO UPDATE SET value=''"),
    s("INSERT INTO meta(key,value) VALUES('api_backoff','0') ON CONFLICT(key) DO UPDATE SET value='0'")
   ]);
  }else if(fdResult.status==='rejected'){
   await s("INSERT INTO meta(key,value) VALUES('source_race_football_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(fdResult.reason?.message||fdResult.reason||'Football-data greska').slice(0,300)).run();
  }else if(!env.FOOTBALL_DATA_API_KEY){
   await s("INSERT INTO meta(key,value) VALUES('source_race_football_error','Football-data API kljuc nije postavljen; ESPN live fallback je i dalje aktivan.') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  }else if(backoffUntil>now){
   await s("INSERT INTO meta(key,value) VALUES('source_race_football_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",`Football-data je u odgodi jos oko ${Math.ceil((backoffUntil-now)/60)} min.; ESPN se i dalje provjerava.`).run();
  }else if(!ids.length){
   await s("INSERT INTO meta(key,value) VALUES('source_race_football_error','Aktivne utakmice nemaju football-data API ID; ESPN se i dalje provjerava.') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  }

  const applied=new Set([...espnApplied,...fdApplied]);
  const source=espnApplied.size&&fdApplied.size?'ESPN+football-data.org':espnApplied.size?'ESPN':fdApplied.size?'football-data.org':'none';
  if(applied.size){
   await env.DB.batch([
    s("INSERT INTO meta(key,value) VALUES('last_sync_mode','live-active') ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
    s("INSERT INTO meta(key,value) VALUES('last_sync_source',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",source)
   ]);
  }else if(espnResult.status==='rejected'&&fdResult.status==='rejected'){
   throw new Error('Nijedan live izvor nije dostupan: '+String(espnResult.reason?.message||'ESPN greska')+'; '+String(fdResult.reason?.message||'football-data greska'));
  }
  return {ok:true,mode:'live-active',fixtures:applied.size,activeFixtures:active.length,requestedIds:ids,lastSync:applied.size?now:null,source,footballDataBackoff:backoffUntil>now,notice:applied.size?`Live rezultat osvjezen preko ${source}. ESPN ima prednost za live rezultat; football-data.org ostaje fallback i izvor punog rasporeda.`:'Live izvori su provjereni, ali nisu vratili novu aktivnu promjenu.'};
 }catch(e){
  await s("INSERT INTO meta(key,value) VALUES('last_sync_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(e.message||e).slice(0,500)).run();
  throw e;
 }finally{
  await s("UPDATE meta SET value='0' WHERE key='sync_lease'").run();
 }
}
