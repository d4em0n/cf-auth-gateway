export function extractCredential(req,profile){
 const auth=req.headers.get('Authorization'),cookies=req.headers.get('Cookie')??'',found=[];
 if(auth&&!/^Bearer [A-Za-z0-9._~+\/-]+=*$/i.test(auth))return {error:true};
 for(const c of profile.credentials){
  if(c.type==='bearer'&&auth)found.push({scheme:c,value:auth.slice(7)});
  if(c.type==='cookie'){
   const matches=cookies.split(';').map(x=>x.trim()).filter(x=>x.startsWith(c.name+'='));
   if(matches.length>1)return {error:true};
   if(matches.length)found.push({scheme:c,value:matches[0].slice(c.name.length+1)});
  }
 }
 if(found.length>1)return {error:true};
 const result=found[0];return result&&result.value&&result.value.length<=8192&&!/[\r\n]/.test(result.value)?result:null;
}
export async function credentialKey(c,p,secret){
 if(typeof secret!=='string'||secret.length<32)throw Error('invalid HMAC_SECRET');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode([p.id,p.epoch,c.scheme.id,c.value].join('\0')));
 return ['seen','v1',p.id,p.epoch,c.scheme.id,Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('')].join(':');
}
