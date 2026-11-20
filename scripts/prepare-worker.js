import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateProfile } from '../src/profile.js';

const source = process.argv[2] ?? process.env.GATEWAY_PROFILE ?? 'profiles/example.json';
const profile = JSON.parse(await readFile(resolve(source), 'utf8'));
if (process.env.GATEWAY_HOSTNAME) profile.hostname = process.env.GATEWAY_HOSTNAME;
validateProfile(profile);
await mkdir('.generated', { recursive: true });
await writeFile(
  '.generated/worker.js',
  [
    "import { createGateway } from '../src/gateway.js';",
    `const handle = createGateway(${JSON.stringify(profile, null, 2)});`,
    'export default { fetch: handle };',
    '',
  ].join('\n'),
);
console.log(
  'Prepared profile:',
  profile.id,
  'epoch:',
  profile.epoch,
  'hostname:',
  profile.hostname,
);
