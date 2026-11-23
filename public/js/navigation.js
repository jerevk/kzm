const STATE_KEY='kzmNavigation';
const ROUTE_FIELDS=['view','selectedSeason','round','cycle','scope','archiveScope'];
const defaultKey=()=>globalThis.crypto?.randomUUID?.()||`nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const validKey=key=>typeof key==='string'&&key.length>0&&key.length<=128;
const validEntry=entry=>entry&&typeof entry==='object'&&entry.version===1&&validKey(entry.key)&&Number.isSafeInteger(entry.index)&&entry.index>=0&&entry.index<Number.MAX_SAFE_INTEGER;

/** Same-document navigation only: route snapshots never contain forms or API data. */
export function createNavigation({history,normalizeRoute,onRestore=()=>{},onChange=()=>{},makeKey=defaultKey}){
 let active=false,key='',index=0,current=null,fallback=null;
 const copy=route=>Object.fromEntries(ROUTE_FIELDS.map(field=>[field,route[field]]));
 const normalize=route=>copy(normalizeRoute(route));
 const same=(a,b)=>!!a&&!!b&&ROUTE_FIELDS.every(field=>a[field]===b[field]);
 const merged=entry=>{
  const previous=history.state;
  const next=previous&&typeof previous==='object'&&!Array.isArray(previous)?{...previous}:{};
  if(entry)next[STATE_KEY]=entry;else delete next[STATE_KEY];
  return next;
 };
 const entry=()=>({version:1,key,index,route:copy(current)});
 const canGoBack=()=>active&&index>0;
 const changed=()=>onChange(canGoBack());
 return {
  start(fallbackRoute,{restore=true}={}){
   fallback=normalize(fallbackRoute);
   const saved=history.state?.[STATE_KEY];
   if(restore&&validEntry(saved)){
    key=saved.key;index=saved.index;current=normalize(saved.route);
   }else{
    const candidate=makeKey();key=validKey(candidate)?candidate:defaultKey();index=0;current=copy(fallback);
   }
   active=true;
   history.replaceState(merged(entry()),'');
   changed();
   return copy(current);
  },
  record(route){
   if(!active)return false;
   const next=normalize(route);
   if(same(current,next))return false;
   current=next;index++;
   history.pushState(merged(entry()),'');
   changed();
   return true;
  },
  async handlePop(state){
   if(!active)return false;
   const saved=state?.[STATE_KEY];
   if(validEntry(saved)&&saved.key===key){
    index=saved.index;current=normalize(saved.route);
   }else{
    index=0;current=copy(fallback);
   }
   // Canonicalize this entry without adding a guard or moving history forward.
   history.replaceState(merged(entry()),'');
   changed();
   await onRestore(copy(current));
   return true;
  },
  back(){
   if(!canGoBack())return false;
   history.back();
   return true;
  },
  stop(){
   active=false;key='';index=0;current=null;fallback=null;
   if(history.state&&typeof history.state==='object'&&Object.hasOwn(history.state,STATE_KEY))history.replaceState(merged(null),'');
   changed();
  },
  canGoBack
 };
}
