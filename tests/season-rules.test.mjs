import test from 'node:test';
import assert from 'node:assert/strict';
import {getSeasonClubRanking} from '../public/js/season-rules.js';

const officialIds=[57,65,66,58,64,1044,71,397,402,61,63,67,62,341,354,351,73,1076,349,322];

test('The previous-season order is fixed even when input, display names and base points change',()=>{
 const teams=officialIds.map((api_id,index)=>({id:`team-${index}`,api_id,name:'Same display name',base:100-index})).reverse();
 const result=getSeasonClubRanking(teams,2026);
 assert.deepEqual(result.rows.map(team=>team.api_id),officialIds);
 assert.deepEqual(result.rows.slice(0,17).map(team=>team.previousPosition),Array.from({length:17},(_,i)=>i+1));
 for(const row of result.rows)assert.equal(row.base,teams.find(team=>team.id===row.id).base);
 assert.equal(result.previousSeason,2025);
 assert.equal(result.sourceUrl,'https://www.premierleague.com/en/tables/premier-league/2025-26');
});

test('Promoted clubs follow the retained clubs without fabricated previous Premier League positions',()=>{
 const teams=[{api_id:322,name:'Hull',base:7},{api_id:73,name:'Tottenham',base:6},{api_id:349,name:'Ipswich',base:7},{api_id:1076,name:'Coventry',base:7}];
 const result=getSeasonClubRanking(teams,'2026');
 assert.deepEqual(result.rows.map(team=>team.api_id),[73,1076,349,322]);
 assert.equal(result.rows[0].previousPosition,17);
 assert.equal(result.rows[0].promoted,false);
 for(const newcomer of result.rows.slice(1)){assert.equal(newcomer.previousPosition,null);assert.equal(newcomer.promoted,true);assert.equal(newcomer.base,7);}
 assert.equal(result.promotionSourceUrl,'https://www.premierleague.com/en/news/4673099/the-202627-premier-league-season-officially-starts/');
});

test('Ranking returns copies and leaves supplied team records and their order untouched',()=>{
 const teams=Object.freeze([Object.freeze({id:'city',api_id:65,name:'Manchester City',base:3,active:true}),Object.freeze({id:'arsenal',api_id:57,name:'Arsenal',base:3,active:false})]);
 const before=structuredClone(teams);
 const result=getSeasonClubRanking(teams,2026);
 assert.deepEqual(teams,before);
 assert.notStrictEqual(result.rows[0],teams[1]);
 assert.equal(result.rows[0].active,false);
 result.rows[0].base=99;
 assert.equal(teams[1].base,3);
 assert.equal(Object.hasOwn(teams[1],'previousPosition'),false);
});

test('Explicit club aliases identify missing IDs while a supplied API ID takes precedence',()=>{
 const teams=[
  {id:'brighton',name:' Brighton & Hove Albion ',base:4},
  {id:'united',api_id:null,name:'Manchester Utd',base:3},
  {id:'bournemouth',api_id:'',name:'AFC Bournemouth',base:4},
  {id:'city',api_id:'65',name:'Arsenal',base:3},
  {id:'hull',api_id:0,name:'Hull City AFC',base:7},
  {id:'unknown-id',api_id:999999,name:'Arsenal',base:9}
 ];
 const rows=getSeasonClubRanking(teams,2026).rows;
 assert.deepEqual(rows.map(team=>team.id),['city','united','bournemouth','brighton','hull','unknown-id']);
 assert.deepEqual(rows.map(team=>team.previousPosition),[2,3,6,8,null,null]);
 assert.deepEqual(rows.map(team=>team.promoted),[false,false,false,false,true,false]);
});

test('Unknown clubs and seasons retain their actual data without borrowing a historical position',()=>{
 const teams=[{api_id:80001,name:'Unknown One',base:12},{api_id:57,name:'Arsenal',base:3},{name:'Unknown Two',base:15}];
 const known=getSeasonClubRanking(teams,2026);
 assert.deepEqual(known.rows.map(team=>team.name),['Arsenal','Unknown One','Unknown Two']);
 for(const row of known.rows.slice(1)){assert.equal(row.previousPosition,null);assert.equal(row.promoted,false);}
 const unknown=getSeasonClubRanking(teams,2027);
 assert.equal(unknown.previousSeason,2026);
 assert.equal(unknown.sourceUrl,null);
 assert.equal(unknown.promotionSourceUrl,null);
 assert.deepEqual(unknown.rows,teams.map(team=>({...team,previousPosition:null,promoted:false})));
 assert.notStrictEqual(unknown.rows[0],teams[0]);
});
