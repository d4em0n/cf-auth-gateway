import test from 'node:test';
import assert from 'node:assert/strict';
import profile from '../profiles/example.json' with {type:'json'};
import {createGateway} from '../src/engine.js';
import {validateProfile,requestPath,routeAccess} from '../src/profile.js';
import {extractCredential,credentialKey} from '../src/credentials.js';
const mem=new Map();
const env={ORIGIN_URL:'https://origin.example.net/',HMAC_SECRET:'test-only-32-character-secret-xxxxxxxxx',RECOGNIZED:{async get(k){return mem.get(k)??null},async put(k,v){mem.set(k,v);}}};
let count=0,valid=true;
globalThis.fetch=async req=>{
 const path=new URL(typeof req==='string'?req:req.url).pathname;
 if(path==='/api/auth/me'){count++;return Response.json(valid?{user:{id:'a'}}:{},{status:valid?200:401});}
 return Response.json({ok:true});
};
const run=createGateway(profile),req=(path,headers={})=>new Request('https://chat.example.com'+path,{headers});
test('profile rejects overly broad public prefix',()=>assert.throws(()=>validateProfile({...profile,routes:[{access:'public',methods:['GET'],prefix:['/']}]})));
test('public login and static, private default',()=>{
 assert.equal(routeAccess(profile,'GET','/login'),'public');
 assert.equal(routeAccess(profile,'GET','/assets/a.js'),'public');
 assert.equal(routeAccess(profile,'GET','/api/secrets'),'protected');
});
test('reject encoded path ambiguity',()=>{for(const p of ['/assets/%2fsecret','/assets/%5csecret','/assets//secret'])assert.equal(requestPath('https://chat.example.com'+p),null);});
test('public request without token',async()=>assert.equal((await run(req('/login'),env)).status,200));
test('private endpoint denies missing credential',async()=>assert.equal((await run(req('/api/secret'),env)).status,401));
test('unknown valid credential is verified once and recognized',async()=>{
 mem.clear();count=0;valid=true;const r=req('/api/secret',{Authorization:'Bearer token1'});
 assert.equal((await run(r,env)).status,200);
 valid=false;assert.equal((await run(r,env)).status,200);
 assert.equal(count,1);
});
test('unknown invalid credential is denied',async()=>{
 valid=false;assert.equal((await run(req('/api/secret',{Authorization:'Bearer invalid'}),env)).status,401);
});
test('ambiguous bearer and cookie denied',async()=>assert.equal(extractCredential(req('/api/secret',{Authorization:'Bearer a',Cookie:'session=b'}),profile).error,true));
test('fingerprints are keyed and epoch scoped',async()=>{
 const c={scheme:profile.credentials[0],value:'secretToken'};
 const k=await credentialKey(c,profile,env.HMAC_SECRET);
 assert.equal(k.includes('secretToken'),false);
 assert.notEqual(k,await credentialKey(c,{...profile,epoch:2},env.HMAC_SECRET));
});
test('unknown hosts rejected',async()=>assert.equal((await run(new Request('https://elsewhere.example/login'),env)).status,421));
