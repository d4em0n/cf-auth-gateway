import { readdir } from 'node:fs/promises';
import { loadProfile } from './load-profile.js';

const directory = new URL('../profiles/', import.meta.url);
for (const name of await readdir(directory)) {
  if (/\.(json|ya?ml)$/.test(name)) {
    await loadProfile(new URL(name, directory));
    console.log('profile valid:', name);
  }
}
