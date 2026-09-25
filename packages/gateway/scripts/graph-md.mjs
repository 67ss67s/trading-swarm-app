// Regenerates docs/demo/graph.md from the judgment graph (run after `npm run build`): `npm run graph:md --workspace packages/gateway`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { graphMarkdown, validateGraph } from '../dist/demo/graph.js';

const errors = validateGraph();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/demo/graph.md');
writeFileSync(out, graphMarkdown());
console.log(`wrote ${out}`);
