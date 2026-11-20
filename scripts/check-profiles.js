import {readdir,readFile} from 'node:fs/promises';
import {validateProfile} from '../src/profile.js';
for(const name of await readdir(new URL('../profiles/',import.meta.url))){
 if(name.endsWith('.json')){validateProfile(JSON.parse(await readFile(new URL('../profiles/'+name,import.meta.url),'utf8')));console.log('profile valid:',name);}
}
