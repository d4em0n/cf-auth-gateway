const exactKeys=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('unsupported configuration property');};
const safePath=p=>typeof p==='string'&&/^\/[A-Za-z0-9/_-]*$/.test(p)&&!p.includes('//')&&!p.includes('/../')&&!p.includes('/./');
export function validateProfile(p){
 exactKeys(p,['schemaVersion','id','hostname','epoch','routes','credentials','retentionDays','validationTimeoutMs']);
 if(p.schemaVersion!==1||!Number.isInteger(p.epoch)||p.epoch<1||!/^[a-z][a-z0-9-]*$/.test(p.id)||!/^[a-z0-9.-]+$/.test(p.hostname))throw Error('invalid profile identity');
 if(!Number.isInteger(p.retentionDays)||p.retentionDays<1||p.retentionDays>90||!Number.isInteger(p.validationTimeoutMs)||p.validationTimeoutMs<100||p.validationTimeoutMs>10000)throw Error('invalid limits');
 if(!Array.isArray(p.routes)||p.routes.length>100)throw Error('invalid routes');
 for(const r of p.routes){
  exactKeys(r,['access','methods','exact','prefix','rateLimit']);
  if(!['public','auth_flow'].includes(r.access)||!Array.isArray(r.methods)||!r.methods.length||r.methods.some(m=>!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(m)))throw Error('invalid route');
  if(!(r.exact?.length||r.prefix?.length))throw Error('empty route');
  if(r.rateLimit!==undefined&&(r.access!=='auth_flow'||typeof r.rateLimit!=='boolean'))throw Error('invalid route rate limit');
  for(const x of r.exact??[])if(!safePath(x)||(x!=='/'&&x.endsWith('/')))throw Error('invalid exact path');
  for(const x of r.prefix??[])if(!safePath(x)||x==='/'||!x.endsWith('/'))throw Error('invalid prefix');
 }
 if(!Array.isArray(p.credentials)||!p.credentials.length||p.credentials.length>4)throw Error('invalid credentials');
 const ids=new Set();
 for(const c of p.credentials){
  exactKeys(c,['id','type','name','validation']);
  if(!/^[a-z][a-z0-9-]*$/.test(c.id)||ids.has(c.id)||!['bearer','cookie'].includes(c.type))throw Error('invalid credential');
  ids.add(c.id);
  if(c.type==='cookie'&&!/^[a-zA-Z0-9_-]+$/.test(c.name)||c.type==='bearer'&&c.name!==undefined)throw Error('invalid cookie name');
  exactKeys(c.validation,['method','path','jsonPath']);
  if(!['GET','POST'].includes(c.validation.method)||!safePath(c.validation.path)||!/^\w+(?:\.\w+){0,5}$/.test(c.validation.jsonPath))throw Error('invalid validation');
 }
 return p;
}
export function requestPath(url){
 const raw=url.split('?')[0].replace(/^https?:\/\/[^/]+/i,'');
 if(/%(?:2e|2f|5c|25|00)/i.test(raw)||/\\|\/\//.test(raw)||/\/(?:\.|\.\.)(?:\/|$)/.test(raw))return null;
 let p;try{p=new URL(url).pathname;}catch{return null;}
 return /^\/[\w.\-/%]*$/.test(p)?p:null;
}
export function routeRule(profile,method,path){
 if(!path)return {access:'deny'};
 for(const r of profile.routes)if(r.methods.includes(method)&&(r.exact?.includes(path)||r.prefix?.some(x=>path.startsWith(x))))return r;
 return {access:'protected'};
}
export function routeAccess(profile,method,path){return routeRule(profile,method,path).access;}
