import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FlowRunFailedError, FlowRunTimeoutError, NotFoundError, ServerError } from '../src/index.ts';
import { splitDeploymentName } from '../src/resources/deployments.ts';
import { splitBlockRef } from '../src/resources/blocks.ts';
import { flowRun, json, mockClient } from './helpers.ts';

describe('flows', () => {
  test('create posts the body', async () => {
    const { client, calls } = mockClient(json(201, { id: 'f1', name: 'etl' }));
    const flow = await client.flows.create({ name: 'etl', tags: ['nightly'] });
    assert.equal(flow.id, 'f1');
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.path, '/flows/');
    assert.deepEqual(calls[0]?.body, { name: 'etl', tags: ['nightly'] });
  });

  test('get, getByName with encoding, update, delete', async () => {
    const { client, calls } = mockClient(json(200, { id: 'f1' }));
    await client.flows.get('f1');
    await client.flows.getByName('my etl');
    await client.flows.update('f1', { tags: ['a'] });
    await client.flows.delete('f1');
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.pathname}`),
      ['GET /api/flows/f1', 'GET /api/flows/name/my%20etl', 'PATCH /api/flows/f1', 'DELETE /api/flows/f1'],
    );
    assert.deepEqual(calls[2]?.body, { tags: ['a'] });
  });

  test('list sends the filter, count and page use their endpoints', async () => {
    const { client, calls } = mockClient([json(200, []), json(200, 4), json(200, { results: [], count: 0, limit: 10, pages: 0, page: 1 })]);
    await client.flows.list({ flows: { name: { like_: 'etl' } }, sort: 'NAME_DESC', limit: 5 });
    assert.equal(await client.flows.count({ flows: { tags: { all_: ['x'] } } }), 4);
    const page = await client.flows.page({ page: 2, limit: 10 });
    assert.equal(page.page, 1);
    assert.deepEqual(calls[0]?.body, { flows: { name: { like_: 'etl' } }, sort: 'NAME_DESC', limit: 5 });
    assert.equal(calls[1]?.path, '/flows/count');
    assert.equal(calls[2]?.path, '/flows/paginate');
    assert.deepEqual(calls[2]?.body, { page: 2, limit: 10 });
  });
});

describe('deployments', () => {
  test('getByName accepts "flow/deployment"', async () => {
    const { client, calls } = mockClient(json(200, { id: 'd1' }));
    await client.deployments.getByName('etl/nightly');
    await client.deployments.getByName('etl', 'night ly');
    assert.equal(calls[0]?.url.pathname, '/api/deployments/name/etl/nightly');
    assert.equal(calls[1]?.url.pathname, '/api/deployments/name/etl/night%20ly');
  });

  test('splitDeploymentName rejects names without both parts', () => {
    assert.throws(() => splitDeploymentName('etl'), /flow-name\/deployment-name/);
    assert.throws(() => splitDeploymentName('/x'), TypeError);
    assert.throws(() => splitDeploymentName('x/'), TypeError);
    assert.deepEqual(splitDeploymentName('a/b'), ['a', 'b']);
  });

  test('createFlowRun sends parameters and run options', async () => {
    const { client, calls } = mockClient(json(201, flowRun({ state_type: 'SCHEDULED' })));
    const run = await client.deployments.createFlowRun('d1', {
      parameters: { date: '2026-11-13', retries: 2 },
      tags: ['manual'],
      job_variables: { env: { MODE: 'full' } },
    });
    assert.equal(run.id, 'run-1');
    assert.equal(calls[0]?.path, '/deployments/d1/create_flow_run');
    assert.deepEqual(calls[0]?.body, {
      parameters: { date: '2026-11-13', retries: 2 },
      tags: ['manual'],
      job_variables: { env: { MODE: 'full' } },
    });
  });

  test('createFlowRun with no body sends {}', async () => {
    const { client, calls } = mockClient(json(201, flowRun()));
    await client.deployments.createFlowRun('d1');
    assert.deepEqual(calls[0]?.body, {});
  });

  test('runByName looks up the deployment, then runs it', async () => {
    const { client, calls } = mockClient([json(200, { id: 'dep-9' }), json(201, flowRun())]);
    await client.deployments.runByName('etl/nightly', { parameters: { x: 1 } });
    assert.equal(calls[0]?.url.pathname, '/api/deployments/name/etl/nightly');
    assert.equal(calls[1]?.path, '/deployments/dep-9/create_flow_run');
    assert.deepEqual(calls[1]?.body, { parameters: { x: 1 } });
  });

  test('runByName passes a 404 through', async () => {
    const { client, calls } = mockClient(json(404, { detail: 'Deployment not found' }));
    await assert.rejects(client.deployments.runByName('etl/missing'), NotFoundError);
    assert.equal(calls.length, 1);
  });

  test('pause, resume, schedules, update, delete', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.deployments.pause('d1');
    await client.deployments.resume('d1');
    await client.deployments.schedules('d1');
    await client.deployments.update('d1', { description: 'x' });
    await client.deployments.delete('d1');
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      [
        'POST /deployments/d1/pause_deployment',
        'POST /deployments/d1/resume_deployment',
        'GET /deployments/d1/schedules',
        'PATCH /deployments/d1',
        'DELETE /deployments/d1',
      ],
    );
    assert.equal(calls[0]?.body, undefined);
  });

  test('list, count and page', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.deployments.list({ deployments: { tags: { all_: ['prod'] } } });
    await client.deployments.count();
    await client.deployments.page();
    assert.deepEqual(calls.map((c) => c.path), ['/deployments/filter', '/deployments/count', '/deployments/paginate']);
  });

  test('create posts the deployment body', async () => {
    const { client, calls } = mockClient(json(201, { id: 'd1' }));
    await client.deployments.create({ name: 'nightly', flow_id: 'f1', work_pool_name: 'pool' });
    assert.deepEqual(calls[0]?.body, { name: 'nightly', flow_id: 'f1', work_pool_name: 'pool' });
  });
});

describe('flow runs', () => {
  test('create, get, update, delete', async () => {
    const { client, calls } = mockClient(json(200, flowRun()));
    await client.flowRuns.create({ flow_id: 'f1', parameters: { a: 1 } });
    await client.flowRuns.get('run-1');
    await client.flowRuns.update('run-1', { name: 'renamed' });
    await client.flowRuns.delete('run-1');
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ['POST /flow_runs/', 'GET /flow_runs/run-1', 'PATCH /flow_runs/run-1', 'DELETE /flow_runs/run-1'],
    );
  });

  test('list filters by state type', async () => {
    const { client, calls } = mockClient(json(200, [flowRun()]));
    const runs = await client.flowRuns.list({
      flow_runs: { state: { type: { any_: ['FAILED', 'CRASHED'] } } },
      sort: 'START_TIME_DESC',
      limit: 20,
    });
    assert.equal(runs.length, 1);
    assert.deepEqual(calls[0]?.body, {
      flow_runs: { state: { type: { any_: ['FAILED', 'CRASHED'] } } },
      sort: 'START_TIME_DESC',
      limit: 20,
    });
  });

  test('count and page', async () => {
    const { client, calls } = mockClient(json(200, 2));
    await client.flowRuns.count({ deployments: { id: { any_: ['d1'] } } });
    await client.flowRuns.page({ page: 3 });
    assert.deepEqual(calls.map((c) => c.path), ['/flow_runs/count', '/flow_runs/paginate']);
  });

  test('setState sends force false by default', async () => {
    const { client, calls } = mockClient(json(200, { status: 'ACCEPT', state: { type: 'RUNNING' }, details: {} }));
    const result = await client.flowRuns.setState('run-1', { type: 'RUNNING', name: 'Running' });
    assert.equal(result.status, 'ACCEPT');
    assert.deepEqual(calls[0]?.body, { state: { type: 'RUNNING', name: 'Running' }, force: false });
  });

  test('setState with force', async () => {
    const { client, calls } = mockClient(json(200, { status: 'ACCEPT', state: null, details: {} }));
    await client.flowRuns.setState('run-1', { type: 'COMPLETED' }, { force: true });
    assert.deepEqual(calls[0]?.body, { state: { type: 'COMPLETED' }, force: true });
  });

  test('cancel proposes CANCELLING', async () => {
    const { client, calls } = mockClient(json(200, { status: 'ACCEPT', state: { type: 'CANCELLING' }, details: {} }));
    await client.flowRuns.cancel('run-1');
    assert.equal(calls[0]?.path, '/flow_runs/run-1/set_state');
    assert.deepEqual(calls[0]?.body, { state: { type: 'CANCELLING', name: 'Cancelling' }, force: false });
  });

  test('cancel with a message', async () => {
    const { client, calls } = mockClient(json(200, { status: 'ACCEPT', state: null, details: {} }));
    await client.flowRuns.cancel('run-1', { message: 'stopped from the dashboard' });
    assert.deepEqual(calls[0]?.body, {
      state: { type: 'CANCELLING', name: 'Cancelling', message: 'stopped from the dashboard' },
      force: false,
    });
  });

  test('cancel of a scheduled run returns the REJECT with a CANCELLED state', async () => {
    const reply = { status: 'REJECT', state: { type: 'CANCELLED', name: 'Cancelled' }, details: { type: 'reject_details' } };
    const { client } = mockClient(json(200, reply));
    const result = await client.flowRuns.cancel('run-1');
    assert.equal(result.status, 'REJECT');
    assert.equal(result.state?.type, 'CANCELLED');
  });

  test('resume with and without input', async () => {
    const { client, calls } = mockClient(json(200, { status: 'ACCEPT', state: null, details: {} }));
    await client.flowRuns.resume('run-1');
    await client.flowRuns.resume('run-1', { approved: true });
    assert.deepEqual(calls[0]?.body, {});
    assert.deepEqual(calls[1]?.body, { run_input: { approved: true } });
  });

  test('states reads flow_run_states with the run id', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.flowRuns.states('run-1');
    assert.equal(calls[0]?.path, '/flow_run_states/');
    assert.equal(calls[0]?.url.searchParams.get('flow_run_id'), 'run-1');
  });

  test('logs filters by the run and keeps other filters', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.flowRuns.logs('run-1', { logs: { level: { ge_: 30 } }, sort: 'TIMESTAMP_DESC', limit: 50 });
    assert.equal(calls[0]?.path, '/logs/filter');
    assert.deepEqual(calls[0]?.body, {
      logs: { level: { ge_: 30 }, flow_run_id: { any_: ['run-1'] } },
      sort: 'TIMESTAMP_DESC',
      limit: 50,
    });
  });

  test('iterateLogs pages through the run logs', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}` }));
    const { client, calls } = mockClient([json(200, page(2)), json(200, page(1))]);
    const seen = [];
    for await (const log of client.flowRuns.iterateLogs('run-1', {}, { pageSize: 2 })) seen.push(log);
    assert.equal(seen.length, 3);
    assert.deepEqual(calls[1]?.body, { logs: { flow_run_id: { any_: ['run-1'] } }, limit: 2, offset: 2 });
  });

  test('downloadLogs returns the CSV text', async () => {
    const csv = 'timestamp,level,flow_run_id,task_run_id,message\n2026-11-12,20,run-1,,hello\n';
    const { client, calls } = mockClient(new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }));
    assert.equal(await client.flowRuns.downloadLogs('run-1'), csv);
    assert.equal(calls[0]?.path, '/flow_runs/run-1/logs/download');
  });

  test('taskRuns filters by the flow run, oldest first', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.flowRuns.taskRuns('run-1', { task_runs: { name: { like_: 'load' } } });
    assert.deepEqual(calls[0]?.body, {
      sort: 'EXPECTED_START_TIME_ASC',
      task_runs: { name: { like_: 'load' } },
      flow_runs: { id: { any_: ['run-1'] } },
    });
  });
});

