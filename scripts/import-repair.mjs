import fs from 'node:fs';
import path from 'node:path';
import {verifyConfig,wrangler,ask,root} from './common.mjs';

function stamp(){ return new Date().toISOString().replace(/[:.]/g,'-'); }
function extractRows(text){
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
  while (stack.length) {
    const x = stack.shift();
    if (!x || typeof x !== 'object') continue;
    if (Array.isArray(x.results)) return x.results;
    for (const v of Object.values(x)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return [];
}

async function query(dbName, sql){
  const out = await wrangler(['d1','execute',dbName,'--remote','--config','wrangler.json','--command',sql,'--json'],{capture:true,quiet:true});
  const rows = extractRows(out);
  if (!rows.length) throw new Error('Wrangler nije vratio ocekuvani JSON rezultat za provjeru baze.');
  return rows;
}

async function exec(dbName, sql){
  await wrangler(['d1','execute',dbName,'--remote','--config','wrangler.json','--command',sql,'--yes']);
}

async function main(){
  const {state,config}=verifyConfig();
  if (!state.completed) throw new Error('Prvo dovrsi setup.');
  const dbName=config.d1_databases[0].database_name;
  const statusSql = `SELECT
    (SELECT COUNT(*) FROM players) AS players,
    (SELECT COUNT(*) FROM players WHERE id='owner' AND is_admin=1) AS owner_admin,
    (SELECT COUNT(*) FROM teams) AS teams,
    (SELECT COUNT(*) FROM fixtures) AS fixtures,
    (SELECT COUNT(*) FROM picks) AS picks,
    (SELECT COUNT(*) FROM payments) AS payments,
    (SELECT COUNT(*) FROM import_history) AS import_history,
    COALESCE((SELECT value FROM meta WHERE key='dataset_imported'),'0') AS dataset_imported,
    COALESCE((SELECT value FROM meta WHERE key='importing'),'0') AS importing,
    COALESCE((SELECT value FROM meta WHERE key='picks_enabled'),'0') AS picks_enabled;`;

  console.log('\nProvjeravam ISKLJUCIVO novu D1 bazu: '+dbName+'\n');
  const before=(await query(dbName,statusSql))[0];
  console.table(before);

  const imported=String(before.dataset_imported)==='1' || Number(before.import_history)>0;
  if (imported) {
    console.log('\nBaza izgleda kao vec potvrden uvoz. NE CISTIM nista. Pokreni: npm run import -- --recover');
    return;
  }

  const expectedEmpty = Number(before.players)===1 && Number(before.owner_admin)===1 && Number(before.teams)===0 && Number(before.fixtures)===0 && Number(before.picks)===0 && Number(before.payments)===0;
  if (expectedEmpty) {
    console.log('\nBaza je vec u ispravnom praznom stanju (samo administrator). Nema sto cistiti.');
    console.log('Ako import i dalje javlja da baza nije prazna, posalji ovaj ispis.');
    return;
  }

  if (Number(before.owner_admin)!==1) throw new Error('Ne ocekujem ovu strukturu: nema tocno jednog owner administratora. Ne diram bazu.');

  console.log('\nPronadeni su nepotvrdeni/zaostali podaci u NOVOJ probnoj bazi.');
  console.log('Originalni KZM i Google Sheet se NE diraju.');
  console.log('Prije ciscenja automatski cu spremiti SQL backup nove D1 baze.');
  const confirm=await ask('Za vracanje NOVE baze na stanje samo s administratorom upisi OCISTI NOVU BAZU: ');
  if (confirm!=='OCISTI NOVU BAZU') { console.log('Prekinuto bez promjena.'); return; }

  const backupRel=`private/backups/pre-import-repair-${stamp()}.sql`;
  fs.mkdirSync(path.join(root,'private','backups'),{recursive:true});
  console.log('\nSpremam backup: '+backupRel);
  await wrangler(['d1','export',dbName,'--remote','--config','wrangler.json','--output',backupRel,'--skip-confirmation']);

  const cleanup = [
    `DELETE FROM sessions WHERE player_id<>'owner'`,
    `DELETE FROM picks`,
    `DELETE FROM payments`,
    `DELETE FROM fixtures`,
    `DELETE FROM teams`,
    `DELETE FROM players WHERE id<>'owner'`,
    `DELETE FROM import_history`,
    `UPDATE rounds SET deadline=NULL, manual_deadline=0`,
    `DELETE FROM meta WHERE key='import_fingerprint'`,
    `UPDATE meta SET value='0' WHERE key IN('dataset_imported','importing','picks_enabled')`
  ];
  console.log('\nCistim samo nepotvrdene podatke nove baze...');
  for (const sql of cleanup) await exec(dbName,sql);

  const after=(await query(dbName,statusSql))[0];
  console.log('\nStanje nakon ciscenja:');
  console.table(after);
  const ok = Number(after.players)===1 && Number(after.owner_admin)===1 && Number(after.teams)===0 && Number(after.fixtures)===0 && Number(after.picks)===0 && Number(after.payments)===0 && Number(after.import_history)===0 && String(after.dataset_imported)==='0';
  if (!ok) throw new Error('Nova baza nije vracena u ocekuvano stanje. Backup je sacuvan; ne pokreci import.');

  const pendingPath=path.join(root,'private','import-pending.json');
  if (fs.existsSync(pendingPath)) {
    let p=null; try{p=JSON.parse(fs.readFileSync(pendingPath,'utf8'));}catch{}
    const disc=path.join(root,'private','discarded-'+stamp()); fs.mkdirSync(disc,{recursive:true});
    fs.renameSync(pendingPath,path.join(disc,'import-pending.json'));
    if (p?.pending) {
      const f=path.join(root,'private',p.pending);
      if (fs.existsSync(f)) fs.renameSync(f,path.join(disc,'NE-KORISTI-'+path.basename(f)));
    }
    console.log('Stari nepotvrdeni pristupni kodovi premjesteni su u privatnu discarded mapu i NE SMIJU se koristiti.');
  }

  console.log('\nPOPRAVAK GOTOV.');
  console.log('Sada ponovno pokreni import sa ispravljenim kzm-izvoz.json. Novi pristupni kodovi bit ce generirani.');
  console.log('Originalni KZM nije mijenjan.');
}

main().catch(e=>{console.error('\nZAUSTAVLJENO: '+e.message+'\nOriginalni KZM nije mijenjan.');process.exitCode=1;});
