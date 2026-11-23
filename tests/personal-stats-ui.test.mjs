import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {calculatePersonalStats} from '../public/js/personal-stats.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function section(from,to){
 const start=source.indexOf(from),end=source.indexOf(to,start);
 assert(start>=0&&end>start,`Missing app section: ${from}`);
 return source.slice(start,end);
}
const functions=section('const esc=','const state=')+
 source.match(/^const empty=.*$/m)[0]+'\n'+
 section('function teamPill(','async function api(')+
 section('function scopeSelect(','async function load(')+
 section('function doubleBadge(','function fixtureHtml(')+
 section('function rankMovementBadge(','function renderResults(')+
 section('function renderPersonalStats(','function renderStats(');

function setup(scope='all'){
 const main={innerHTML:''};
 const state={scope,selectedSeason:2026,boot:{cycles:[
  {id:1,from:1,to:10},{id:2,from:11,to:19},{id:3,from:20,to:28},{id:4,from:29,to:38}
 ]}};
 const ui=runInNewContext(functions+';({renderMine,renderPersonalStats,rankMovementBadge});',{
  state,calculatePersonalStats,$:selector=>selector==='#main'?main:null,
  teamColor:()=>'#37003c',clubBadge:()=>''
 });
 return {main,state,...ui};
}
const pick=(round_no,cycle,team_name,points,settled,is_double=0)=>({
 round_no,cycle,team_name,points,settled,is_double,home_score:null,away_score:null
});
function card(html,label){
 const found=html.match(new RegExp('<article class="personal-stat"><h3>'+label+'</h3>([\\s\\S]*?)</article>'));
 assert(found,`Missing stat card: ${label}`);
 return found[1];
}

test('Personal stats and history use the selected cycle, while all includes every cycle',()=>{
 const x=setup('1'),rows=[
  pick(1,1,'Arsenal',1,true,1),pick(2,1,'Chelsea',0,1,1),
  pick(3,1,'Live club',20,false,1),pick(11,2,'Other cycle',9,1,1)
 ];
 x.renderMine({rows});
 assert.match(x.main.innerHTML,/2 završenih odabira · 1 čeka ishod · 1 potvrđenih bodova/);
 assert.match(card(x.main.innerHTML,'Pogođeni DOUBLE'),/>1 \/ 2</);
 assert.match(card(x.main.innerHTML,'Pogođeni DOUBLE'),/50 % uspješnosti/);
 assert.match(card(x.main.innerHTML,'Najbolje kolo'),/>Kolo 1</);
 assert.doesNotMatch(x.main.innerHTML,/Other cycle/);
 assert.doesNotMatch(card(x.main.innerHTML,'Klub s najviše bodova'),/Live club/);
 x.state.scope='all';x.renderMine({rows});
 assert.match(x.main.innerHTML,/3 završenih odabira · 1 čeka ishod · 10 potvrđenih bodova/);
 assert.match(card(x.main.innerHTML,'Pogođeni DOUBLE'),/>2 \/ 3</);
 assert.match(card(x.main.innerHTML,'Pogođeni DOUBLE'),/66,7 % uspješnosti/);
 assert.match(card(x.main.innerHTML,'Najbolje kolo'),/>Kolo 11</);
 assert.match(x.main.innerHTML,/Other cycle/);
});

test('Empty and all-zero statistics distinguish unavailable rates from zero success',()=>{
 const x=setup();x.renderMine({rows:[]});
 assert.match(card(x.main.innerHTML,'Pogođeni odabiri'),/>–</);
 assert.match(card(x.main.innerHTML,'Pogođeni DOUBLE'),/>–</);
 assert.doesNotMatch(x.main.innerHTML,/0 \/ 0|NaN|Infinity/);
 assert.match(x.main.innerHTML,/Nema odabira za ovaj prikaz/);
 x.renderMine({rows:[pick(1,1,'Arsenal',0,1,1),pick(2,1,'Chelsea',0,true)]});
 assert.match(card(x.main.innerHTML,'Pogođeni odabiri'),/>0 \/ 2</);
 assert.match(card(x.main.innerHTML,'Pogođeni odabiri'),/0 % uspješnosti/);
 assert.match(card(x.main.innerHTML,'Pogođeni DOUBLE'),/>0 \/ 1</);
 assert.match(card(x.main.innerHTML,'Najbolje kolo'),/>–</);
 assert.match(card(x.main.innerHTML,'Klub s najviše bodova'),/>–</);
});

test('Tied best rounds and clubs remain visible with per-round and per-club totals',()=>{
 const x=setup();x.renderMine({rows:[
  pick(4,1,'Chelsea',6,true),pick(2,1,'Arsenal',3,true),
  pick(3,1,'Bournemouth',6,true),pick(1,1,'Arsenal',3,true),
  pick(5,1,'Bournemouth',0,true)
 ]});
 assert.match(card(x.main.innerHTML,'Najbolja kola'),/>Kola 3, 4</);
 assert.match(card(x.main.innerHTML,'Najbolja kola'),/6 bodova po kolu/);
 assert.match(card(x.main.innerHTML,'Klubovi s najviše bodova'),/>Arsenal, Bournemouth, Chelsea</);
 assert.match(card(x.main.innerHTML,'Klubovi s najviše bodova'),/6 bodova po klubu/);
});

test('Club names are escaped in both statistics and rendered history',()=>{
 const x=setup(),name='<img src=x onerror=alert(1)> & "Club"';
 x.renderMine({rows:[pick(1,1,name,7,true)]});
 assert.doesNotMatch(x.main.innerHTML,/<img src=x/);
 const escaped='&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Club&quot;';
 assert(card(x.main.innerHTML,'Klub s najviše bodova').includes(escaped));
 assert.equal(x.main.innerHTML.split(escaped).length-1,2);
});

test('Ranking movement labels distinguish up, down, unchanged and unavailable comparisons',()=>{
 const x=setup(),comparison={round:12};
 const up=x.rankMovementBadge({placeChange:2,previousPlace:5},comparison);
 assert.match(up,/place-change-up/);assert.match(up,/↑<\/span><small>2<\/small>/);
 assert.match(up,/Prije 12\. kola: 5\. mjesto/);
 const down=x.rankMovementBadge({placeChange:-1,previousPlace:3},comparison);
 assert.match(down,/place-change-down/);assert.match(down,/↓<\/span><small>1<\/small>/);
 const unchanged=x.rankMovementBadge({placeChange:0,previousPlace:2},comparison);
 assert.match(unchanged,/Bez promjene mjesta/);assert.match(unchanged,/→<\/span>/);
 for(const [row,baseline] of [[{placeChange:0,previousPlace:null},comparison],[{placeChange:0,previousPlace:2},null]]){
  const missing=x.rankMovementBadge(row,baseline);
  assert.match(missing,/Još nema usporedbe/);assert.match(missing,/>–</);
 }
});
