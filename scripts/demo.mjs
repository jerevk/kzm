/** Local-only disposable demo. Never deployed; mock accounts are NOT production seeds. */
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import worker from '../src/worker.js';import {fresh,ADMIN_PASSWORD} from '../tests/helpers.mjs';
import {root} from './common.mjs';
const {env}=await fresh();env.PROJECT_ID='local-test';
env.ASSETS={fetch:async request=>{
 let route=new URL(request.url).pathname;let file=route==='/'?'index.html':decodeURIComponent(route.slice(1));
 if(file.includes('..')||file.startsWith('_'))return new Response('Not found',{status:404});
 const target=path.join(root,'public',file);if(!fs.existsSync(target)||!fs.statSync(target).isFile())return new Response('Not found',{status:404});
 const mime=file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webmanifest')?'application/manifest+json':'text/html; charset=utf-8';
 return new Response(fs.readFileSync(target),{headers:{'Content-Type':mime,'Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; object-src 'none'"}});
}};
const port=Number(process.env.PORT||8788);
const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const request=new Request(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body}: {})});const response=await worker.fetch(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500);res.end(String(e));}});
server.listen(port,'127.0.0.1',()=>console.log(`LOKALNA DEMONSTRACIJA - izmisljeni podaci, nestaju nakon prekida\nhttp://127.0.0.1:${port}\nIme: Demo Admin\nLozinka: ${ADMIN_PASSWORD}\nDrugi igrac: Demo Player / Demo-only-Player-2026!\nCtrl+C za prekid. Nema vanjskih poziva ni stvarnih podataka.`));
