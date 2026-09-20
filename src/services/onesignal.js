import {AppError,assert} from '../rules.js';
import {all} from '../db.js';

export const pushConfigured=env=>!!(env.ONESIGNAL_APP_ID&&env.ONESIGNAL_API_KEY);

export async function pushSend(env,playerIds,title,message,eventKey){
 const ids=[...new Set((playerIds||[]).filter(Boolean).map(String))];
 if(!pushConfigured(env)||!ids.length)return {ok:true,skipped:true};
 const response=await fetch('https://api.onesignal.com/notifications?c=push',{
  method:'POST',
  headers:{'Authorization':'Key '+env.ONESIGNAL_API_KEY,'Content-Type':'application/json'},
  body:JSON.stringify({
   app_id:env.ONESIGNAL_APP_ID,
   target_channel:'push',
   include_aliases:{external_id:ids},
   headings:{en:title},
   contents:{en:message},
   name:String(eventKey||'kzm').slice(0,128),
   custom_data:{kzm_event:String(eventKey||'')}
  })
 });
 const text=await response.text();
 if(!response.ok)throw new Error('OneSignal HTTP '+response.status+': '+text.slice(0,220));
 let data={};try{data=text?JSON.parse(text):{};}catch{}
 if(!data?.id)throw new AppError(409,'OneSignal nije kreirao poruku. Ciljani igrac nema aktivnu push pretplatu povezanu s KZM racunom.');
 return {ok:true,response:data};
}

async function oneSignalUserStatus(env,player){
 const url=`https://api.onesignal.com/apps/${encodeURIComponent(env.ONESIGNAL_APP_ID)}/users/by/external_id/${encodeURIComponent(player.id)}`;
 let response;
 try{response=await fetch(url,{headers:{'Authorization':'Key '+env.ONESIGNAL_API_KEY,'Accept':'application/json'}});}
 catch{return {playerId:player.id,name:player.name,found:false,error:'OneSignal veza nije odgovorila.'};}
 if(response.status===404)return {playerId:player.id,name:player.name,found:false,enabledPush:0,totalPush:0,types:[]};
 const text=await response.text();
 if(!response.ok)return {playerId:player.id,name:player.name,found:false,error:`OneSignal HTTP ${response.status}: ${text.slice(0,160)}`};
 let data={};try{data=text?JSON.parse(text):{};}catch{return {playerId:player.id,name:player.name,found:false,error:'OneSignal nije vratio ispravan JSON.'};}
 const subscriptions=Array.isArray(data.subscriptions)?data.subscriptions:[];
 const push=subscriptions.filter(x=>/push/i.test(String(x?.type||'')));
 const enabled=push.filter(x=>x?.enabled===true);
 return {
  playerId:player.id,
  name:player.name,
  found:true,
  oneSignalId:data.identity?.onesignal_id||null,
  enabledPush:enabled.length,
  totalPush:push.length,
  types:[...new Set(push.map(x=>String(x?.type||'Push')).filter(Boolean))]
 };
}

export async function pushDiagnostics(env){
 assert(pushConfigured(env),'Push nije konfiguriran na ovom Workeru.',503);
 const players=await all(env,'SELECT id,name FROM players WHERE active=1 ORDER BY name'),rows=[];
 for(const player of players)rows.push(await oneSignalUserStatus(env,player));
 return {ok:true,rows,activePlayers:players.length,withEnabledPush:rows.filter(x=>Number(x.enabledPush)>0).length};
}
