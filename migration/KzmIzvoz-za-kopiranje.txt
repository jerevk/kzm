/**
 * POKRENI SAMO NA KOPIJI SPREADSHEETA.
 * Citajuci izvoz: ne upisuje celije, ne brise nista, ne salje mailove,
 * ne stvara triggere, ne koristi vanjske URL-ove i NE izvozi PIN-ove.
 * U zasebnoj .gs datoteci pokreni KZM_IZVOZ_ZA_NOVU_BAZU.
 */
function KZM_IZVOZ_ZA_NOVU_BAZU() {
 var ss=SpreadsheetApp.getActiveSpreadsheet(),post=ss.getSheetByName('Postavke');
 if(!post)throw new Error('Nema lista Postavke.');
 var norm=function(v){return String(v==null?'':v).normalize('NFC').trim().toLowerCase().replace(/&/g,'and').replace(/\./g,'').replace(/\s+/g,' ');};
 var paid=function(v){if(v===true||v===1)return true;if(v===false||v===0)return false;var s=norm(v);if(['true','da','placeno','pla\u0107eno','1','yes'].indexOf(s)>=0)return true;if(['false','ne','neplaceno','nepla\u0107eno','0','no'].indexOf(s)>=0)return false;if(!s)return null;throw new Error('Nepoznata vrijednost placanja: '+String(v));};
 var iso=function(d){if(d===''||d==null)return null;if(d instanceof Date&&!isNaN(d.getTime()))return d.toISOString();throw new Error('Datum nije datum-celija: '+String(d)+'. Provjeri rokove u kopiji.');};
 var count=typeof webBrojIgraca_==='function'?Number(webBrojIgraca_()):25;
 if(!Number.isInteger(count)||count<1||count>200)throw new Error('Neispravan broj mjesta igraca.');
 var out={format:'kzm-export-v1',season:typeof webSeason_==='function'?Number(webSeason_()):2026,exportedAt:new Date().toISOString(),sourcePlayerSlots:count,players:[],teams:[],rounds:[],totals:{},warnings:[]};
 var pmap={},tmap={},api={};
 post.getRange(3,2,count,19).getValues().forEach(function(r){var name=String(r[0]||'').trim();if(!name)return;var k=norm(name);if(pmap[k])throw new Error('Dupliciran igrac: '+name);pmap[k]=name;out.players.push({name:name,active:!(r[18]===false||norm(r[18])==='neaktivan'),payments:{1:paid(r[12]),2:paid(r[15]),3:paid(r[16]),4:paid(r[17])}});});
 post.getRange(3,4,20,3).getValues().forEach(function(r){var name=String(r[0]||'').trim();if(!name)return;if(r[1]===''||!Number.isFinite(Number(r[1])))throw new Error('Nedostaju osnovni bodovi: '+name);var t={name:name,base:Number(r[1]),color:/^#[0-9a-f]{6}$/i.test(String(r[2]))?String(r[2]):'#37003c',apiId:null};out.teams.push(t);tmap[norm(name)]=t;});
 if(out.teams.length!==20)throw new Error('Nije pronadjeno 20 klubova u Postavke!D3:F22.');
 var cache=ss.getSheetByName('API Cache');if(cache&&cache.getLastRow()>1)cache.getRange(2,1,cache.getLastRow()-1,11).getValues().forEach(function(r){var n=Number(r[0]),h=norm(r[5]),a=norm(r[7]);if(!n||!h||!a)return;api[n+'|'+h+'|'+a]={apiId:r[1]?Number(r[1]):null,kickoff:iso(r[2]),status:String(r[3]||'SCHEDULED'),hs:r[8]===''?null:Number(r[8]),as:r[9]===''?null:Number(r[9])};if(tmap[h]&&r[4])tmap[h].apiId=Number(r[4]);if(tmap[a]&&r[6])tmap[a].apiId=Number(r[6]);});
 var deadlines={};post.getRange(3,11,38,2).getValues().forEach(function(r,i){deadlines[Number(r[0])||i+1]=iso(r[1]);});
 for(var n=1;n<=38;n++){
  var sh=ss.getSheetByName('Kolo '+n),round={number:n,deadline:deadlines[n]||null,fixtures:[],picks:[]};
  if(sh){
   // Read one extra row to detect the offset difference in historical versions.
   sh.getRange(2,1,count+1,7).getValues().forEach(function(r){var name=String(r[0]||'').trim(),team=String(r[1]||'').trim();if(!team)return;if(['igrac','igra\u010d','ime','ime i prezime'].indexOf(norm(name))>=0&&['ekipa','klub','odabir'].indexOf(norm(team))>=0)return;if(!pmap[norm(name)])throw new Error('Odabir nepoznatog/praznog igraca u Kolo '+n+': '+name);if(!tmap[norm(team)])throw new Error('Nepoznat klub u Kolo '+n+': '+team);var pts=r[5]===''||r[5]==null?null:Number(r[5]);if(pts!==null&&!Number.isFinite(pts))throw new Error('Neispravni bodovi '+name+', Kolo '+n);round.picks.push({player:pmap[norm(name)],team:tmap[norm(team)].name,double:r[6]===true,base:r[2]===''?tmap[norm(team)].base:Number(r[2]),points:pts});});
   sh.getRange(4,9,10,3).getValues().forEach(function(r){var h=String(r[0]||'').trim(),a=String(r[1]||'').trim();if(!h&&!a)return;if(!tmap[norm(h)]||!tmap[norm(a)])throw new Error('Nepoznat klub u rasporedu kola '+n);var existing=api[n+'|'+norm(h)+'|'+norm(a)]||null,rez=String(r[2]==null?'':r[2]).trim(),m=rez.match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);if(rez&&!m)throw new Error('Neispravan rezultat u kolu '+n+': '+rez);var hs=m?Number(m[1]):null,as=m?Number(m[2]):null;var manual=!!m&&(!existing||existing.hs!==hs||existing.as!==as);round.fixtures.push({home:tmap[norm(h)].name,away:tmap[norm(a)].name,homeScore:hs,awayScore:as,status:existing?existing.status:m?'FINISHED':'SCHEDULED',kickoff:existing?existing.kickoff:null,apiId:existing?existing.apiId:null,manualScore:manual});if(m&&!existing)out.warnings.push('Kolo '+n+': rezultat bez API statusa tretira se kao zavrsen i rucno zasticen.');});
  }else out.warnings.push('Nedostaje list Kolo '+n+'; izvozi se prazno kolo.');
  out.rounds.push(round);
 }
 var rez=ss.getSheetByName('Rezultati');if(rez&&rez.getLastRow()>1)rez.getRange(2,1,rez.getLastRow()-1,2).getValues().forEach(function(r){if(pmap[norm(r[0])]&&r[1]!==''&&Number.isFinite(Number(r[1])))out.totals[pmap[norm(r[0])]]=Number(r[1]);});
 var text=JSON.stringify(out,null,2),base64=Utilities.base64Encode(text,Utilities.Charset.UTF_8);
 var html='<html><body style="font:15px Arial;padding:24px"><h2>KZM izvoz je spreman</h2><p>Igraci: '+out.players.length+' | Klubovi: '+out.teams.length+' | Kola: 38</p><p>Izvoz NE sadrzi PIN-ove. Nije promijenjena nijedna celija.</p><a download="kzm-izvoz.json" href="data:application/json;base64,'+base64+'">PREUZMI kzm-izvoz.json</a><p>Spremi datoteku privatno. Nemoj je poslati igracima.</p></body></html>';
 SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(510).setHeight(300),'Izvoz u novu bazu');
}
