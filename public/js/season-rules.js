const normalizeName=name=>String(name??'').trim().toLowerCase().replace(/&/g,' and ').replace(/\./g,'').replace(/\s+/g,' ');

// The 2026/27 clubs in their fixed 2025/26 Premier League order, followed
// by the three promoted clubs. This is display metadata, not scoring data.
const clubs2026=[
 [57,['Arsenal','Arsenal FC']],
 [65,['Manchester City','Manchester City FC','Man City']],
 [66,['Manchester United','Manchester United FC','Manchester Utd','Man Utd','Man United']],
 [58,['Aston Villa','Aston Villa FC']],
 [64,['Liverpool','Liverpool FC']],
 [1044,['AFC Bournemouth','Bournemouth','Bournemouth FC']],
 [71,['Sunderland','Sunderland AFC']],
 [397,['Brighton & Hove Albion','Brighton and Hove Albion','Brighton','Brighton & Hove Albion FC']],
 [402,['Brentford','Brentford FC']],
 [61,['Chelsea','Chelsea FC']],
 [63,['Fulham','Fulham FC']],
 [67,['Newcastle United','Newcastle United FC','Newcastle']],
 [62,['Everton','Everton FC']],
 [341,['Leeds United','Leeds United FC','Leeds']],
 [354,['Crystal Palace','Crystal Palace FC']],
 [351,['Nottingham Forest','Nottingham Forest FC','Nottm Forest']],
 [73,['Tottenham Hotspur','Tottenham Hotspur FC','Tottenham','Spurs']],
 [1076,['Coventry City','Coventry City FC','Coventry']],
 [349,['Ipswich Town','Ipswich Town FC','Ipswich']],
 [322,['Hull City','Hull City AFC','Hull']]
].map(([apiId,names],order)=>({apiId,names,order,previousPosition:order<17?order+1:null,promoted:order>=17}));

const byApiId2026=new Map(clubs2026.map(club=>[club.apiId,club]));
const byName2026=new Map(clubs2026.flatMap(club=>club.names.map(name=>[normalizeName(name),club])));
const unranked=team=>({...team,previousPosition:null,promoted:false});

export function getSeasonClubRanking(teams,season){
 const previousSeason=Number(season)-1;
 if(Number(season)!==2026)return {previousSeason,sourceUrl:null,promotionSourceUrl:null,rows:teams.map(unranked)};
 const ordered=teams.map((team,inputOrder)=>{
  const apiId=Number(team.api_id);
  const club=Number.isInteger(apiId)&&apiId>0?byApiId2026.get(apiId):byName2026.get(normalizeName(team.name));
  return {team,club,inputOrder};
 }).sort((a,b)=>(a.club?.order??Infinity)-(b.club?.order??Infinity)||a.inputOrder-b.inputOrder);
 return {
  previousSeason,
  sourceUrl:'https://www.premierleague.com/en/tables/premier-league/2025-26',
  promotionSourceUrl:'https://www.premierleague.com/en/news/4673099/the-202627-premier-league-season-officially-starts/',
  rows:ordered.map(({team,club})=>({...team,previousPosition:club?.previousPosition??null,promoted:club?.promoted??false}))
 };
}
