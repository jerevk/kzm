/** League rules ported from the supplied Core/WebApp files; no guessed club weights. */
export const CYCLES = [{id:1,from:1,to:10},{id:2,from:11,to:19},{id:3,from:20,to:28},{id:4,from:29,to:38}];
export function cycleFor(n) { return CYCLES.find(c => n >= c.from && n <= c.to)?.id || 0; }
export function normalize(s) { return String(s ?? '').normalize('NFC').trim().toLowerCase().replace(/&/g,'and').replace(/\./g,'').replace(/\s+/g,' '); }
export function scorePick(base, home, hs, as, double=false) {
  if (hs === null || as === null || hs === undefined || as === undefined) return null;
  if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0) return null;
  let points = home ? (hs > as ? base : 0) : (as > hs ? base + 1 : as === hs ? 1 : 0);
  return points * (double ? 2 : 1);
}
export function rank(rows) {
  rows.sort((a,b) => b.points - a.points || a.name.localeCompare(b.name,'hr'));
  let previous = null, place = 0;
  return rows.map((r,i) => { if (previous !== r.points) place=i+1; previous=r.points; return {...r,place}; });
}
export class AppError extends Error { constructor(status,message) { super(message); this.status=status; } }
export function assert(ok,message,status=400) { if (!ok) throw new AppError(status,message); }
export function integer(v,min,max,label) { assert(Number.isInteger(v) && v>=min && v<=max,`Neispravno: ${label}.`); return v; }
export function cleanName(v) { assert(typeof v==='string','Upisi ime.'); const s=v.normalize('NFC').trim().replace(/\s+/g,' '); assert(s.length>=2&&s.length<=80&&!/[\u0000-\u001f]/.test(s),'Ime mora imati 2-80 znakova.'); return s; }
export function passwordValid(v,admin=false) { assert(typeof v==='string' && v.length >= (admin?12:8) && v.length<=128,`Lozinka mora imati ${admin?12:8}-128 znakova.`); return v; }
export function pinValid(v) { assert(typeof v==='string' && (/^\d{4,12}$/.test(v) || (v.length>=8 && v.length<=128)),'PIN mora imati 4-12 znamenki.'); return v; }
export function scopeRange(v) { if(v==='all'||!v) return {from:1,to:38}; const c=CYCLES.find(x=>String(x.id)===String(v)); assert(c,'Neispravan krug.'); return c; }
