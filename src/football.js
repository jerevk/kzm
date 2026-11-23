import {assert,normalize} from './rules.js';

const aliases={
 'man united':'manchester utd','manchester united':'manchester utd','man utd':'manchester utd',
 'man city':'manchester city','brighton hove':'brighton','brighton and hove albion':'brighton',
 'leeds united':'leeds','newcastle united':'newcastle','tottenham hotspur':'tottenham',
 'afc bournemouth':'bournemouth','coventry city':'coventry','ipswich town':'ipswich','hull city':'hull',
 'wolverhampton wanderers':'wolves','wolverhampton':'wolves','nottingham forest':'nottm forest',
 'west ham united':'west ham','sunderland afc':'sunderland'
};
const LIVE_WINDOW_SECONDS=3*60*60; // Includes stoppage and extra time, plus a brief final-result check.
const SCHEDULE_REFRESH_SECONDS=7*24*60*60;
const weeklyScheduleWindow=timestamp=>{const d=new Date(timestamp*1000);return d.getUTCDay()===0&&d.getUTCHours()===6;};
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
 if(t.completed===true||state==='post'||name.includes('FULL_TIME')||name.includes('FINAL'))return 'FINISHED';
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
  const clockRaw=String(event?.status?.displayClock||c?.status?.displayClock||event?.status?.type?.shortDetail||'').trim();
  const clockMatch=clockRaw.match(/^(\d{1,3})(?::\d{2})?['’]?$/);
  const minute=clockMatch&&Number(clockMatch[1])<=130?Number(clockMatch[1]):null;
  out.push({fixture_id:f.id,source:'ESPN',home_name:f.home_name,away_name:f.away_name,home_score:Number.isFinite(hs)?hs:null,away_score:Number.isFinite(as)?as:null,status:espnStatus(c),live_minute:minute,observed_at:observedAt});
 }
 return out;
}


/**
 * Reads only the public, lightweight Premier League score rows on Rezultati Mobile.
 * Never includes cookies, player data, login details, or other league results.
 * This is an optional fallback; parsing/network failure never replaces valid ESPN data.
 */
