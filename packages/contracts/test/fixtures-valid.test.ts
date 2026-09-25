// R2 (docs/contracts/README.md §7): every fixtures/<schema>/*.json must validate against
// schema/<schema>.json; every fixtures/invalid/<schema>/*.json must not. Directories are
// discovered at test-collection time, so new fixture files are picked up automatically — no
// hand-maintained list of cases here.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaNames, validate } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, '..', 'fixtures');
const INVALID_DIR = path.join(FIXTURES_DIR, 'invalid');

function jsonFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// fixtures/<name> directories that are actually per-schema fixture dirs: every schema name that
// has *some* fixtures, minus the non-schema special cases (hash vectors, the invalid/ tree).
const fixtureSchemaNames = schemaNames.filter((name) => jsonFilesIn(path.join(FIXTURES_DIR, name)).length > 0);

describe('R2: fixtures/<schema>/*.json validate', () => {
  it('found at least one schema with valid fixtures (sanity check the discovery itself)', () => {
    expect(fixtureSchemaNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureSchemaNames) {
    const dir = path.join(FIXTURES_DIR, name);
    for (const file of jsonFilesIn(dir)) {
      it(`${name}/${file} is valid`, () => {
        const value = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
        const result = validate(name, value);
        expect(result.ok, `expected valid, got errors: ${result.ok ? '' : result.errors.join('; ')}`).toBe(true);
      });
    }
  }
});

describe('R2: fixtures/invalid/<schema>/*.json do not validate', () => {
  it('found at least one schema with invalid fixtures (sanity check the discovery itself)', () => {
    const any = schemaNames.some((name) => jsonFilesIn(path.join(INVALID_DIR, name)).length > 0);
    expect(any).toBe(true);
  });

  for (const name of schemaNames) {
    const dir = path.join(INVALID_DIR, name);
    for (const file of jsonFilesIn(dir)) {
      it(`invalid/${name}/${file} is rejected`, () => {
        const value = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
        const result = validate(name, value);
        expect(result.ok, `expected this fixture to fail validation, but it passed`).toBe(false);
      });
    }
  }
});
