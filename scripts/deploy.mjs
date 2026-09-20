import {saveJSON,verifyConfig,wrangler,fail} from './common.mjs';
try{
 const {state,config}=verifyConfig();
 if(!state.completed)throw new Error('Prvo dovrsi npm run setup.');
 const wanted='* * * * *';
 const current=Array.isArray(config.triggers?.crons)?config.triggers.crons:[];
 if(current.length!==1||current[0]!==wanted){
  config.triggers={...(config.triggers||{}),crons:[wanted]};
  saveJSON('wrangler.json',config);
  console.log('Live refresh: Cloudflare cron je postavljen na svaku 1 minutu.');
 }
 console.log('Objavljujem samo NOVI projekt: '+state.name);
 await wrangler(['deploy','--config','wrangler.json']);
 console.log('Baza nije brisana. Adresa: '+state.url);
}catch(e){fail(e);}