describe('flowRuns.wait', () => {
  test('returns at once for a finished run', async () => {
    const { client, calls, sleeps } = mockClient(json(200, flowRun({ state_type: 'COMPLETED', state_name: 'Completed' })));
    const run = await client.flowRuns.wait('run-1');
    assert.equal(run.state_type, 'COMPLETED');
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  test('polls until a terminal state', async () => {
    const { client, calls, sleeps } = mockClient([
      json(200, flowRun({ state_type: 'SCHEDULED' })),
      json(200, flowRun({ state_type: 'PENDING' })),
      json(200, flowRun({ state_type: 'RUNNING' })),
      json(200, flowRun({ state_type: 'COMPLETED' })),
    ]);
    const states: string[] = [];
    const run = await client.flowRuns.wait('run-1', { pollIntervalMs: 500, onPoll: (r) => states.push(String(r.state_type)) });
    assert.equal(run.state_type, 'COMPLETED');
    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [500, 500, 500]);
    assert.deepEqual(states, ['SCHEDULED', 'PENDING', 'RUNNING', 'COMPLETED']);
  });

  for (const terminal of ['FAILED', 'CANCELLED', 'CRASHED'] as const) {
    test(`stops on ${terminal} and returns it`, async () => {
      const { client } = mockClient(json(200, flowRun({ state_type: terminal })));
      assert.equal((await client.flowRuns.wait('run-1')).state_type, terminal);
    });
  }

  test('PAUSED and CANCELLING are not terminal', async () => {
    const { client, calls } = mockClient([
      json(200, flowRun({ state_type: 'PAUSED' })),
      json(200, flowRun({ state_type: 'CANCELLING' })),
      json(200, flowRun({ state_type: 'CANCELLED' })),
    ]);
    await client.flowRuns.wait('run-1');
    assert.equal(calls.length, 3);
  });

  test('throws FlowRunTimeoutError with the last read', async () => {
    const { client, sleeps } = mockClient(json(200, flowRun({ state_type: 'RUNNING', state_name: 'Running' })));
    await assert.rejects(client.flowRuns.wait('run-1', { timeoutMs: 5000, pollIntervalMs: 2000 }), (error: unknown) => {
      assert.ok(error instanceof FlowRunTimeoutError);
      assert.equal(error.flowRun.state_type, 'RUNNING');
      assert.equal(error.timeoutMs, 5000);
      return true;
    });
    assert.deepEqual(sleeps, [2000, 2000, 1000], 'the last wait is cut to the time left');
  });

  test('throwOnFailure turns FAILED into an error', async () => {
    const { client } = mockClient(
      json(200, flowRun({ state_type: 'FAILED', state_name: 'Failed', state: { type: 'FAILED', message: 'boom' } })),
    );
    await assert.rejects(client.flowRuns.wait('run-1', { throwOnFailure: true }), (error: unknown) => {
      return error instanceof FlowRunFailedError && /boom/.test(error.message);
    });
  });

  test('throwOnFailure lets COMPLETED through', async () => {
    const { client } = mockClient(json(200, flowRun({ state_type: 'COMPLETED' })));
    assert.equal((await client.flowRuns.wait('run-1', { throwOnFailure: true })).state_type, 'COMPLETED');
  });

  test('timeoutMs 0 waits until the end', async () => {
    const replies = Array.from({ length: 30 }, () => json(200, flowRun({ state_type: 'RUNNING' })));
    const { client, calls } = mockClient([...replies, json(200, flowRun({ state_type: 'COMPLETED' }))]);
    await client.flowRuns.wait('run-1', { timeoutMs: 0, pollIntervalMs: 60_000 });
    assert.equal(calls.length, 31);
  });

  test('an abort stops the wait', async () => {
    const controller = new AbortController();
    const { client } = mockClient(() => {
      controller.abort(new Error('caller stopped waiting'));
      return json(200, flowRun({ state_type: 'RUNNING' }));
    });
    await assert.rejects(client.flowRuns.wait('run-1', { signal: controller.signal }), /caller stopped waiting/);
  });

  test('a bad interval is an error', async () => {
    const { client } = mockClient(json(200, flowRun()));
    await assert.rejects(client.flowRuns.wait('run-1', { pollIntervalMs: 0 }), RangeError);
  });

  test('a read error ends the wait', async () => {
    const { client } = mockClient(json(404, { detail: 'Flow run not found' }));
    await assert.rejects(client.flowRuns.wait('gone'), NotFoundError);
  });
});

describe('task runs and logs', () => {
  test('task runs get, list, count, page, states', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.taskRuns.get('t1');
    await client.taskRuns.list({ task_runs: { state: { type: { any_: ['FAILED'] } } } });
    await client.taskRuns.count();
    await client.taskRuns.page();
    await client.taskRuns.states('t1');
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ['GET /task_runs/t1', 'POST /task_runs/filter', 'POST /task_runs/count', 'POST /task_runs/paginate', 'GET /task_run_states/'],
    );
    assert.equal(calls[4]?.url.searchParams.get('task_run_id'), 't1');
  });

  test('logs.list sends the filter', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.logs.list({ logs: { text: { query: 'error' } }, limit: 10 });
    assert.deepEqual(calls[0]?.body, { logs: { text: { query: 'error' } }, limit: 10 });
  });

  test('logs.create posts an array and resolves to undefined', async () => {
    const { client, calls } = mockClient(json(201, null));
    const result = await client.logs.create([{ name: 'app', level: 20, message: 'hi', timestamp: '2026-11-13T00:00:00Z' }]);
    assert.equal(result, undefined);
    assert.ok(Array.isArray(calls[0]?.body));
  });
});

