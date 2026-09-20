import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import crypto from 'node:crypto';
import {fresh,rawSnapshot} from './helpers.mjs';import {prepareSnapshot} from '../scripts/prepare-data.mjs';
test('Import status fingerprint confirms exactly one submitted snapshot',async()=>{const x=await fresh(true);try{assert.equal((await x.call('/admin/import-status',{cookie:x.adminCookie})).data.imported,false);const p=await prepareSnapshot(rawSnapshot(),{id:'owner',name:'Demo Admin'},x.env.AUTH_PEPPER);const expected=crypto.createHash('sha256').update(JSON.stringify(p.data)).digest('hex');assert.equal((await x.call('/admin/import',{cookie:x.adminCookie,body:p.data})).data.fingerprint,expected);const r=await x.call('/admin/import-status',{cookie:x.adminCookie});assert.equal(r.data.imported,true);assert.equal(r.data.fingerprint,expected);assert.equal((await x.call('/admin/import-status')).status,401);}finally{x.env.DB.close();}});
test('Read-only Apps Script exporter exports 38 rounds and no PINs',()=>{
 let modal='';const reads=[];const secret='THIS-IS-NOT-EXPORTED';
 const post={getRange(row,col,count,width){reads.push([row,col,count,width]);let data=[];
  if(col===2){data=Array.from({length:count},()=>Array(19).fill(''));data[0][0]='Demo Admin';data[0][5]=secret;data[0][12]=true;data[0][15]=false;data[0][18]=true;}
  else if(col===4)data=Array.from({length:20},(_,i)=>['Klub '+(i+1),2,'#37003c']);
  else if(col===11)data=Array.from({length:38},(_,i)=>[i+1,new Date('2027-01-01T14:00:00Z')]);
  return {getValues:()=>data};}};
 const round={getRange(row,col,count,width){if(col===9)return {getValues:()=>Array.from({length:10},(_,i)=>['Klub '+(2*i+1),'Klub '+(2*i+2),''])};return {getValues:()=>[['Igrac','Ekipa','','','','',''],['Demo Admin','Klub 1',2,'D','P',2,true],...Array.from({length:count-2},()=>Array(7).fill(''))]};}};
 const context={Date,SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:name=>name==='Postavke'?post:name==='Kolo 1'?round:null}),getUi:()=>({showModalDialog:h=>{modal=h.html;}})},HtmlService:{createHtmlOutput:html=>({html,setWidth(){return this;},setHeight(){return this;}})},Utilities:{base64Encode:s=>Buffer.from(s,'utf8').toString('base64'),Charset:{UTF_8:'UTF_8'}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('../migration/KzmIzvoz.gs',import.meta.url),'utf8'),context);context.KZM_IZVOZ_ZA_NOVU_BAZU();
 const raw=JSON.parse(Buffer.from(modal.match(/base64,([A-Za-z0-9+/=]+)/)[1],'base64').toString());assert.equal(raw.rounds.length,38);assert.equal(raw.teams.length,20);assert.equal(raw.rounds[0].picks.length,1);assert.equal(raw.players[0].payments[1],true);assert.equal(raw.players[0].payments[2],false);assert(!JSON.stringify(raw).includes(secret));assert(!('pin' in raw.players[0]));assert(reads.length>0);
});
