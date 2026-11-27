import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createServerClock,getRoundCountdown} from '../public/js/countdown.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const epoch=1800000000;
function section(from,to){
 const start=source.indexOf(from),end=source.indexOf(to,start);
 assert(start>=0&&end>start,`Missing app section: ${from}`);
 return source.slice(start,end);
}
const countdown=section('let roundCountdownTimer=','function currentRoute(');
const loading=section('async function load(','function liveWindowOpen(');
const refreshing=section('async function liveRefreshTick(force=false)','function doubleBadge(');
const round=(overrides={})=>({serverTime:epoch,round:{number:1,deadline:epoch+120,locked:false},myPick:null,...overrides});
async function settle(){for(let i=0;i<8;i++)await Promise.resolve();}

function setup(data=round()){
 const state={boot:{},view:'round',round:Number(data.round.number),roundData:data,sequence:0,busy:false,liveRefreshing:false,admin:null};
 const ui={milliseconds:0,hostPresent:true,clockCaptures:0,requests:[],renders:[],toasts:[],controls:[{disabled:false},{disabled:false},{disabled:false}]};
 const elements={
  '#round-countdown':{dataset:{}},'#round-countdown-title':{textContent:''},
  '#round-countdown-value':{textContent:''},'#round-countdown-note':{textContent:''}
 };
 const main={set innerHTML(value){ui.hostPresent=false;ui.mainHTML=value;},get innerHTML(){return ui.mainHTML;}};
 const timers=new Map(),listeners=new Map();let nextTimer=1,functions;
 const context={state,
  $:selector=>selector==='#main'?main:ui.hostPresent?elements[selector]||null:null,
  document:{visibilityState:'visible',querySelectorAll:()=>ui.controls,addEventListener:(name,callback)=>listeners.set(name,callback)},
  createServerClock:serverTime=>{ui.clockCaptures++;return createServerClock(serverTime,()=>ui.milliseconds);},getRoundCountdown,
  setInterval:(callback,delay)=>{const id=nextTimer++;timers.set(id,{callback,delay});return id;},clearInterval:id=>timers.delete(id),
  api:path=>new Promise((resolve,reject)=>ui.requests.push({path,resolve,reject})),
  renderRound:d=>{ui.hostPresent=true;ui.renders.push({view:'round',round:d.round.number});ui.controls.forEach(control=>{control.disabled=!!d.round.locked;});functions.startRoundCountdown(d);},
  renderRules:()=>{ui.hostPresent=false;ui.renders.push({view:'rules'});},
  navigation:{record:()=>{}},currentRoute:()=>({view:state.view,round:state.round}),nav:()=>{},setMenu:()=>{},
  rememberAdminPanels:()=>{},adminFormOpen:()=>false,liveWindowOpen:()=>false,esc:String,toast:value=>ui.toasts.push(value),console
 };
 functions=runInNewContext(countdown+loading+refreshing+'; ({rememberRoundClock,startRoundCountdown,stopRoundCountdown,updateRoundCountdown,load,liveRefreshTick});',context);
 functions.rememberRoundClock(data);functions.startRoundCountdown(data);
 const tick=milliseconds=>{ui.milliseconds=milliseconds;for(const timer of [...timers.values()])if(timer.delay===1000)timer.callback();};
 const visibility=value=>{context.document.visibilityState=value;listeners.get('visibilitychange')();};
 const respond=async(index,response)=>{ui.requests[index].resolve(response);await settle();};
 return {state,ui,elements,timers,context,tick,visibility,respond,...functions};
}
const countdownTimers=x=>[...x.timers.values()].filter(timer=>timer.delay===1000);
const paths=x=>x.ui.requests.map(request=>request.path);

test('Local countdown ticks and pick-editor rerenders do not fetch or restart the captured server clock',()=>{
 const x=setup();
 assert.equal(x.elements['#round-countdown-value'].textContent,'2 min 00 s');
 x.tick(40000);
 assert.equal(x.elements['#round-countdown-value'].textContent,'1 min 20 s');
 x.startRoundCountdown(x.state.roundData);
 assert.equal(x.elements['#round-countdown-value'].textContent,'1 min 20 s');
 assert.equal(x.ui.clockCaptures,1);
 assert.equal(countdownTimers(x).length,1);
 x.tick(41000);
 assert.equal(x.elements['#round-countdown-value'].textContent,'1 min 19 s');
 assert.deepEqual(paths(x),[]);
});