describe('work pools and queues', () => {
  test('pool reads encode the name', async () => {
    const { client, calls } = mockClient(json(200, {}));
    await client.workPools.get('k8s pool');
    await client.workPools.queues('k8s pool', { limit: 5 });
    await client.workPools.queue('k8s pool', 'high priority');
    assert.deepEqual(calls.map((c) => c.url.pathname), [
      '/api/work_pools/k8s%20pool',
      '/api/work_pools/k8s%20pool/queues/filter',
      '/api/work_pools/k8s%20pool/queues/high%20priority',
    ]);
    assert.deepEqual(calls[1]?.body, { limit: 5 });
  });

  test('pool list, count, create, delete', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.workPools.list({ work_pools: { type: { any_: ['process'] } } });
    await client.workPools.count();
    await client.workPools.create({ name: 'local', type: 'process' });
    await client.workPools.delete('local');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
      'POST /work_pools/filter',
      'POST /work_pools/count',
      'POST /work_pools/',
      'DELETE /work_pools/local',
    ]);
  });

  test('work queue reads', async () => {
    const { client, calls } = mockClient(json(200, {}));
    await client.workQueues.get('q1');
    await client.workQueues.getByName('default');
    await client.workQueues.list({ limit: 3 });
    await client.workQueues.status('q1');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
      'GET /work_queues/q1',
      'GET /work_queues/name/default',
      'POST /work_queues/filter',
      'GET /work_queues/q1/status',
    ]);
  });
});

