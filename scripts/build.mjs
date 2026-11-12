#!/usr/bin/env node
// Builds dist/esm (ES modules) and dist/cjs (CommonJS) from src with tsc.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

rmSync('dist', { recursive: true, force: true });
for (const project of ['tsconfig.esm.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [tsc, '-p', project], { stdio: 'inherit' });
}
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
console.log('built dist/esm and dist/cjs');
