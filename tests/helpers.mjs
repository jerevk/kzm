import worker from '../src/worker.js';import {LocalD1} from './db.mjs';
export const ADMIN_PASSWORD='Demo-only-Admin-2026!';
export const USER_PASSWORD='Demo-only-Player-2026!';
export async function fresh(empty=false){
 const env={DB:new LocalD1(),PROJECT_ID:'local-test',SEASON:'2026',AUTH_PEPPER:'p'.repeat(64),BOOTSTRAP_KEY:'b'.repeat(64),ASSETS:{fetch:async()=>new Response('asset')}};
 async function call(path,{body,cookie,origin='https://kzm.test',custom=true}={}){const headers={};if(cookie)headers.Cookie=cookie;const opts={headers};if(body!==undefined){opts.method='POST';headers['Content-Type']='application/json';headers.Origin=origin;if(custom)headers['X-KZM-Request']='1';opts.body=JSON.stringify(body);}const r=await worker.fetch(new Request('https://kzm.test/api'+path,opts),env);const raw=await r.text();return {status:r.status,data:JSON.parse(raw),cookie:r.headers.get('Set-Cookie')?.split(';')[0]};}
 let r=await call('/setup',{body:{key:env.BOOTSTRAP_KEY,name:'Demo Admin',password:ADMIN_PASSWORD}});if(r.status!==201)throw new Error(JSON.stringify(r));
 r=await call('/login',{body:{name:'Demo Admin',password:ADMIN_PASSWORD}});const adminCookie=r.cookie;
 let userId,userCookie;
 if(!empty){r=await call('/admin/players',{cookie:adminCookie,body:{name:'Demo Player',password:USER_PASSWORD}});userId=r.data.player.id;r=await call('/login',{body:{name:'Demo Player',password:USER_PASSWORD}});userCookie=r.cookie;
 env.DB.sqlite.exec("UPDATE meta SET value='1' WHERE key='picks_enabled';UPDATE rounds SET deadline=unixepoch()+3600;");
 const q=env.DB.sqlite.prepare('INSERT INTO teams(id,name,name_key,base,color) VALUES(?,?,?,?,?)');for(let i=1;i<=20;i++)q.run('t'+i,'Klub '+i,'klub '+i,i%5+1,'#37003c');
 env.DB.sqlite.exec("INSERT INTO fixtures(id,round_no,home_id,away_id,kickoff) VALUES('f1',1,'t1','t2',unixepoch()+7200);");
 }
 return {env,call,adminCookie,userId,userCookie};
}
export function rawSnapshot(){const deadline=new Date(Date.now()+3600000).toISOString();return {format:'kzm-export-v1',season:2026,players:[{name:'Demo Admin',active:true,payments:{1:true}},{name:'Demo Player',active:true,payments:{1:false,2:true,3:null,4:false}}],teams:Array.from({length:20},(_,i)=>({name:'Klub '+(i+1),base:i%5+1,color:'#37003c',apiId:i+1})),rounds:Array.from({length:38},(_,i)=>({number:i+1,deadline,fixtures:i===0?[{home:'Klub 1',away:'Klub 2',kickoff:deadline,homeScore:2,awayScore:1,status:'FINISHED',apiId:99,manualScore:false}]:[],picks:i===0?[{player:'Demo Player',team:'Klub 1',double:true,points:4,base:2}]:[]}))};}
