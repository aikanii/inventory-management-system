import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../src/db/migrations');
const out = resolve(here, '../dist/db/migrations');

mkdirSync(out, { recursive: true });
const files = readdirSync(src).filter((f) => f.endsWith('.sql'));
for (const f of files) {
  copyFileSync(join(src, f), join(out, f));
}
console.log(`copied ${files.length} migration(s) to dist/db/migrations`);
