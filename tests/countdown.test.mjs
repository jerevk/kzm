import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerClock,getRoundCountdown} from '../public/js/countdown.js';

const epoch=1800000000;

test('An absent or nonfinite deadline stays unset without a fake remaining time',()=>{
 for(const deadline of [null,undefined,'','  ',NaN,Infinity,-Infinity,'not a deadline']){
  assert.deepEqual(getRoundCountdown(deadline,epoch),{status:'unset',remainingSeconds:null,label:'Rok još nije postavljen',urgency:'normal'});
 }
});

test('The deadline locks exactly on time, while a positive fraction still displays one second',()=>{
 assert.deepEqual(getRoundCountdown(epoch,epoch),{status:'locked',remainingSeconds:0,label:'Odabiri su zaključani',urgency:'normal'});
 assert.deepEqual(getRoundCountdown(epoch-1,epoch),getRoundCountdown(epoch,epoch));
 assert.equal(getRoundCountdown(0,epoch).status,'locked');
 assert.deepEqual(getRoundCountdown(epoch+0.1,epoch),{status:'open',remainingSeconds:1,label:'01 s',urgency:'urgent'});
});

test('Croatian duration labels retain days, hours, minutes and padded seconds',()=>{
 const examples=[
  [2*86400+3*3600+4*60+5,'2 d 03 h 04 min 05 s'],
  [86400,'1 d 00 h 00 min 00 s'],
  [2*3600+17*60+4,'2 h 17 min 04 s'],
  [3600,'1 h 00 min 00 s'],
  [17*60+4,'17 min 04 s'],
  [60,'1 min 00 s'],
  [9,'09 s']
 ];
 for(const [duration,label]of examples){
  const result=getRoundCountdown(String(epoch+duration),epoch);
  assert.equal(result.label,label);assert.equal(result.remainingSeconds,duration);assert.equal(result.status,'open');
 }
});

test('Urgency changes at one hour and fifteen minutes without locking early',()=>{
 for(const [duration,urgency]of [[3601,'normal'],[3600,'soon'],[901,'soon'],[900,'urgent'],[1,'urgent']]){
  assert.equal(getRoundCountdown(epoch+duration,epoch).urgency,urgency);
 }
 assert.equal(getRoundCountdown(epoch+3600.1,epoch).urgency,'normal');
 assert.equal(getRoundCountdown(epoch+900.1,epoch).urgency,'soon');
});

test('The server clock advances with monotonic elapsed time and ignores device wall-clock changes',t=>{
 let tick=5000;
 const wall=t.mock.method(Date,'now',()=>42);
 const clock=createServerClock(epoch,()=>tick);
 assert.equal(clock(),epoch);
 tick=6234;assert.equal(clock(),epoch+1.234);
 wall.mock.mockImplementation(()=>9999999999999);
 tick=7234;assert.equal(clock(),epoch+2.234);
 for(const badTick of [6000,NaN,Infinity,-Infinity]){tick=badTick;assert.equal(clock(),epoch+2.234);}
 tick=9100;assert.equal(clock(),epoch+4.1);
});

test('Missing server time uses a captured wall-clock fallback and tolerates an invalid initial monotonic reading',t=>{
 t.mock.method(Date,'now',()=>epoch*1000);
 for(const serverTime of [null,undefined,'',0,-1,NaN,Infinity]){
  let tick=NaN;
  const clock=createServerClock(serverTime,()=>tick);
  assert.equal(clock(),epoch);
  tick=200;assert.equal(clock(),epoch);
  tick=1700;assert.equal(clock(),epoch+1.5);
 }
});

test('Countdown reads return independent snapshots without changing round data or earlier results',()=>{
 const round=Object.freeze({number:3,deadline:epoch+10});
 const open=getRoundCountdown(round.deadline,epoch);
 const original=structuredClone(open);
 const locked=getRoundCountdown(round.deadline,epoch+10);
 assert.deepEqual(open,original);
 assert.notStrictEqual(open,locked);
 assert.deepEqual(round,{number:3,deadline:epoch+10});
 assert.equal(open.remainingSeconds,10);
 assert.equal(locked.remainingSeconds,0);
});
