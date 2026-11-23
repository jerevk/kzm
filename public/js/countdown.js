const finiteNumber=value=>{
 if(typeof value!=='number'&&typeof value!=='string')return null;
 if(typeof value==='string'&&!value.trim())return null;
 const number=Number(value);
 return Number.isFinite(number)?number:null;
};

// Capture once when a server response arrives. Subsequent reads use elapsed
// monotonic time rather than the device's potentially incorrect wall clock.
export function createServerClock(serverTime,nowMs=()=>performance.now()){
 const supplied=finiteNumber(serverTime),base=supplied!==null&&supplied>0?supplied:Date.now()/1000;
 let anchor=finiteNumber(nowMs()),elapsed=0;
 return ()=>{
  const tick=finiteNumber(nowMs());
  if(tick!==null){
   if(anchor===null)anchor=tick;
   const delta=tick-anchor;
   if(Number.isFinite(delta)&&delta>elapsed)elapsed=delta;
  }
  return base+elapsed/1000;
 };
}

export function getRoundCountdown(deadline,nowSeconds){
 const target=finiteNumber(deadline),now=finiteNumber(nowSeconds);
 if(target===null||now===null)return {status:'unset',remainingSeconds:null,label:'Rok još nije postavljen',urgency:'normal'};
 const remainingSeconds=Math.max(0,Math.ceil(target-now));
 if(remainingSeconds===0)return {status:'locked',remainingSeconds:0,label:'Odabiri su zaključani',urgency:'normal'};
 const days=Math.floor(remainingSeconds/86400),hours=Math.floor(remainingSeconds%86400/3600),minutes=Math.floor(remainingSeconds%3600/60),seconds=remainingSeconds%60;
 const pad=value=>String(value).padStart(2,'0'),parts=[];
 if(days)parts.push(`${days} d`);
 if(days||hours)parts.push(`${days?pad(hours):hours} h`);
 if(days||hours||minutes)parts.push(`${days||hours?pad(minutes):minutes} min`);
 parts.push(`${pad(seconds)} s`);
 return {status:'open',remainingSeconds,label:parts.join(' '),urgency:remainingSeconds<=900?'urgent':remainingSeconds<=3600?'soon':'normal'};
}
