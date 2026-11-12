// Checks the built package: both module formats load, export the same names and
// work without any runtime dependency. `npm test` builds dist before this runs.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const require = createRequire(import.meta.url);

describe('package', () => {
  test('has no runtime dependencies', () => {
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.peerDependencies, undefined);
  });

  test('is MIT licensed with a LICENSE file', () => {
    assert.equal(pkg.license, 'MIT');
    assert.match(readFileSync(new URL('LICENSE', root), 'utf8'), /^MIT License/);
  });

  test('export map files exist', () => {
    for (const target of [
      pkg.exports['.'].import.default,
      pkg.exports['.'].import.types,
      pkg.exports['.'].require.default,
      pkg.exports['.'].require.types,
    ]) {
      assert.ok(existsSync(new URL(target, root)), target);
    }
  });

  test('CommonJS and ESM builds export the same names', async () => {
    const cjs = require('../dist/cjs/index.js');
    const esm = await import('../dist/esm/index.js');
    assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).filter((k) => k !== 'default').sort());
    assert.equal(typeof cjs.PrefectClient, 'function');
  });

  test('the CommonJS build runs a request', async () => {
    const { PrefectClient } = require('../dist/cjs/index.js');
    const client = new PrefectClient({ apiUrl: 'http://h/api', fetch: async () => new Response('"3.9.2"') });
    assert.equal(await client.serverVersion(), '3.9.2');
  });

  test('the ESM build runs a request', async () => {
    const { PrefectClient } = await import('../dist/esm/index.js');
    const client = new PrefectClient({ apiUrl: 'http://h/api', fetch: async () => new Response('true') });
    assert.equal(await client.health(), true);
  });

  test('the version constant matches package.json', async () => {
    const { VERSION } = await import('../src/index.ts');
    assert.equal(VERSION, pkg.version);
  });

  test('src imports nothing from node built-ins', () => {
    const files = ['client.ts', 'errors.ts', 'http.ts', 'index.ts', 'pagination.ts', 'types.ts'];
    for (const file of files) {
      const text = readFileSync(new URL(`src/${file}`, root), 'utf8');
      assert.doesNotMatch(text, /from 'node:/, file);
    }
  });
});
