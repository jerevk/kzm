import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createNavigation} from '../public/js/navigation.js';

const root={view:'round',selectedSeason:2026,round:1,cycle:1,scope:'1',archiveScope:'all'};
const route=values=>({...root,...values});
function normalize(value){
 const candidate=value&&typeof value==='object'?value:{};
 const views=['round','results','rules','archive','mine','stats','standings','admin','system'];
 const scope=value=>['all','1','2','3','4'].includes(String(value))?String(value):'1';
 return {
  view:views.includes(candidate.view)?candidate.view:'round',
  selectedSeason:[2025,2026].includes(Number(candidate.selectedSeason))?Number(candidate.selectedSeason):2026,
  round:Number.isInteger(Number(candidate.round))&&Number(candidate.round)>=1&&Number(candidate.round)<=38?Number(candidate.round):1,
  cycle:[1,2,3,4].includes(Number(candidate.cycle))?Number(candidate.cycle):1,
  scope:scope(candidate.scope??'1'),archiveScope:scope(candidate.archiveScope??'all')
 };
}
class FakeHistory{
 constructor(state=null){this.entries=[structuredClone(state)];this.position=0;this.backCalls=0;this.forwardCalls=0;this.urlChanges=[];}
 get state(){return structuredClone(this.entries[this.position]);}
 get length(){return this.entries.length;}
 replaceState(value,title,url){this.entries[this.position]=structuredClone(value);if(url!==undefined)this.urlChanges.push(url);}
 pushState(value,title,url){this.entries.splice(this.position+1);this.entries.push(structuredClone(value));this.position++;if(url!==undefined)this.urlChanges.push(url);}
 back(){this.backCalls++;if(this.position>0)this.position--;}
 forward(){this.forwardCalls++;if(this.position+1<this.entries.length)this.position++;}
}
function setup(history=new FakeHistory(),options={}){
 const restored=[],changes=[];
 let serial=0;
 const nav=createNavigation({history,normalizeRoute:normalize,onRestore:value=>restored.push(value),onChange:value=>changes.push(value),makeKey:()=>`visit-${++serial}`,...options});
 return {nav,history,restored,changes};
}
async function back(x){x.history.back();await x.nav.handlePop(x.history.state);}
async function forward(x){x.history.forward();await x.nav.handlePop(x.history.state);}

test('Back and Forward restore previously visited screens without creating extra entries',async()=>{
 const x=setup();assert.deepEqual(x.nav.start(root),root);
 x.nav.record(route({view:'results'}));x.nav.record(route({view:'rules'}));
 assert.equal(x.history.length,3);assert.equal(x.nav.canGoBack(),true);
 await back(x);assert.deepEqual(x.restored.at(-1),route({view:'results'}));
 await back(x);assert.deepEqual(x.restored.at(-1),root);assert.equal(x.nav.canGoBack(),false);
 const attempts=x.history.backCalls;assert.equal(x.nav.back(),false);assert.equal(x.history.backCalls,attempts);
 await forward(x);assert.deepEqual(x.restored.at(-1),route({view:'results'}));
 await forward(x);assert.deepEqual(x.restored.at(-1),route({view:'rules'}));
 assert.equal(x.history.length,3);assert.deepEqual(x.history.urlChanges,[]);
});

test('Back restores round, cycle, live-table scope and archived scope exactly',async()=>{
 const x=setup();x.nav.start(root);
 const screens=[route({round:12,cycle:2}),route({view:'results',round:12,cycle:2,scope:'all'}),route({view:'archive',selectedSeason:2025,round:12,cycle:2,scope:'all',archiveScope:'3'}),route({view:'rules',selectedSeason:2025,round:12,cycle:2,scope:'all',archiveScope:'3'})];
 for(const screen of screens)x.nav.record(screen);
 for(const expected of [screens[2],screens[1],screens[0],root]){await back(x);assert.deepEqual(x.restored.at(-1),expected);}
 assert.equal(x.history.length,5);
});

test('Repeated refreshes and equivalent routes do not consume Back steps or store form data',async()=>{
 const x=setup(new FakeHistory({foreign:{value:'keep'}}));x.nav.start(root);
 for(let i=0;i<40;i++)assert.equal(x.nav.record({...root,scope:1,draft:'do not persist'}),false);
 const destination=route({view:'results',scope:'all'});x.nav.record(destination);destination.scope='4';
 assert.equal(x.history.length,2);assert.equal(x.history.state.kzmNavigation.route.scope,'all');
 assert(!JSON.stringify(x.history.state).includes('draft'));assert.deepEqual(x.history.state.foreign,{value:'keep'});
 assert.equal(x.nav.back(),true);await x.nav.handlePop(x.history.state);assert.deepEqual(x.restored.at(-1),root);
 x.nav.record(route({view:'mine'}));assert.equal(x.history.length,2);
 await forward(x);assert.deepEqual(x.restored.at(-1),route({view:'mine'}));
});

