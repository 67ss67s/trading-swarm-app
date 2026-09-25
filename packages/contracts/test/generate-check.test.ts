// R1 (docs/contracts/README.md §7): `scripts/generate.ts --check` must pass, i.e. src/generated/*
// is exactly what schema/transitions/tables would produce right now — this is what CI runs to
// catch "edited a generated file by hand" or "changed a schema without regenerating". Also checks
// that ajv has a working compiled validator for every one of the 12 schemas — if any schema or
// cross-file $ref were broken, `validators.ts`'s module-level `ajv.addSchema` loop would already
// throw at import time (failing every test in the suite), but this pins that down per schema name.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaNames, validate } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, '..');

describe('R1: generate --check', () => {
  it('scripts/generate.ts --check exits 0 (src/generated/* matches schema/transitions/tables)', () => {
    expect(() => {
      execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/generate.ts', '--check'], {
        cwd: PKG_ROOT,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});

describe('R1: ajv has a working compiled validator for every schema/*.json', () => {
  for (const name of schemaNames) {
    it(name, () => {
      // Exercises the actual compiled validator function (not just "was it registered") — a
      // broken $ref or an unresolvable schema would throw here, {} would not. common.json is the
      // one schema with no top-level `type`/`required` of its own (it's $defs only, referenced by
      // every other file) — an empty schema accepts anything, so {} correctly validates there and
      // nowhere else.
      expect(() => validate(name, {})).not.toThrow();
      expect(validate(name, {}).ok).toBe(name === 'common');
    });
  }
});
