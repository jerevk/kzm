import {verifyConfig,wrangler,fail} from './common.mjs';
try{const {state}=verifyConfig();console.log('Kljuc dodajes samo u '+state.name+'. Ne salji ga u chat.');await wrangler(['secret','put','FOOTBALL_DATA_API_KEY','--config','wrangler.json']);console.log('Sada u NOVOJ aplikaciji: Admin postavke -> OSVJEZI NOGOMETNI API.');}catch(e){fail(e);}