describe('variables', () => {
  test('create, get, getByName, update, delete', async () => {
    const { client, calls } = mockClient(json(201, { id: 'v1', name: 'cfg', value: { a: 1 } }));
    await client.variables.create({ name: 'cfg', value: { a: 1 }, tags: ['x'] });
    await client.variables.get('v1');
    await client.variables.getByName('cfg');
    await client.variables.update('v1', { value: 2 });
    await client.variables.updateByName('cfg', { value: 3 });
    await client.variables.delete('v1');
    await client.variables.deleteByName('cfg');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
      'POST /variables/',
      'GET /variables/v1',
      'GET /variables/name/cfg',
      'PATCH /variables/v1',
      'PATCH /variables/name/cfg',
      'DELETE /variables/v1',
      'DELETE /variables/name/cfg',
    ]);
  });

  test('getValue returns the value', async () => {
    const { client } = mockClient(json(200, { id: 'v1', name: 'cfg', value: [1, 2] }));
    assert.deepEqual(await client.variables.getValue('cfg'), [1, 2]);
  });

  test('getValue returns the fallback on 404', async () => {
    const { client } = mockClient(json(404, { detail: 'Variable not found' }));
    assert.equal(await client.variables.getValue('missing', 'dflt'), 'dflt');
    assert.equal(await client.variables.getValue('missing'), undefined);
  });

  test('getValue rethrows other errors', async () => {
    const { client } = mockClient(json(500, {}), { retry: { maxRetries: 0 } });
    await assert.rejects(client.variables.getValue('cfg'), ServerError);
  });

  test('set updates an existing variable and reads it back', async () => {
    const { client, calls } = mockClient([json(204, null), json(200, { id: 'v1', name: 'cfg', value: 5 })]);
    const variable = await client.variables.set('cfg', 5, { tags: ['ops'] });
    assert.equal(variable.value, 5);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PATCH /variables/name/cfg', 'GET /variables/name/cfg']);
    assert.deepEqual(calls[0]?.body, { value: 5, tags: ['ops'] });
  });

  test('set creates a missing variable', async () => {
    const { client, calls } = mockClient([json(404, { detail: 'Variable not found' }), json(201, { id: 'v2', name: 'cfg', value: true })]);
    const variable = await client.variables.set('cfg', true);
    assert.equal(variable.id, 'v2');
    assert.deepEqual(calls[1]?.body, { name: 'cfg', value: true });
  });

  test('list and count', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.variables.list({ variables: { name: { like_: 'cfg' } } });
    await client.variables.count();
    assert.deepEqual(calls.map((c) => c.path), ['/variables/filter', '/variables/count']);
  });
});

