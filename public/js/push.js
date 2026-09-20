const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function withTimeout(promise,ms,message){
 let timer;
 try{
  return await Promise.race([
   Promise.resolve(promise),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})
  ]);
 }finally{clearTimeout(timer);}
}

export function createPushManager({api,getPlayerId,getButton,toast}){
 let config=null;
 let initPromise=null;
 let oneSignal=null;

 async function ready(){
  if(oneSignal)return oneSignal;
  if(initPromise)return initPromise;
  initPromise=(async()=>{
   const cfg=await api('/push/config');
   config=cfg;
   if(!cfg.configured)return null;
   return await new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(fn,value)=>{if(finished)return;finished=true;clearTimeout(timer);fn(value);};
    const timer=setTimeout(()=>finish(reject,new Error('OneSignal se nije učitao. Osvježi stranicu i pokušaj ponovno.')),12000);
    window.OneSignalDeferred=window.OneSignalDeferred||[];
    window.OneSignalDeferred.push(async OneSignal=>{
     try{
      await withTimeout(
       OneSignal.init({
        appId:cfg.appId,
        serviceWorkerPath:'OneSignalSDKWorker.js',
        serviceWorkerParam:{scope:'/'},
        autoResubscribe:true
       }),
       12000,
       'OneSignal inicijalizacija je istekla.'
      );
      oneSignal=OneSignal;
      finish(resolve,OneSignal);
     }catch(e){finish(reject,e);}
    });
   });
  })();
  try{return await initPromise;}
  catch(e){oneSignal=null;throw e;}
  finally{initPromise=null;}
 }

 function updateButton(){
  const button=getButton();
  if(!button)return;
  if(!config?.configured){
   button.innerHTML='<span class="nav-icon">🔕</span> Push nije postavljen';
   return;
  }
  const on=!!oneSignal?.User?.PushSubscription?.optedIn;
  button.innerHTML=`<span class="nav-icon">${on?'🔔':'🔕'}</span> ${on?'Obavijesti uključene':'Uključi obavijesti'}`;
 }

 async function initUser(){
  try{
   const os=await ready();
   const playerId=getPlayerId();
   if(os&&playerId)await withTimeout(os.login(playerId),8000,'OneSignal prijava je istekla.');
   updateButton();
  }catch(e){
   console.warn('KZM push init:',e?.message||e);
   updateButton();
  }
 }

 async function toggle(){
  const os=await ready();
  if(!os)throw new Error('Push još nije konfiguriran.');
  if(!os.Notifications.isPushSupported())throw new Error('Ovaj preglednik ne podržava web push.');

  if(os.User.PushSubscription.optedIn){
   if(!confirm('Isključiti push obavijesti na ovom uređaju?'))return;
   await withTimeout(os.User.PushSubscription.optOut(),10000,'Isključivanje obavijesti je isteklo.');
   updateButton();
   toast('Push obavijesti su isključene na ovom uređaju.');
   return;
  }

  const playerId=getPlayerId();
  if(!playerId)throw new Error('Korisnik nije prijavljen.');
  await withTimeout(os.login(playerId),8000,'OneSignal prijava je istekla.');

  if(typeof Notification!=='undefined'&&Notification.permission==='denied'){
   throw new Error('Obavijesti su blokirane u pregledniku. U postavkama stranice postavi Obavijesti na Dopusti.');
  }
  if(typeof Notification!=='undefined'&&Notification.permission!=='granted'){
   await withTimeout(os.Notifications.requestPermission(),15000,'Preglednik nije prikazao zahtjev za obavijesti.');
  }else if(!os.Notifications.permission){
   await withTimeout(os.Notifications.requestPermission(),15000,'Preglednik nije prikazao zahtjev za obavijesti.');
  }
  if(typeof Notification!=='undefined'&&Notification.permission!=='granted'){
   throw new Error('Obavijesti nisu dopuštene za ovu stranicu.');
  }

  await withTimeout(os.User.PushSubscription.optIn(),10000,'OneSignal pretplata je istekla.');
  updateButton();
  if(!os.User.PushSubscription.optedIn)throw new Error('OneSignal nije uspio uključiti obavijesti na ovom uređaju.');
  toast('Push obavijesti su uključene.');
 }

 function logout(){
  const os=oneSignal;
  oneSignal=null;
  initPromise=null;
  config=null;
  if(!os||typeof os.logout!=='function')return;
  try{Promise.race([Promise.resolve(os.logout()),wait(1500)]).catch(()=>{});}catch{}
 }

 return {initUser,toggle,logout,updateButton};
}
