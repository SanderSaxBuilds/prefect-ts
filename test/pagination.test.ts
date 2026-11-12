import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collect, MAX_PAGE_SIZE, paginate } from '../src/index.ts';
import { json, mockClient } from './helpers.ts';

/** A fake endpoint over `total` numbered items that records each page request. */
function source(total: number) {
  const requests: { limit: number; offset: number }[] = [];
  const fetchPage = async ({ limit, offset }: { limit: number; offset: number }) => {
    requests.push({ limit, offset });
    return Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => offset + i);
  };
  return { requests, fetchPage };
}

describe('paginate', () => {
  test('one short page is one request', async () => {
    const { requests, fetchPage } = source(3);
    assert.deepEqual(await collect(paginate(fetchPage, { pageSize: 10 })), [0, 1, 2]);
    assert.deepEqual(requests, [{ limit: 10, offset: 0 }]);
  });

  test('walks offsets until a short page', async () => {
    const { requests, fetchPage } = source(7);
    assert.deepEqual(await collect(paginate(fetchPage, { pageSize: 3 })), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(requests.map((r) => r.offset), [0, 3, 6]);
  });

  test('an exact multiple ends with one empty page', async () => {
    const { requests, fetchPage } = source(6);
    assert.equal((await collect(paginate(fetchPage, { pageSize: 3 }))).length, 6);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2], { limit: 3, offset: 6 });
  });

  test('an empty source is one request', async () => {
    const { requests, fetchPage } = source(0);
    assert.deepEqual(await collect(paginate(fetchPage)), []);
    assert.equal(requests.length, 1);
  });

  test('defaults to the server maximum of 200', async () => {
    const { requests, fetchPage } = source(450);
    assert.equal((await collect(paginate(fetchPage))).length, 450);
    assert.equal(MAX_PAGE_SIZE, 200);
    assert.deepEqual(requests.map((r) => r.limit), [200, 200, 200]);
  });

  test('max stops early and shrinks the last request', async () => {
    const { requests, fetchPage } = source(100);
    assert.deepEqual(await collect(paginate(fetchPage, { pageSize: 4, max: 6 })), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(requests, [
      { limit: 4, offset: 0 },
      { limit: 2, offset: 4 },
    ]);
  });

  test('a starting offset is honored', async () => {
    const { requests, fetchPage } = source(10);
    assert.deepEqual(await collect(paginate(fetchPage, { pageSize: 5 }, { offset: 8 })), [8, 9]);
    assert.deepEqual(requests, [{ limit: 5, offset: 8 }]);
  });

  test('a limit in the query becomes the page size', async () => {
    const { requests, fetchPage } = source(5);
    await collect(paginate(fetchPage, {}, { limit: 2 }));
    assert.deepEqual(requests.map((r) => r.limit), [2, 2, 2]);
  });

  test('a page size below 1 is an error', async () => {
    const { fetchPage } = source(1);
    await assert.rejects(collect(paginate(fetchPage, { pageSize: 0 })), RangeError);
    await assert.rejects(collect(paginate(fetchPage, { pageSize: 2.5 })), RangeError);
  });

  test('breaking out of the loop stops requests', async () => {
    const { requests, fetchPage } = source(1000);
    for await (const item of paginate(fetchPage, { pageSize: 10 })) {
      if (item === 12) break;
    }
    assert.equal(requests.length, 2);
  });

  test('an aborted signal stops the walk', async () => {
    const { fetchPage } = source(100);
    const controller = new AbortController();
    const seen: number[] = [];
    await assert.rejects(async () => {
      for await (const item of paginate(fetchPage, { pageSize: 5, signal: controller.signal })) {
        seen.push(item);
        if (item === 7) controller.abort(new Error('enough'));
      }
    }, /enough/);
    assert.equal(seen.length, 10, 'the page in hand finishes, the next one is not requested');
  });
});

describe('resource iterate', () => {
  test('flowRuns.iterate keeps the filter on every page', async () => {
    const page = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ id: `r${start + i}` }));
    const { client, calls } = mockClient([json(200, page(2, 0)), json(200, page(2, 2)), json(200, page(1, 4))]);
    const ids: string[] = [];
    const query = { flow_runs: { state: { type: { any_: ['COMPLETED' as const] } } }, sort: 'START_TIME_DESC' as const };
    for await (const run of client.flowRuns.iterate(query, { pageSize: 2 })) ids.push(run.id);
    assert.deepEqual(ids, ['r0', 'r1', 'r2', 'r3', 'r4']);
    assert.deepEqual(calls.map((c) => (c.body as { offset: number }).offset), [0, 2, 4]);
    for (const call of calls) {
      assert.deepEqual((call.body as typeof query).flow_runs, query.flow_runs);
      assert.equal((call.body as typeof query).sort, 'START_TIME_DESC');
    }
  });

  test('every iterate method hits its filter endpoint', async () => {
    const { client, calls } = mockClient(json(200, []));
    await collect(client.flows.iterate());
    await collect(client.deployments.iterate());
    await collect(client.taskRuns.iterate());
    await collect(client.logs.iterate());
    await collect(client.workPools.iterate());
    await collect(client.workQueues.iterate());
    await collect(client.variables.iterate());
    await collect(client.blocks.iterate());
    await collect(client.automations.iterate());
    assert.deepEqual(calls.map((c) => c.path), [
      '/flows/filter',
      '/deployments/filter',
      '/task_runs/filter',
      '/logs/filter',
      '/work_pools/filter',
      '/work_queues/filter',
      '/variables/filter',
      '/block_documents/filter',
      '/automations/filter',
    ]);
    for (const call of calls) assert.deepEqual(call.body, { limit: 200, offset: 0 });
  });

  test('max works through a resource', async () => {
    const { client, calls } = mockClient(json(200, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]));
    const flows = await collect(client.flows.iterate({}, { max: 3, pageSize: 50 }));
    assert.equal(flows.length, 3);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.body as { limit: number }).limit, 3);
  });
});