describe('blocks', () => {
  test('get with and without secrets', async () => {
    const { client, calls } = mockClient(json(200, { id: 'b1' }));
    await client.blocks.get('b1');
    await client.blocks.get('b1', { includeSecrets: true });
    assert.equal(calls[0]?.url.search, '');
    assert.equal(calls[1]?.url.searchParams.get('include_secrets'), 'true');
  });

  test('getByName accepts "slug/name"', async () => {
    const { client, calls } = mockClient(json(200, { id: 'b1' }));
    await client.blocks.getByName('secret/db-password');
    await client.blocks.getByName('secret', 'db password', { includeSecrets: false });
    assert.equal(calls[0]?.url.pathname, '/api/block_types/slug/secret/block_documents/name/db-password');
    assert.equal(calls[1]?.url.pathname, '/api/block_types/slug/secret/block_documents/name/db%20password');
    assert.equal(calls[1]?.url.searchParams.get('include_secrets'), 'false');
  });

  test('splitBlockRef rejects a bare slug', () => {
    assert.throws(() => splitBlockRef('secret'), /block-type-slug\/block-name/);
  });

  test('list, count, listByType, types, type, schemas, schema', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.blocks.list({ block_types: { slug: { any_: ['secret'] } } });
    await client.blocks.count();
    await client.blocks.listByType('json');
    await client.blocks.types({ limit: 3 });
    await client.blocks.type('secret');
    await client.blocks.schemas();
    await client.blocks.schema('s1');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
      'POST /block_documents/filter',
      'POST /block_documents/count',
      'GET /block_types/slug/json/block_documents',
      'POST /block_types/filter',
      'GET /block_types/slug/secret',
      'POST /block_schemas/filter',
      'GET /block_schemas/s1',
    ]);
  });
});

describe('automations', () => {
  test('get, list, count, relatedTo', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.automations.get('a1');
    await client.automations.list({ automations: { name: { any_: ['notify'] } } });
    await client.automations.count();
    await client.automations.relatedTo('prefect.deployment.d1');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
      'GET /automations/a1',
      'POST /automations/filter',
      'POST /automations/count',
      'GET /automations/related-to/prefect.deployment.d1',
    ]);
  });
});
