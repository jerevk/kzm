import {assert,AppError,normalize} from './rules.js';
const enc=new TextEncoder();
export const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
export const unhex=s=>Uint8Array.from(s.match(/../g)||[],x=>parseInt(x,16));
export const randomHex=(n=32)=>hex(crypto.getRandomValues(new Uint8Array(n)));
export const sha256=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
export async function passwordHash(password,pepper,salt=randomHex(16),iterations=100000) {
  assert(typeof pepper==='string'&&pepper.length>=32,'Nedostaje AUTH_PEPPER konfiguracija.',503);
  const hkey=await crypto.subtle.importKey('raw',enc.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const pre=await crypto.subtle.sign('HMAC',hkey,enc.encode(password));
  const key=await crypto.subtle.importKey('raw',pre,'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:unhex(salt),iterations,hash:'SHA-256'},key,256);
  return {password_hash:hex(bits),salt,iterations};
}
export function equal(a,b) { if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false; let v=0; for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i); return v===0; }
export function sessionCookie(token,request,expiry=72*3600) { return `kzm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expiry}${new URL(request.url).protocol==='https:'?'; Secure':''}`; }
export function tokenFrom(request) { return (request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('kzm_session='))?.slice(12)||''; }
export async function authenticate(request,env) {
 const token=tokenFrom(request); if(!/^[a-f0-9]{64}$/.test(token))throw new AppError(401,'Prijavi se ponovno.');
 const u=await env.DB.prepare('SELECT p.id,p.name,p.is_admin,p.active FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token_hash=? AND s.expires_at>unixepoch() AND p.active=1').bind(await sha256(token)).first();
 assert(u,'Sesija je istekla. Prijavi se ponovno.',401); return u;
}
export function requireAdmin(u){assert(u.is_admin===1,'Nemas administratorske ovlasti.',403);}
export async function rateLimit(env,kind,key,limit=10,seconds=900){
 const now=Math.floor(Date.now()/1000),window=Math.floor(now/seconds);
 const k=await sha256(kind+':'+normalize(key)+':'+window);
 const r=await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(k,(window+1)*seconds).first();
 assert(r.count<=limit,'Previse pokusaja. Pokusaj ponovno za 15 minuta.',429);
}
export async function login(request,env,body){
 const name=normalize(body.name),password=String(body.password||'');
 assert(name.length>0&&name.length<=80&&password.length<=128,'Neispravna prijava.',401);
 await rateLimit(env,'login-ip',request.headers.get('CF-Connecting-IP')||'local',30);
 await rateLimit(env,'login-name',name,10);
 const u=await env.DB.prepare('SELECT * FROM players WHERE name_key=?').bind(name).first();
 const hash=await passwordHash(password,env.AUTH_PEPPER,u?.salt||'0'.repeat(32),u?.iterations||100000);
 assert(u && u.active===1 && equal(hash.password_hash,u.password_hash),'Pogresno ime ili lozinka.',401);
 const token=randomHex();
 await env.DB.batch([
 env.DB.prepare('DELETE FROM sessions WHERE expires_at<=unixepoch() OR (player_id=? AND created_at<unixepoch()-259200)').bind(u.id),
 env.DB.prepare('INSERT INTO sessions(token_hash,player_id,expires_at) VALUES(?,?,unixepoch()+259200)').bind(await sha256(token),u.id)
 ]);
 return {user:{id:u.id,name:u.name,admin:u.is_admin===1},cookie:sessionCookie(token,request)};
}
