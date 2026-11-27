import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function section(from,to){
 const start=source.indexOf(from),end=source.indexOf(to,start);
 assert(start>=0&&end>start,`Missing app section: ${from}`);
 return source.slice(start,end);
}
const helpers=section('function adminFormOpen()','function collapseAdminPanels(');
const loading=section('async function load(','function liveWindowOpen(');
const refresh=section('async function liveRefreshTick(force=false)','setInterval(liveRefreshTick,');
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function setup(){
 const state={boot:{},view:'admin',admin:{original:true},sequence:0,busy:false,liveRefreshing:false,adminPanelView:null,adminOpenPanels:[]};
 const ui={panels:[],formOpen:false,passwordOpen:false,mainHTML:'original form',rendered:[],requests:[],history:[]};
 const main={get innerHTML(){return ui.mainHTML;},set innerHTML(value){ui.mainHTML=value;ui.panels=[];}};
 const context={state,
  $:selector=>selector==='#main'?main:selector==='#password-dialog'?{open:ui.passwordOpen}:selector==='#main details[data-admin-panel][open] form'&&ui.formOpen?{}:null,
  document:{visibilityState:'visible',querySelectorAll:()=>ui.panels},
  navigation:{record:value=>ui.history.push(value)},currentRoute:()=>({view:state.view}),nav:()=>{},setMenu:()=>{},stopRoundCountdown:()=>{},
  api:path=>{ui.requests.push(path);return Promise.resolve({updated:true});},
  renderAdmin:()=>ui.rendered.push({view:'admin',open:[...state.adminOpenPanels]}),
  renderRules:()=>ui.rendered.push({view:'rules'}),
  liveWindowOpen:()=>false,refreshSnapshot:()=>false,esc:String,console,lastBackgroundRefresh:0
 };
 const functions=runInNewContext(helpers+loading+refresh+'; ({rememberAdminPanels,adminFormOpen,load,liveRefreshTick});',context);
 return {state,ui,context,...functions};
}
const panel=(name,open=true)=>({dataset:{adminPanel:name},open});

test('Admin sections start closed, survive a refresh, and reset after leaving the page',async()=>{
 const x=setup();
 x.ui.panels=[panel('players-payments')];
 x.rememberAdminPanels('admin');
 assert.deepEqual([...x.state.adminOpenPanels],[]);
 x.rememberAdminPanels('admin');
 assert.deepEqual([...x.state.adminOpenPanels],['players-payments']);
 await x.load('admin');
 assert.deepEqual(x.ui.rendered,[{view:'admin',open:['players-payments']}]);
 assert.deepEqual(x.ui.history,[{view:'admin'}]);
 await x.load('rules',false,'skip');
 assert.equal(x.state.adminPanelView,null);
 assert.deepEqual([...x.state.adminOpenPanels],[]);
 await x.load('admin',false,'skip');
 assert.deepEqual(x.ui.rendered.at(-1),{view:'admin',open:[]});
 assert.equal(x.ui.history.length,1);
});

test('Automatic admin refresh preserves an open editing form or password dialog without fetching',async()=>{
 for(const field of ['formOpen','passwordOpen']){
  const x=setup();x.ui[field]=true;
  await x.load('admin',true);
  await x.liveRefreshTick();
  assert.deepEqual(x.ui.requests,[]);
  assert.deepEqual(x.ui.rendered,[]);
  assert.equal(x.ui.mainHTML,'original form');
  assert.equal(x.state.sequence,0);
  assert.equal(x.state.liveRefreshing,false);
 }
});

test('An admin refresh already in flight does not overwrite a form opened before the response',async()=>{
 const x=setup(),request=deferred();
 x.context.api=path=>{x.ui.requests.push(path);return request.promise;};
 const pending=x.load('admin',true);
 assert.deepEqual(x.ui.requests,['/admin/panel']);
 x.ui.formOpen=true;
 request.resolve({updated:true});await pending;
 assert.deepEqual(x.state.admin,{original:true});
 assert.deepEqual(x.ui.rendered,[]);
 assert.equal(x.ui.mainHTML,'original form');
 assert.deepEqual(x.ui.history,[]);
});

test('Opening a form while the live pulse is in flight prevents the subsequent admin refresh',async()=>{
 const x=setup(),pulse=deferred();x.state.admin.sourceRaceActive=1;
 x.context.api=path=>{x.ui.requests.push(path);return path==='/live/pulse'?pulse.promise:Promise.resolve({updated:true});};
 const pending=x.liveRefreshTick();
 assert.deepEqual(x.ui.requests,['/live/pulse']);
 x.ui.formOpen=true;pulse.resolve({ok:true});await pending;
 assert.deepEqual(x.ui.requests,['/live/pulse']);
 assert.deepEqual(x.ui.rendered,[]);
 assert.equal(x.state.liveRefreshing,false);
});

test('A read-only admin section refreshes normally and keeps its expanded section',async()=>{
 const x=setup();x.state.adminPanelView='admin';x.ui.panels=[panel('source-race'),panel('add-player',false)];
 await x.liveRefreshTick();
 assert.deepEqual(x.ui.requests,['/admin/panel']);
 assert.deepEqual(x.ui.rendered,[{view:'admin',open:['source-race']}]);
 assert.deepEqual(x.state.admin,{updated:true});
 assert.deepEqual(x.ui.history,[]);
 assert.equal(x.state.liveRefreshing,false);
});

test('A late admin response cannot replace the screen after Back navigates to another view',async()=>{
 const x=setup(),request=deferred();
 x.context.api=path=>{x.ui.requests.push(path);return request.promise;};
 const pending=x.load('admin',true);
 await x.load('rules',false,'skip');
 request.resolve({updated:true});await pending;
 assert.equal(x.state.view,'rules');
 assert.deepEqual(x.ui.rendered,[{view:'rules'}]);
 assert.deepEqual(x.state.admin,{original:true});
 assert.equal(x.state.adminPanelView,null);
 assert.deepEqual(x.ui.history,[]);
});