test('Expiry disables pick controls immediately and requests only one refresh while the response is pending',async()=>{
 const x=setup(round({round:{number:1,deadline:epoch+2,locked:false}}));
 x.tick(2000);
 assert.equal(x.elements['#round-countdown'].dataset.status,'locked');
 assert(x.ui.controls.every(control=>control.disabled));
 assert.deepEqual(paths(x),['/round/1']);
 for(const now of [3000,4000,5000])x.tick(now);
 assert.deepEqual(paths(x),['/round/1']);
 await x.respond(0,round({serverTime:epoch+5,round:{number:1,deadline:epoch+2,locked:true}}));
 assert.equal(countdownTimers(x).length,0);
 assert.equal(x.state.liveRefreshing,false);
});

test('A busy save defers the expiry refresh while still locking controls',()=>{
 const x=setup(round({round:{number:1,deadline:epoch+1,locked:false}}));
 x.state.busy=true;x.tick(1000);
 assert(x.ui.controls.every(control=>control.disabled));
 assert.deepEqual(paths(x),[]);
 x.state.busy=false;x.tick(2000);x.tick(3000);
 assert.deepEqual(paths(x),['/round/1']);
});

test('A new response for the same expired deadline preserves the one-refresh guard',async()=>{
 const x=setup(round({round:{number:1,deadline:epoch+1,locked:false}}));
 x.tick(1000);
 await x.respond(0,round({serverTime:epoch+2,round:{number:1,deadline:epoch+1,locked:false}}));
 assert.equal(x.ui.clockCaptures,2);
 assert.equal(x.elements['#round-countdown'].dataset.status,'locked');
 x.tick(2000);x.tick(3000);x.startRoundCountdown(x.state.roundData);x.tick(4000);
 assert.deepEqual(paths(x),['/round/1']);
 assert.equal(x.ui.clockCaptures,2);
});

test('Hidden countdowns stay quiet; becoming visible after expiry sends one refresh in that event turn',async()=>{
 const x=setup(round({round:{number:1,deadline:epoch+1,locked:false}}));
 x.visibility('hidden');x.tick(2000);
 assert.deepEqual(paths(x),[]);
 assert.equal(x.elements['#round-countdown'].dataset.status,'open');
 assert(x.ui.controls.every(control=>!control.disabled));
 x.visibility('visible');
 assert.equal(x.elements['#round-countdown'].dataset.status,'locked');
 assert(x.ui.controls.every(control=>control.disabled));
 assert.deepEqual(paths(x),['/round/1']);
 await x.respond(0,round({serverTime:epoch+2,round:{number:1,deadline:epoch+1,locked:true}}));
 assert.deepEqual(paths(x),['/round/1']);
});

test('Expiry reuses a regular refresh already in flight instead of issuing a duplicate request',async()=>{
 const x=setup(round({round:{number:1,deadline:epoch+2,locked:false}}));
 const pending=x.liveRefreshTick();
 x.tick(2000);
 assert(x.ui.controls.every(control=>control.disabled));
 assert.deepEqual(paths(x),['/round/1']);
 await x.respond(0,round({serverTime:epoch+2,round:{number:1,deadline:epoch+2,locked:true}}));
 await pending;
 assert.equal(countdownTimers(x).length,0);
 assert.deepEqual(paths(x),['/round/1']);
});

test('Leaving the round stops its timer and rejects a stale round response and queued tick',async()=>{
 const x=setup(),queuedTick=countdownTimers(x)[0].callback;
 const pending=x.liveRefreshTick();
 await x.load('rules',false,'skip');
 assert.equal(countdownTimers(x).length,0);
 await x.respond(0,round({serverTime:epoch+200,round:{number:1,deadline:epoch+120,locked:true}}));
 await pending;
 x.ui.milliseconds=200000;queuedTick();
 assert.equal(x.state.view,'rules');
 assert.equal(x.ui.clockCaptures,1);
 assert.deepEqual(x.ui.renders,[{view:'rules'}]);
 assert.deepEqual(paths(x),['/round/1']);
 assert(x.ui.controls.every(control=>!control.disabled));
});

test('A stale clock cannot change controls after selecting another round or signing out',()=>{
 for(const change of [x=>{x.state.round=2;},x=>{x.state.boot=null;}]){
  const x=setup(round({round:{number:1,deadline:epoch+1,locked:false}}));
  change(x);x.tick(2000);
  assert.deepEqual(paths(x),[]);
  assert(x.ui.controls.every(control=>!control.disabled));
  assert.equal(x.elements['#round-countdown'].dataset.status,'open');
 }
});

test('An unset deadline shows its explanatory state without a countdown interval or request',()=>{
 const x=setup(round({round:{number:1,deadline:null,locked:true}}));
 assert.equal(x.elements['#round-countdown'].dataset.status,'unset');
 assert.equal(x.elements['#round-countdown-value'].textContent,'Rok još nije postavljen');
 assert.equal(countdownTimers(x).length,0);
 assert.deepEqual(paths(x),[]);
});
