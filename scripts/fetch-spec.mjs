#!/usr/bin/env node
// Saves the OpenAPI document of a running Prefect server to openapi.json.
//
//   prefect server start
//   npm run spec                                  (uses http://127.0.0.1:4200/api)
//   PREFECT_API_URL=http://host:4200/api npm run spec

import { writeFileSync } from 'node:fs';

const apiUrl = (process.env.PREFECT_API_URL ?? 'http://127.0.0.1:4200/api').replace(/\/+$/, '');
const [output = 'openapi.json'] = process.argv.slice(2);

const response = await fetch(`${apiUrl}/openapi.json`);
if (!response.ok) {
  console.error(`GET ${apiUrl}/openapi.json returned ${response.status}`);
  process.exit(1);
}
const spec = await response.json();
const version = await fetch(`${apiUrl}/admin/version`).then((r) => (r.ok ? r.json() : 'unknown'));
writeFileSync(output, JSON.stringify(spec, null, 2) + '\n');
console.log(`saved ${Object.keys(spec.paths).length} paths from Prefect ${version} to ${output}`);
