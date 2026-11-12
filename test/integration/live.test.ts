// Runs the client against a real Prefect server.
//
//   prefect server start
//   PREFECT_INTEGRATION=1 PREFECT_API_URL=http://127.0.0.1:4200/api \
//   PREFECT_PYTHON=/path/to/venv/bin/python npm run test:integration
//
// PREFECT_PYTHON is a Python with `prefect` installed. It serves test/integration/flows.py
// so flow runs created here really execute. Without it the served-flow tests are skipped
// and the REST-only tests still run.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  API_VERSION,
  collect,
  ConflictError,
  FlowRunFailedError,
  NotFoundError,
  PrefectClient,
  ValidationError,
  type BlockDocument,
  type Deployment,
  type Flow,
  type FlowRun,
} from '../../src/index.ts';

const enabled = process.env.PREFECT_INTEGRATION === '1';
const apiUrl = process.env.PREFECT_API_URL ?? 'http://127.0.0.1:4200/api';
const python = process.env.PREFECT_PYTHON;
const suffix = Date.now().toString(36);
const name = (base: string) => `ts-it-${base}-${suffix}`;

const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as {
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

/** Every property the spec lists for `schemaName` is present in `value`, null or not. */
function assertFullShape(value: object, schemaName: string) {
  const properties = Object.keys(spec.components.schemas[schemaName]?.properties ?? {});
  assert.ok(properties.length > 0, `${schemaName} has properties`);
  const missing = properties.filter((key) => !(key in value));
  assert.deepEqual(missing, [], `${schemaName} response is missing ${missing.join(', ')}`);
}

const client = new PrefectClient({ apiUrl, timeoutMs: 15_000 });

describe('live Prefect server', { skip: !enabled && 'set PREFECT_INTEGRATION=1 to run' }, () => {
  describe('server', () => {
    test('health, ready and versions', async () => {
      assert.equal(await client.health(), true);
      await client.ready();
      assert.match(await client.serverVersion(), /^3\.\d+\.\d+/);
      assert.equal(await client.apiVersion(), API_VERSION);
    });

    test('an aborted call never reaches the server', async () => {
      const controller = new AbortController();
      controller.abort(new Error('stopped'));
      await assert.rejects(client.flows.list({}, { signal: controller.signal }), /stopped/);
    });

    test('an old X-PREFECT-API-VERSION is a 400 from the server', async () => {
      const old = new PrefectClient({ apiUrl, apiVersion: '0.1.0' });
      await assert.rejects(old.flows.list(), (error: unknown) => {
        return error instanceof Error && error.name === 'BadRequestError' && /requires version/.test(error.message);
      });
    });
  });

  describe('flows, deployments and runs over REST only', () => {
    let flow: Flow;
    let deployment: Deployment;

    before(async () => {
      flow = await client.flows.create({ name: name('flow'), tags: ['ts-integration'] });
    });

    after(async () => {
      if (flow) await client.flows.delete(flow.id).catch(() => undefined);
    });

    test('create is an upsert by name', async () => {
      const again = await client.flows.create({ name: flow.name });
      assert.equal(again.id, flow.id);
      assertFullShape(flow, 'Flow');
    });

    test('read a flow by id and by name, filter and count', async () => {
      assert.equal((await client.flows.get(flow.id)).name, flow.name);
      assert.equal((await client.flows.getByName(flow.name)).id, flow.id);
      const found = await client.flows.list({ flows: { name: { any_: [flow.name] } } });
      assert.deepEqual(found.map((f) => f.id), [flow.id]);
      assert.equal(await client.flows.count({ flows: { id: { any_: [flow.id] } } }), 1);
      await client.flows.update(flow.id, { tags: ['ts-integration', 'updated'] });
      assert.deepEqual((await client.flows.get(flow.id)).tags.sort(), ['ts-integration', 'updated']);
    });

    test('a missing flow is a NotFoundError', async () => {
      await assert.rejects(client.flows.get('00000000-0000-0000-0000-000000000000'), (error: unknown) => {
        return error instanceof NotFoundError && error.detail === 'Flow not found';
      });
    });

    test('create a deployment with an enforced parameter schema', async () => {
      deployment = await client.deployments.create({
        name: 'rest-only',
        flow_id: flow.id,
        enforce_parameter_schema: true,
        parameters: { count: 1 },
        parameter_openapi_schema: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        },
      });
      assertFullShape(deployment, 'DeploymentResponse');
      const byName = await client.deployments.getByName(`${flow.name}/rest-only`);
      assert.equal(byName.id, deployment.id);
      assert.equal(await client.deployments.count({ flows: { id: { any_: [flow.id] } } }), 1);
      const page = await client.deployments.page({ flows: { id: { any_: [flow.id] } }, limit: 10 });
      assert.equal(page.count, 1);
      assert.equal(page.page, 1);
    });

    test('bad parameters are a 409 ConflictError, not a 422', async () => {
      await assert.rejects(
        client.deployments.createFlowRun(deployment.id, { parameters: { count: 'three' } }),
        (error: unknown) => error instanceof ConflictError && /is not of type 'integer'/.test(String(error.detail)),
      );
    });

    test('cancel a scheduled run: the server answers REJECT with CANCELLED', async () => {
      const run = await client.deployments.createFlowRun(deployment.id, { parameters: { count: 2 } });
      assert.equal(run.state_type, 'SCHEDULED');
      assert.deepEqual(run.parameters, { count: 2 });
      assertFullShape(run, 'FlowRunResponse');
      const result = await client.flowRuns.cancel(run.id, { message: 'cancelled from the TypeScript suite' });
      assert.equal(result.status, 'REJECT');
      assert.equal(result.state?.type, 'CANCELLED');
      const finished = await client.flowRuns.wait(run.id, { timeoutMs: 5000, pollIntervalMs: 200 });
      assert.equal(finished.state_type, 'CANCELLED');
    });

    test('drive a run through its states by hand, with logs', async () => {
      const run = await client.deployments.createFlowRun(deployment.id, { parameters: { count: 1 }, tags: ['manual'] });
      for (const type of ['PENDING', 'RUNNING'] as const) {
        const result = await client.flowRuns.setState(run.id, { type });
        assert.equal(result.status, 'ACCEPT', `${type} accepted`);
      }
      const now = new Date().toISOString();
      await client.logs.create([
        { name: 'ts', level: 20, message: 'step one', timestamp: now, flow_run_id: run.id },
        { name: 'ts', level: 40, message: 'step two went wrong', timestamp: now, flow_run_id: run.id },
      ]);
      const waiting = client.flowRuns.wait(run.id, { timeoutMs: 20_000, pollIntervalMs: 200 });
      const done = await client.flowRuns.setState(run.id, { type: 'COMPLETED', message: 'finished by hand' });
      assert.equal(done.status, 'ACCEPT');
      const finished = await waiting;
      assert.equal(finished.state_type, 'COMPLETED');
      assert.equal(finished.state?.message, 'finished by hand');

      const logs = await client.flowRuns.logs(run.id);
      assert.deepEqual(logs.map((l) => l.message), ['step one', 'step two went wrong']);
      assertFullShape(logs[0]!, 'Log');
      const errors = await client.logs.list({ logs: { flow_run_id: { any_: [run.id] }, level: { ge_: 40 } } });
      assert.deepEqual(errors.map((l) => l.message), ['step two went wrong']);
      assert.match(await client.flowRuns.downloadLogs(run.id), /step two went wrong/);

      const states = await client.flowRuns.states(run.id);
      assert.deepEqual(states.map((s) => s.type), ['SCHEDULED', 'PENDING', 'RUNNING', 'COMPLETED']);
    });

    test('filter, count, iterate and page flow runs of the deployment', async () => {
      const byDeployment = { deployments: { id: { any_: [deployment.id] } } };
      assert.equal(await client.flowRuns.count(byDeployment), 2);
      const completed = await client.flowRuns.list({ ...byDeployment, flow_runs: { state: { type: { any_: ['COMPLETED'] } } } });
      assert.equal(completed.length, 1);
      const all = await collect(client.flowRuns.iterate({ ...byDeployment, sort: 'EXPECTED_START_TIME_ASC' }, { pageSize: 1 }));
      assert.equal(all.length, 2);
      assert.notEqual(all[0]!.id, all[1]!.id);
      const page = await client.flowRuns.page({ ...byDeployment, limit: 1, page: 2 });
      assert.equal(page.count, 2);
      assert.equal(page.pages, 2);
      assert.equal(page.results.length, 1);
    });

    test('a limit over 200 is a 422 with a string detail', async () => {
      await assert.rejects(client.flowRuns.list({ limit: 201 }), (error: unknown) => {
        return error instanceof ValidationError && error.issues.length === 0 && /200/.test(String(error.detail));
      });
    });

    test('pause and resume the deployment', async () => {
      await client.deployments.pause(deployment.id);
      assert.equal((await client.deployments.get(deployment.id)).paused, true);
      await client.deployments.resume(deployment.id);
      assert.equal((await client.deployments.get(deployment.id)).paused, false);
      assert.deepEqual(await client.deployments.schedules(deployment.id), []);
    });
  });

  describe('work pools and queues', () => {
    const poolName = name('pool');

    after(async () => {
      await client.workPools.delete(poolName).catch(() => undefined);
    });

    test('create a pool, read it and its default queue', async () => {
      const pool = await client.workPools.create({ name: poolName, type: 'process' });
      assertFullShape(pool, 'WorkPoolResponse');
      assert.equal((await client.workPools.get(poolName)).id, pool.id);
      const listed = await client.workPools.list({ work_pools: { name: { any_: [poolName] } } });
      assert.equal(listed.length, 1);
      assert.ok((await client.workPools.count()) >= 1);

      const queues = await client.workPools.queues(poolName);
      assert.deepEqual(queues.map((q) => q.name), ['default']);
      const queue = await client.workPools.queue(poolName, 'default');
      assert.equal(queue.id, pool.default_queue_id);
      assertFullShape(queue, 'WorkQueueResponse');
      assert.equal((await client.workQueues.get(queue.id)).work_pool_name, poolName);
      const status = await client.workQueues.status(queue.id);
      assert.equal(typeof status.healthy, 'boolean');
      const all = await client.workQueues.list({ work_queues: { id: { any_: [queue.id] } } });
      assert.equal(all.length, 1);
    });

    test('a missing pool is a NotFoundError', async () => {
      await assert.rejects(client.workPools.get(name('nope')), NotFoundError);
    });
  });

  describe('variables', () => {
    const varName = name('var').replace(/-/g, '_');

    after(async () => {
      await client.variables.deleteByName(varName).catch(() => undefined);
      await client.variables.deleteByName(`${varName}_set`).catch(() => undefined);
    });

    test('create, read, update, list, count and delete', async () => {
      const created = await client.variables.create({ name: varName, value: { regions: ['eu', 'us'], retries: 3 }, tags: ['ts'] });
      assertFullShape(created, 'Variable');
      assert.deepEqual(created.value, { regions: ['eu', 'us'], retries: 3 });
      assert.equal((await client.variables.get(created.id)).name, varName);
      assert.deepEqual(await client.variables.getValue(varName), { regions: ['eu', 'us'], retries: 3 });

      await client.variables.update(created.id, { value: 'plain text' });
      assert.equal(await client.variables.getValue(varName), 'plain text');
      await client.variables.updateByName(varName, { value: 42 });
      assert.equal((await client.variables.getByName(varName)).value, 42);

      const listed = await client.variables.list({ variables: { name: { like_: varName } } });
      assert.equal(listed.length, 1);
      assert.equal(await client.variables.count({ variables: { name: { any_: [varName] } } }), 1);

      await client.variables.deleteByName(varName);
      assert.equal(await client.variables.getValue(varName, 'gone'), 'gone');
    });

    test('set creates, then overwrites', async () => {
      const first = await client.variables.set(`${varName}_set`, [1, 2, 3]);
      assert.deepEqual(first.value, [1, 2, 3]);
      const second = await client.variables.set(`${varName}_set`, null);
      assert.equal(second.id, first.id);
      assert.equal(second.value, null);
      await client.variables.delete(first.id);
      await assert.rejects(client.variables.get(first.id), NotFoundError);
    });

    test('a taken name is a ConflictError', async () => {
      await client.variables.create({ name: varName, value: 1 });
      await assert.rejects(client.variables.create({ name: varName, value: 2 }), ConflictError);
    });

    test('an invalid name is a ValidationError with field issues', async () => {
      await assert.rejects(client.variables.create({ name: 'Not Valid', value: 1 }), (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.deepEqual(error.issues[0]?.loc, ['body', 'name']);
        return true;
      });
    });
  });

  describe('blocks and automations', () => {
    let block: BlockDocument;
    let automationId: string | undefined;
    const blockName = name('secret');

    after(async () => {
      if (block) await client.request('DELETE', `/block_documents/${block.id}`).catch(() => undefined);
      if (automationId) await client.request('DELETE', `/automations/${automationId}`).catch(() => undefined);
    });

    test('read block types and schemas, save a secret through request()', async () => {
      const secretType = await client.blocks.type('secret');
      const types = await client.blocks.types({ block_types: { slug: { any_: ['secret', 'slack-webhook'] } } });
      assert.deepEqual(types.map((t) => t.slug).sort(), ['secret', 'slack-webhook']);
      const [schema] = await client.blocks.schemas({ block_schemas: { block_type_id: { any_: [secretType.id] } }, limit: 1 });
      assert.ok(schema);
      assert.equal((await client.blocks.schema(schema.id)).block_type_id, secretType.id);

      block = await client.request<BlockDocument>('POST', '/block_documents/', {
        name: blockName,
        block_type_id: secretType.id,
        block_schema_id: schema.id,
        data: { value: 'hunter2' },
      });
      assertFullShape(block, 'BlockDocument');
    });

    test('secrets are masked unless asked for', async () => {
      const masked = await client.blocks.getByName(`secret/${blockName}`);
      assert.notEqual(masked.data.value, 'hunter2');
      const clear = await client.blocks.get(block.id, { includeSecrets: true });
      assert.equal(clear.data.value, 'hunter2');
      const ofType = await client.blocks.listByType('secret');
      assert.ok(ofType.some((b) => b.id === block.id));
      const listed = await client.blocks.list({ block_documents: { name: { any_: [blockName] } } });
      assert.equal(listed.length, 1);
      assert.ok((await client.blocks.count({ block_documents: { name: { any_: [blockName] } } })) === 1);
    });

    test('read an automation', async () => {
      const created = await client.request<{ id: string }>('POST', '/automations/', {
        name: name('automation'),
        trigger: {
          type: 'event',
          match: { 'prefect.resource.id': 'prefect.flow-run.*' },
          expect: ['prefect.flow-run.Failed'],
          posture: 'Reactive',
          threshold: 1,
          within: 0,
        },
        actions: [{ type: 'do-nothing' }],
      });
      automationId = created.id;
      const automation = await client.automations.get(created.id);
      assertFullShape(automation, 'Automation');
      assert.equal(automation.enabled, true);
      const listed = await client.automations.list({ automations: { name: { any_: [automation.name] } } });
      assert.deepEqual(listed.map((a) => a.id), [created.id]);
      assert.ok((await client.automations.count()) >= 1);
      assert.deepEqual(await client.automations.relatedTo('prefect.deployment.00000000-0000-0000-0000-000000000000'), []);
    });
  });

  describe('a served Python flow', { skip: !python && 'set PREFECT_PYTHON to a Python with prefect installed' }, () => {
    let server: ChildProcess | undefined;
    let output = '';
    let deployment: Deployment;

    const removeGreetFlow = async () => {
      const flow = await client.flows.getByName('greet').catch(() => undefined);
      if (flow) await client.flows.delete(flow.id);
    };

    before(async () => {
      // A deployment left over from an interrupted run would look ready before the runner is.
      await removeGreetFlow();
      const script = fileURLToPath(new URL('./flows.py', import.meta.url));
      server = spawn(python!, ['-X', 'utf8', script], {
        env: {
          ...process.env,
          PREFECT_API_URL: apiUrl,
          PREFECT_RUNNER_POLL_FREQUENCY: '1',
          PREFECT_LOGGING_LEVEL: 'INFO',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // On Windows the runner stops a cancelled run with CTRL_BREAK_EVENT, which reaches
        // every process on the same console. A separate process group keeps it away from us.
        detached: process.platform === 'win32',
        windowsHide: true,
      });
      server.stdout?.on('data', (chunk) => (output += chunk));
      server.stderr?.on('data', (chunk) => (output += chunk));

      const deadline = Date.now() + 120_000;
      for (;;) {
        const found = await client.deployments.getByName('greet/ts-integration').catch((error: unknown) => {
          if (error instanceof NotFoundError) return undefined;
          throw error;
        });
        if (found?.status === 'READY') {
          deployment = found;
          break;
        }
        if (Date.now() > deadline || server.exitCode !== null) {
          throw new Error(`the served deployment never became READY:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });

    after(async () => {
      if (server?.pid !== undefined && server.exitCode === null) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          server.kill();
        }
      }
      await removeGreetFlow().catch(() => undefined);
    });

    test('the deployment carries the served defaults', () => {
      assert.deepEqual(deployment.parameters, { name: 'world', count: 2 });
      assert.deepEqual(deployment.tags, ['ts-integration']);
    });

    test('run it by name with parameters and wait for COMPLETED', async () => {
      const run = await client.deployments.runByName('greet/ts-integration', { parameters: { name: 'Ada', count: 3 } });
      const seen = new Set<string>();
      const finished = await client.flowRuns.wait(run.id, {
        timeoutMs: 180_000,
        pollIntervalMs: 1000,
        throwOnFailure: true,
        onPoll: (r: FlowRun) => seen.add(String(r.state_type)),
      });
      assert.equal(finished.state_type, 'COMPLETED');
      assert.deepEqual(finished.parameters, { name: 'Ada', count: 3 });
      assert.ok(finished.total_run_time > 0);
      assert.ok(seen.has('COMPLETED'));

      const tasks = await client.flowRuns.taskRuns(run.id);
      assert.equal(tasks.length, 3);
      assert.ok(tasks.every((t) => t.state_type === 'COMPLETED'));
      assertFullShape(tasks[0]!, 'TaskRun');
      assert.equal((await client.taskRuns.get(tasks[0]!.id)).flow_run_id, run.id);
      const taskStates = await client.taskRuns.states(tasks[0]!.id);
      assert.equal(taskStates.at(-1)?.type, 'COMPLETED');
      assert.equal(await client.taskRuns.count({ flow_runs: { id: { any_: [run.id] } } }), 3);

      const logs = await collect(client.flowRuns.iterateLogs(run.id, {}, { pageSize: 2 }));
      const messages = logs.map((l) => l.message);
      for (const index of [0, 1, 2]) assert.ok(messages.includes(`Hello, Ada (${index})`), messages.join('\n'));
      assert.ok(messages.includes('done with 3 greetings'));
      assert.ok(logs.some((l) => l.task_run_id !== null), 'task logs carry their task run id');
    });

    test('a failing run ends FAILED and throwOnFailure reports it', async () => {
      const run = await client.deployments.createFlowRun(deployment.id, { parameters: { name: 'Bob', count: 1, fail: true } });
      await assert.rejects(
        client.flowRuns.wait(run.id, { timeoutMs: 180_000, pollIntervalMs: 1000, throwOnFailure: true }),
        (error: unknown) => {
          assert.ok(error instanceof FlowRunFailedError);
          assert.equal(error.flowRun.state_type, 'FAILED');
          return true;
        },
      );
      const errorLogs = await client.flowRuns.logs(run.id, { logs: { level: { ge_: 40 } } });
      assert.ok(errorLogs.some((l) => l.message.includes('asked to fail for Bob')), 'the traceback is in the logs');
    });

    test('cancel a run while it is RUNNING', async () => {
      const run = await client.deployments.createFlowRun(deployment.id, { parameters: { name: 'Cy', count: 1, sleep: 120 } });
      const deadline = Date.now() + 120_000;
      while ((await client.flowRuns.get(run.id)).state_type !== 'RUNNING') {
        assert.ok(Date.now() < deadline, 'run never started');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const result = await client.flowRuns.cancel(run.id);
      assert.equal(result.status, 'ACCEPT');
      assert.equal(result.state?.type, 'CANCELLING');
      const finished = await client.flowRuns.wait(run.id, { timeoutMs: 120_000, pollIntervalMs: 1000 });
      assert.equal(finished.state_type, 'CANCELLED');
    });
  });
});
