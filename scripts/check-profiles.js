import { readdir, readFile } from 'node:fs/promises';
import { validateProfile } from '../src/profile.js';

const directory = new URL('../profiles/', import.meta.url);
for (const name of await readdir(directory)) {
  if (name.endsWith('.json')) {
    const profile = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    validateProfile(profile);
    console.log('profile valid:', name);
  }
}
