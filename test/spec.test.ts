// Checks every request the client can send against the OpenAPI document of the server
// (openapi.json, saved from `prefect server start`), so a typo in a path, a method or a
// body field fails here instead of at runtime.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { collect, type PrefectClient } from '../src/index.ts';
import { json, mockClient, type RecordedCall } from './helpers.ts';

interface Operation {
  parameters?: { name: string; in: string }[];
  requestBody?: { content: { 'application/json': { schema: Schema } } };
}
interface Schema {
  $ref?: string;
  type?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  anyOf?: Schema[];
}

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

const templates = Object.keys(spec.paths).map((template) => ({
  template,
  regex: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
}));

function findOperation(call: RecordedCall): { template: string; operation: Operation } | undefined {
  const method = call.method.toLowerCase();
  // Prefer a literal match ("/flows/count") over a template ("/flows/{id}").
  const matches = templates.filter((t) => t.regex.test(call.url.pathname.replace(/^\/api/, '')) && spec.paths[t.template]?.[method]);
  matches.sort((a, b) => (a.template.match(/\{/g)?.length ?? 0) - (b.template.match(/\{/g)?.length ?? 0));
  const best = matches[0];
  return best ? { template: best.template, operation: spec.paths[best.template]![method]! } : undefined;
}

function resolve(schema: Schema | undefined): Schema | undefined {
  if (!schema) return undefined;
  if (schema.$ref) return resolve(spec.components.schemas[schema.$ref.split('/').pop()!]);
  return schema;
}

function bodyKeys(call: RecordedCall): string[] {
  const body = Array.isArray(call.body) ? call.body[0] : call.body;
  return body && typeof body === 'object' ? Object.keys(body) : [];
}

function allowedKeys(operation: Operation): Set<string> | 'any' {
  let schema = resolve(operation.requestBody?.content['application/json'].schema);
  if (schema?.type === 'array') schema = resolve(schema.items);
  if (!schema?.properties) return 'any';
  return new Set(Object.keys(schema.properties));
}

/** Calls every public method once with a plausible argument set. */
async function exerciseEverything(client: PrefectClient) {
  const c = client;
  await c.health();
  await c.ready();
  await c.serverVersion();
  await c.apiVersion();

  await c.flows.create({ name: 'f' });
  await c.flows.get('id');
  await c.flows.getByName('f');
  await c.flows.update('id', { tags: [] });
  await c.flows.delete('id');
  await c.flows.list({ flows: { name: { any_: ['f'] } }, sort: 'NAME_ASC', limit: 1, offset: 0 });
  await c.flows.count({ flows: {} });
  await c.flows.page({ page: 1, limit: 1 });
  await collect(c.flows.iterate({}, { max: 1 }));

  await c.deployments.create({ name: 'd', flow_id: 'f' });
  await c.deployments.get('id');
  await c.deployments.getByName('f/d');
  await c.deployments.update('id', { description: 'x' });
  await c.deployments.delete('id');
  await c.deployments.list({ deployments: {}, limit: 1 });
  await c.deployments.count({ deployments: {} });
  await c.deployments.page({ page: 1 });
  await c.deployments.createFlowRun('id', { parameters: { x: 1 }, tags: ['t'], name: 'n', job_variables: {} });
  await c.deployments.pause('id');
  await c.deployments.resume('id');
  await c.deployments.schedules('id');

  await c.flowRuns.create({ flow_id: 'f', parameters: {} });
  await c.flowRuns.get('id');
  await c.flowRuns.update('id', { name: 'n' });
  await c.flowRuns.delete('id');
  await c.flowRuns.list({ flow_runs: {}, sort: 'START_TIME_DESC', limit: 1 });
  await c.flowRuns.count({ flow_runs: {} });
  await c.flowRuns.page({ page: 1 });
  await c.flowRuns.setState('id', { type: 'RUNNING' }, { force: true });
  await c.flowRuns.cancel('id', { message: 'm' });
  await c.flowRuns.resume('id', { a: 1 });
  await c.flowRuns.states('id');
  await c.flowRuns.logs('id', { limit: 1, sort: 'TIMESTAMP_DESC' });
  await c.flowRuns.downloadLogs('id');
  await c.flowRuns.taskRuns('id');

  await c.taskRuns.get('id');
  await c.taskRuns.list({ task_runs: {}, limit: 1 });
  await c.taskRuns.count({ task_runs: {} });
  await c.taskRuns.page({ page: 1 });
  await c.taskRuns.states('id');

  await c.logs.list({ logs: {}, limit: 1 });
  await c.logs.create([{ name: 'n', level: 20, message: 'm', timestamp: '2026-01-01T00:00:00Z', flow_run_id: 'id' }]);

  await c.workPools.get('p');
  await c.workPools.list({ work_pools: {}, limit: 1 });
  await c.workPools.count({ work_pools: {} });
  await c.workPools.create({ name: 'p', type: 'process' });
  await c.workPools.delete('p');
  await c.workPools.queues('p', { work_queues: {}, limit: 1 });
  await c.workPools.queue('p', 'q');
  await c.workQueues.get('id');
  await c.workQueues.getByName('q');
  await c.workQueues.list({ work_queues: {}, limit: 1 });
  await c.workQueues.status('id');

  await c.variables.create({ name: 'v', value: 1, tags: [] });
  await c.variables.get('id');
  await c.variables.getByName('v');
  await c.variables.update('id', { value: 2 });
  await c.variables.updateByName('v', { value: 2 });
  await c.variables.delete('id');
  await c.variables.deleteByName('v');
  await c.variables.list({ variables: {}, limit: 1 });
  await c.variables.count({ variables: {} });

  await c.blocks.get('id', { includeSecrets: true });
  await c.blocks.getByName('secret/b', undefined, { includeSecrets: false });
  await c.blocks.list({ block_documents: {}, include_secrets: false, limit: 1 });
  await c.blocks.count({ block_documents: {} });
  await c.blocks.listByType('secret', { includeSecrets: false });
  await c.blocks.types({ block_types: {}, limit: 1 });
  await c.blocks.type('secret');
  await c.blocks.schemas({ block_schemas: {}, limit: 1 });
  await c.blocks.schema('id');

  await c.automations.get('id');
  await c.automations.list({ automations: {}, limit: 1 });
  await c.automations.count({ automations: {} });
  await c.automations.relatedTo('prefect.flow.id');
}

describe('requests match openapi.json', async () => {
  const { client, calls } = mockClient((call) => (call.method === 'DELETE' ? json(204, null) : json(200, [])));
  await exerciseEverything(client);

  test('the client covers at least 70 distinct operations', () => {
    const operations = new Set(
      calls.map((call) => {
        const found = findOperation(call);
        return found ? `${call.method} ${found.template}` : call.path;
      }),
    );
    assert.ok(operations.size >= 70, `only ${operations.size} operations`);
  });

  for (const call of calls) {
    const label = `${call.method} ${call.url.pathname}${call.url.search}`;
    test(`${label} is in the spec`, () => {
      const found = findOperation(call);
      assert.ok(found, `${label} has no matching path and method in openapi.json`);
      const allowed = allowedKeys(found.operation);
      if (allowed !== 'any') {
        for (const key of bodyKeys(call)) {
          assert.ok(allowed.has(key), `${found.template} body has no field "${key}"`);
        }
      }
      const declared = new Set((found.operation.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name));
      for (const key of call.url.searchParams.keys()) {
        assert.ok(declared.has(key), `${found.template} has no query parameter "${key}"`);
      }
    });
  }
});

test('src/schema.ts is up to date with openapi.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefect-ts-'));
  try {
    const out = join(dir, 'schema.ts');
    const root = new URL('..', import.meta.url);
    execFileSync(process.execPath, ['scripts/gen-types.mjs', 'openapi.json', out], { cwd: root, stdio: 'pipe' });
    const fresh = readFileSync(out, 'utf8');
    const committed = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
    assert.ok(fresh === committed, 'run `npm run types` and commit src/schema.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every schema in the spec has a generated type', () => {
  const generated = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
  for (const name of Object.keys(spec.components.schemas)) {
    const id = name.replace(/[^A-Za-z0-9_]/g, '_');
    assert.match(generated, new RegExp(`export (interface|type) ${id}\\b`), name);
  }
});
