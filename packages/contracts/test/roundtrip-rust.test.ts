// R4 (docs/contracts/README.md §7): Rust builds one "every field populated" instance per record
// kind and writes it to <repo-root>/target/roundtrip/<schema>/*.json (`cargo test -p contracts-rs
// -- --ignored emit_roundtrip`); this validates each of those against schema/<schema>.json with
// ajv — additionalProperties:false is what would catch a field Rust emits that the schema (and TS)
// don't know about. If the directory doesn't exist yet (Rust side hasn't produced it), every case
// here is skipped rather than silently absent — see the printed notice.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaNames, validate } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..', '..');
const ROUNDTRIP_DIR = path.join(REPO_ROOT, 'target', 'roundtrip');

const roundtripDirExists = existsSync(ROUNDTRIP_DIR);

if (!roundtripDirExists) {
  console.log(
    `[R4] SKIPPED: ${ROUNDTRIP_DIR} does not exist yet (Rust hasn't run \`cargo test -p contracts-rs -- --ignored emit_roundtrip\`). ` +
      `Nothing to check here until that directory exists — see docs/contracts/README.md §7 R4.`,
  );
}

describe('R4: target/roundtrip/<schema>/*.json (Rust "every field" instances) validate', () => {
  for (const name of schemaNames) {
    const dir = path.join(ROUNDTRIP_DIR, name);
    const files = roundtripDirExists && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];

    if (!roundtripDirExists) {
      it.skip(`${name}: (skipped — target/roundtrip does not exist)`, () => {});
      continue;
    }
    if (files.length === 0) {
      it.skip(`${name}: (skipped — no *.json under target/roundtrip/${name})`, () => {});
      continue;
    }
    for (const file of files) {
      it(`${name}/${file}`, () => {
        const value = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
        const result = validate(name, value);
        expect(result.ok, `Rust-emitted instance failed ajv (likely a field TS/schema don't know about): ${result.ok ? '' : result.errors.join('; ')}`).toBe(
          true,
        );
      });
    }
  }
});
