import {validateProfile,routeRule,requestPath} from './profile.js';
import {extractCredential,credentialKey} from './credentials.js';

const error=(status,msg)=>new Response(msg,{status,headers:{'Cache-Control':'no-store'}});

function originFor(env,profile){
 const u=new URL(env.ORIGIN_URL);
 if(u.protocol!=='https:'||u.hostname===profile.hostname||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('unsafe ORIGIN_URL');
 return u;
}

function headersFor(req,env){
 const h=new Headers(req.headers);
 h.delete('x-cf-auth-gateway-secret');
 h.delete('x-cf-auth-gateway-user');
 if(env.ORIGIN_GATEWAY_SECRET)h.set('x-cf-auth-gateway-secret',env.ORIGIN_GATEWAY_SECRET);
 return h;
}

// WebSocket 101 responses carry a special .webSocket property; they cannot be
// reconstructed with new Response(body, {status: 101}).
async function proxy(req,env,origin,isWebSocket=false){
 const url=new URL(req.url);url.protocol=origin.protocol;url.host=origin.host;
 const forward=new Request(url,{
  method:req.method,headers:headersFor(req,env),
  body:['GET','HEAD'].includes(req.method)?undefined:req.body,
  redirect:'manual'
 });
 const r=await fetch(forward,{redirect:'manual'});
 if(r.status===101){
  if(!isWebSocket||!r.webSocket)return error(502,'Invalid WebSocket upgrade');
  return r; // Cloudflare proxies the WebSocket without intercepting its messages.
 }
 const h=new Headers(r.headers);h.set('Cache-Control','private, no-store');
 return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
}

async function rateDecision(req,env,binding,profile){
 const limiter=env[binding],ip=req.headers.get('CF-Connecting-IP');
 // This gateway is meant to run behind Cloudflare, which supplies the client IP.
 if(!limiter?.limit||!ip||ip.length>64||!/^[0-9a-fA-F:.]+$/.test(ip))return 'unavailable';
 try{
  const {success}=await limiter.limit({key:profile.id+':'+ip});
  return success?'allow':'limited';
 }catch{return 'unavailable';}
}

async function validate(c,p,env,origin){
 const rule=c.scheme.validation,headers=new Headers({Accept:'application/json'});
 if(c.scheme.type==='bearer')headers.set('Authorization','Bearer '+c.value);
 else headers.set('Cookie',c.scheme.name+'='+c.value);
 if(env.ORIGIN_GATEWAY_SECRET)headers.set('x-cf-auth-gateway-secret',env.ORIGIN_GATEWAY_SECRET);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),p.validationTimeoutMs);
 try{
  const res=await fetch(new URL(rule.path,origin),{
   method:rule.method,headers,redirect:'manual',signal:controller.signal
  });
  if(res.status===401||res.status===403)return 'invalid';
  if(res.status!==200)return 'unavailable';
  if(!(res.headers.get('content-type')??'').toLowerCase().includes('application/json'))return 'invalid';
  if(Number(res.headers.get('content-length'))>16384)return 'invalid';
  const reader=res.body?.getReader();if(!reader)return 'invalid';
  const chunks=[];let length=0;
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   length+=value.byteLength;
   if(length>16384){await reader.cancel();return 'invalid';}
   chunks.push(value);
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let obj;try{obj=JSON.parse(new TextDecoder().decode(bytes));}catch{return 'invalid';}
  const field=rule.jsonPath.split('.').reduce((x,k)=>
   x&&typeof x==='object'&&Object.hasOwn(x,k)?x[k]:undefined,obj);
  return typeof field==='string'&&field.trim()?'valid':'invalid';
 }catch{return 'unavailable';}finally{clearTimeout(timer);}
}

export function createGateway(input){
 const p=validateProfile(input);
 return async(req,env)=>{
  try{
   const origin=originFor(env,p);
   if(new URL(req.url).hostname.toLowerCase()!==p.hostname)return error(421,'Unknown host');
   const upgrade=req.headers.get('Upgrade');
   const isWebSocket=upgrade?.trim().toLowerCase()==='websocket';
   if(upgrade&&!isWebSocket)return error(400,'Unsupported protocol upgrade');
   if(isWebSocket&&req.method!=='GET')return error(400,'Invalid WebSocket method');
   const route=routeRule(p,req.method,requestPath(req.url));
   if(route.access==='deny')return error(400,'Invalid path');

   // An Upgrade on a public HTML/assets path must not automatically gain
   // a public WebSocket. Require a recognized cookie/bearer credential.
   if(!isWebSocket&&(route.access==='public'||route.access==='auth_flow')){
    if(route.rateLimit){
     const decision=await rateDecision(req,env,'AUTH_FLOW_LIMITER',p);
     if(decision!=='allow')return decision==='limited'
      ?error(429,'Too many authentication attempts')
      :error(503,'Rate limiter unavailable');
    }
    return await proxy(req,env,origin);
   }

   const c=extractCredential(req,p);
   if(!c||c.error)return error(401,'Authentication required');
   const key=await credentialKey(c,p,env.HMAC_SECRET);
   let known=null;
   try{known=await env.RECOGNIZED.get(key);}catch{}
   if(!known){
    const decision=await rateDecision(req,env,'UNKNOWN_LIMITER',p);
    if(decision!=='allow')return decision==='limited'
     ?error(429,'Too many credential checks')
     :error(503,'Rate limiter unavailable');
    const status=await validate(c,p,env,origin);
    if(status==='invalid')return error(401,'Invalid credential');
    if(status!=='valid')return error(503,'Validation unavailable');
    try{
     await env.RECOGNIZED.put(key,'1',{expirationTtl:p.retentionDays*86400});
    }catch{}
   }
   return await proxy(req,env,origin,isWebSocket);
  }catch{return error(503,'Gateway unavailable');}
 };
}