export function parseRezultatiLive(html,active,observedAt){
 const page=String(html||'');
 const header=/<h4[^>]*>\s*ENGLESKA:\s*Premier League\b[\s\S]*?<\/h4>/i.exec(page);
 if(!header)return [];
 const from=header.index+header[0].length;
 const next=page.indexOf('<h4',from);
 const section=page.slice(from,next<0?from+20000:Math.min(next,from+20000));
 const fixtures=new Map(active.map(f=>[teamKey(f.home_name)+'|'+teamKey(f.away_name),f]));
 const clean=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
 const output=[];
 for(const raw of section.split(/<br\s*\/?>/i)){
  const m=/<span\b([^>]*)>([\s\S]*?)<\/span>\s*([^<]+?)\s*<a\b[^>]*class=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(raw);
  if(!m)continue;
  const names=clean(m[3]).split(/\s+-\s+/);
  if(names.length!==2)continue;
  const f=fixtures.get(teamKey(names[0])+'|'+teamKey(names[1]));
  if(!f)continue;
  const score=clean(m[5]).match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/);
  if(!score)continue;
  const css=m[4].split(/\s+/);
  const live=css.includes('live'),final=css.includes('fin');
  if(!live&&!final)continue;
  const clock=clean(m[2]);
  const minuteMatch=clock.match(/^(\d{1,3})(?:\+\d+)?['’]?$/);
  const minute=minuteMatch&&Number(minuteMatch[1])<=130?Number(minuteMatch[1]):null;
  const status=final?'FINISHED':/poluvrijeme/i.test(clock)?'PAUSED':'IN_PLAY';
  output.push({fixture_id:f.id,source:'Rezultati.com',home_name:f.home_name,away_name:f.away_name,home_score:Number(score[1]),away_score:Number(score[2]),status,live_minute:live?minute:null,observed_at:observedAt});
 }
 return output;
}

async function fetchRezultati(){
 const response=await fetch('https://m.rezultati.com/',{
  headers:{Accept:'text/html'},
  signal:AbortSignal.timeout(9000)
 });
 assert(response.ok,'Rezultati.com HTTP '+response.status);
 const html=await response.text();
 assert(html.length<450000,'Rezultati.com odgovor je prevelik.');
 return html;
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
 // This source provides scheduling and postponements only, never goal totals.
 const scheduleFixtures=fixtures.map(f=>({...f,home_score:null,away_score:null,status:['POSTPONED','CANCELLED'].includes(f.status)?f.status:'SCHEDULED'}));
 const now=Math.floor(Date.now()/1000);
 const batch=[
  s("UPDATE teams SET api_id=(SELECT json_extract(value,'$.api_id') FROM json_each(?) WHERE json_extract(value,'$.id')=teams.id) WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?))",JSON.stringify(bindings),JSON.stringify(bindings)),
  s(`INSERT INTO fixtures(id,round_no,home_id,away_id,kickoff,home_score,away_score,status,api_id)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.round_no'),json_extract(value,'$.home_id'),json_extract(value,'$.away_id'),json_extract(value,'$.kickoff'),json_extract(value,'$.home_score'),json_extract(value,'$.away_score'),json_extract(value,'$.status'),json_extract(value,'$.api_id') FROM json_each(?) WHERE true
 ON CONFLICT(round_no,home_id,away_id) DO UPDATE SET kickoff=excluded.kickoff,api_id=excluded.api_id,
 home_score=fixtures.home_score,
 away_score=fixtures.away_score,
 status=CASE WHEN fixtures.manual_score=1 THEN fixtures.status
             WHEN excluded.status IN('POSTPONED','CANCELLED') AND fixtures.status NOT IN('FINISHED','AWARDED') THEN excluded.status
             WHEN fixtures.status IN('POSTPONED','CANCELLED') AND excluded.status NOT IN('POSTPONED','CANCELLED') THEN 'SCHEDULED'
             ELSE fixtures.status END`,JSON.stringify(scheduleFixtures)),
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
  const minuteKey='live-minute:'+row.fixture_id;
  if(status==='IN_PLAY'&&Number.isInteger(row.live_minute)){
   ops.push(s("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",minuteKey,String(row.live_minute)));
  }else{
   ops.push(s('DELETE FROM meta WHERE key=?',minuteKey));
  }
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

  const lastScheduleRow=await s("SELECT value FROM meta WHERE key='last_schedule_sync'").first();
  const scheduleDue=manual||(weeklyScheduleWindow(now)&&(!lastScheduleRow||now-Number(lastScheduleRow.value)>=SCHEDULE_REFRESH_SECONDS-3600));
  if(scheduleDue){
   try{
    assert(env.FOOTBALL_DATA_API_KEY,'Football-data API ključ nije postavljen.');
    const backoff=await s("SELECT value FROM meta WHERE key='api_backoff'").first();
    assert(!backoff||Number(backoff.value)<=now,'Football-data API je privremeno ograničen.');
    if(manual){
     const last=await s("SELECT value FROM meta WHERE key='last_manual_sync'").first();
     assert(!last||now-Number(last.value)>=120,'Ručno osvježavanje moguće je svake dvije minute.');
    }
    const raw=await fetchJson(env,`https://api.football-data.org/v4/competitions/PL/matches?season=${Number(env.SEASON||2026)}`,s,now);
    const fixtures=await saveFootball(env,s,teams,raw.matches,{manual});
    const updates=[
     s("INSERT INTO meta(key,value) VALUES('last_schedule_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now)),
     s("INSERT INTO meta(key,value) VALUES('last_sync_source','football-data.org') ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
     s("INSERT INTO meta(key,value) VALUES('api_backoff','0') ON CONFLICT(key) DO UPDATE SET value='0'")
    ];
    if(manual)updates.push(s("INSERT INTO meta(key,value) VALUES('last_manual_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now)));
    await env.DB.batch(updates);
    if(manual)return {ok:true,mode:'manual-full',fixtures:fixtures.length,lastSync:now,source:'football-data.org'};
   }catch(e){
    if(manual)throw e;
    await s("INSERT INTO meta(key,value) VALUES('schedule_sync_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(e.message||e).slice(0,300)).run();
   }
  }
  const active=await activeFixtures(s,now);
  if(!active.length)return {ok:true,mode:'idle',skipped:true,fixtures:0,lastSync:null,notice:'Nema utakmica koje su trenutno u vremenu igranja; vanjski live izvori nisu pozvani.'};
  const lastLive=await s("SELECT value FROM meta WHERE key='last_live_poll'").first();
  if(lastLive&&now-Number(lastLive.value)<LIVE_MIN_INTERVAL_SECONDS)return {ok:true,mode:'throttled',skipped:true,fixtures:active.length,lastSync:Number(lastLive.value)};
  await s("INSERT INTO meta(key,value) VALUES('last_live_poll',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now)).run();

  await ensureSourceRace(env);
  // ESPN first; query Rezultati.com only for currently active fixtures ESPN cannot update.
  let espnRows=[],espnApplied=new Set(),rezultatiRows=[],rezultatiApplied=new Set(),espnError='';
  try{
   const observed=await fetchEspn(now);
   espnRows=espnRaceRows(observed,active,Math.floor(Date.now()/1000));
   await recordRaceRows(env,espnRows);
   espnApplied=await applyLiveRows(env,s,espnRows,'ESPN');
   await s("INSERT INTO meta(key,value) VALUES('source_race_espn_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",espnRows.length?'':'ESPN nije povezao aktivnu utakmicu.').run();
  }catch(e){
   espnError=String(e.message||e).slice(0,300);
   await s("INSERT INTO meta(key,value) VALUES('source_race_espn_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",espnError).run();
  }
  const remaining=active.filter(f=>!espnApplied.has(String(f.id)));
  let rezultatiError='';
  if(remaining.length){
   try{
    const html=await fetchRezultati();
    rezultatiRows=parseRezultatiLive(html,remaining,Math.floor(Date.now()/1000));
    await recordRaceRows(env,rezultatiRows);
    rezultatiApplied=await applyLiveRows(env,s,rezultatiRows,'Rezultati.com');
    if(!rezultatiRows.length)rezultatiError='Rezultati.com nije pronašao odgovarajuću utakmicu Premier League.';
   }catch(e){rezultatiError=String(e.message||e).slice(0,300);}
  }
  await s("INSERT INTO meta(key,value) VALUES('source_race_rezultati_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rezultatiError).run();
  const applied=new Set([...espnApplied,...rezultatiApplied]);
  const source=espnApplied.size&&rezultatiApplied.size?'ESPN+Rezultati.com':espnApplied.size?'ESPN':rezultatiApplied.size?'Rezultati.com':'none';
  if(applied.size)await env.DB.batch([
   s("INSERT INTO meta(key,value) VALUES('last_sync_mode','live-active') ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
   s("INSERT INTO meta(key,value) VALUES('last_sync_source',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",source)
  ]);
  if(!espnRows.length&&!rezultatiRows.length&&espnError&&rezultatiError)throw new Error('ESPN: '+espnError+'; Rezultati.com: '+rezultatiError);
  return {ok:true,mode:'live-active',fixtures:applied.size,activeFixtures:active.length,requestedIds:[],lastSync:applied.size?now:null,source,footballDataBackoff:false,notice:applied.size?'Rezultat uzivo osvjezen preko '+source+'.':'Nema novih rezultata iz ESPN-a ni Rezultati.com.'};
 }catch(e){
  await s("INSERT INTO meta(key,value) VALUES('last_sync_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(e.message||e).slice(0,500)).run();
  throw e;
 }finally{
  await s("UPDATE meta SET value='0' WHERE key='sync_lease'").run();
 }
}