test('Reload restores the current app route and its previous screen without pushing a duplicate',async()=>{
 const original=setup();original.nav.start(root);original.nav.record(route({view:'archive',selectedSeason:2025,archiveScope:'4'}));
 const reloaded=setup(original.history,{makeKey:()=>{throw new Error('Reload should reuse the existing navigation visit');}});
 assert.deepEqual(reloaded.nav.start(root),route({view:'archive',selectedSeason:2025,archiveScope:'4'}));
 assert.equal(reloaded.history.length,2);assert.equal(reloaded.nav.canGoBack(),true);
 await back(reloaded);assert.deepEqual(reloaded.restored.at(-1),root);assert.equal(reloaded.nav.canGoBack(),false);
});

test('Logout deactivates history restoration; a new login starts a fresh visit without a Back trap',async()=>{
 const x=setup(new FakeHistory({foreign:'preserve'}));x.nav.start(root);x.nav.record(route({view:'admin'}));x.nav.record(route({view:'system',round:20,cycle:3}));
 x.nav.stop();assert.deepEqual(x.history.state,{foreign:'preserve'});assert.equal(x.nav.canGoBack(),false);
 x.history.back();assert.equal(await x.nav.handlePop(x.history.state),false);assert.equal(x.restored.length,0);
 assert.deepEqual(x.nav.start(root,{restore:false}),root);assert.equal(x.nav.canGoBack(),false);
 const count=x.history.length,backCalls=x.history.backCalls,forwardCalls=x.history.forwardCalls;
 assert.equal(x.nav.back(),false);assert.equal(x.history.backCalls,backCalls);
 await back(x);assert.deepEqual(x.restored.at(-1),root);assert.equal(x.nav.canGoBack(),false);
 assert.equal(x.history.length,count);assert.equal(x.history.forwardCalls,forwardCalls);assert.equal(x.history.backCalls,backCalls+1);
 assert.deepEqual(x.history.state.foreign,'preserve');
});

test('Malformed saved state falls back safely while preserving unrelated history state',async()=>{
 for(const invalid of [{version:2,key:'old',index:2},{version:1,key:'',index:2},{version:1,key:'old',index:-1},{version:1,key:'old',index:Infinity},{version:1,key:'old',index:1.5}]){
  const x=setup(new FakeHistory({foreign:17,kzmNavigation:{...invalid,route:route({view:'system'})}}));
  assert.deepEqual(x.nav.start(root),root);assert.equal(x.nav.back(),false);assert.equal(x.history.length,1);assert.equal(x.history.state.foreign,17);
 }
 const x=setup(new FakeHistory({foreign:17,kzmNavigation:{version:1,key:'existing',index:0,route:{view:'nonsense',round:99,password:'not a route'}}}));
 assert.deepEqual(x.nav.start(root),root);assert(!JSON.stringify(x.history.state).includes('password'));
 const count=x.history.length;x.history.replaceState({foreign:18},'');await x.nav.handlePop(x.history.state);
 assert.deepEqual(x.restored.at(-1),root);assert.equal(x.history.length,count);assert.equal(x.history.backCalls,0);assert.equal(x.history.forwardCalls,0);assert.equal(x.history.state.foreign,18);
});

test('Overlapping asynchronous restorations keep the latest history position',async()=>{
 const pending=[];
 const x=setup(new FakeHistory(),{onRestore:()=>new Promise(resolve=>pending.push(resolve))});
 x.nav.start(root);x.nav.record(route({view:'results'}));x.nav.record(route({view:'rules'}));
 x.history.back();const first=x.nav.handlePop(x.history.state);
 x.history.back();const second=x.nav.handlePop(x.history.state);
 pending[1]();await second;pending[0]();await first;
 assert.equal(x.nav.canGoBack(),false);assert.deepEqual(x.history.state.kzmNavigation.route,root);assert.equal(x.history.length,3);
});

test('The app restores saved routes against the signed-in role and available season, rounds and scopes',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const declaration=source.match(/function normalizeRoute\(value\)\{[\s\S]*?\n\}/)?.[0];
 assert(declaration,'The app must validate route snapshots before restoring them');
 const boot={season:2026,currentRound:12,user:{admin:false},rounds:[{number:1,cycle:1},{number:12,cycle:2},{number:20,cycle:3},{number:30,cycle:4}],cycles:[{id:1},{id:2},{id:3},{id:4}]};
 const validate=runInNewContext(declaration+'; normalizeRoute;',{state:{boot}});
 const appNormalize=value=>structuredClone(validate(value));
 for(const view of ['admin','system']){
  assert.deepEqual(appNormalize(route({view,selectedSeason:2025})),root);
 }
 assert.deepEqual(appNormalize({view:'missing',selectedSeason:2099,round:99,cycle:99,scope:'invalid',archiveScope:'invalid',password:'never persist'}),route({round:12,cycle:2,scope:'2'}));
 const archived=route({view:'rules',selectedSeason:2025,round:20,cycle:3,scope:'all',archiveScope:'4'});
 assert.deepEqual(appNormalize(archived),archived);
 assert.deepEqual(appNormalize({...archived,view:'results'}),{...archived,view:'archive'});
 assert.equal(appNormalize(route({view:'archive'})).selectedSeason,2025);
 boot.user.admin=true;
 assert.deepEqual(appNormalize(route({view:'system',round:30,cycle:4})),route({view:'system',round:30,cycle:4}));
});
