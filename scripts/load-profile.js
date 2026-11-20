import { readFile } from 'node:fs/promises';
import { parseDocument, visit } from 'yaml';
import { validateProfile } from '../src/profile.js';

export function parseProfile(source) {
  if (Buffer.byteLength(source) > 262_144) throw new Error('Profile exceeds 256 KiB');
  // JSON is a YAML 1.2 subset; one strict loader also catches duplicate JSON keys.
  const document = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    stringKeys: true,
    merge: false,
  });
  if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML profile');
  if (document.directives.yaml.version !== '1.2') throw new Error('Only YAML 1.2 is supported');
  visit(document, {
    Node(_key, node, path) {
      if (node.tag || node.anchor || path.length > 32)
        throw new Error('YAML tags, anchors and deep nesting are unsupported');
    },
    Alias() {
      throw new Error('YAML aliases are unsupported');
    },
  });
  return validateProfile(document.toJS({ maxAliasCount: 0 }));
}

export async function loadProfile(path) {
  return parseProfile(await readFile(path, 'utf8'));
}
