import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ConflictError,
  NotFoundError,
  PrefectConnectionError,
  PrefectTimeoutError,
  RateLimitError,
  ServerError,
} from '../src/index.ts';
import { backoffDelay, buildUrl, DEFAULT_RETRY, isSafeToRepeat, path, sleep } from '../src/http.ts';
import { json, mockClient } from './helpers.ts';

describe('buildUrl', () => {
  test('joins base and path', () => {
    assert.equal(buildUrl('http://h/api', '/flows/'), 'http://h/api/flows/');
  });
  test('drops trailing slashes on the base and adds a missing leading slash', () => {
    assert.equal(buildUrl('http://h/api//', 'health'), 'http://h/api/health');
  });
  test('encodes query values and repeats arrays', () => {
    assert.equal(
      buildUrl('http://h/api', '/x', { a: 'b c', n: 2, t: true, list: ['1', 2] }),
      'http://h/api/x?a=b+c&n=2&t=true&list=1&list=2',
    );
  });
  test('skips undefined and null query values', () => {
    assert.equal(buildUrl('http://h/api', '/x', { a: undefined, b: null }), 'http://h/api/x');
  });
  test('false is sent, not skipped', () => {
    assert.equal(buildUrl('http://h/api', '/x', { include_secrets: false }), 'http://h/api/x?include_secrets=false');
  });
});

describe('path template', () => {
  test('encodes spaces and slashes in values', () => {
    assert.equal(path`/flows/name/${'my flow/v2'}`, '/flows/name/my%20flow%2Fv2');
  });
  test('encodes several values', () => {
    assert.equal(path`/deployments/name/${'etl'}/${'night ly'}`, '/deployments/name/etl/night%20ly');
  });
  test('keeps unicode readable to the server', () => {
    assert.equal(path`/variables/name/${'é'}`, '/variables/name/%C3%A9');
  });
  test('rejects an empty segment', () => {
    assert.throws(() => path`/flows/${''}`, TypeError);
  });
});

describe('isSafeToRepeat', () => {
  const cases: [string, string, boolean][] = [
    ['GET', '/flows/1', true],
    ['DELETE', '/flows/1', true],
    ['PUT', '/automations/1', true],
    ['POST', '/flow_runs/filter', true],
    ['POST', '/flow_runs/count', true],
    ['POST', '/flow_runs/paginate', true],
    ['POST', '/flow_runs/history', true],
    ['POST', '/flow_runs/', false],
    ['POST', '/deployments/1/create_flow_run', false],
    ['POST', '/flow_runs/1/set_state', false],
    ['PATCH', '/variables/1', false],
  ];
  for (const [method, p, expected] of cases) {
    test(`${method} ${p} is ${expected ? 'safe' : 'not safe'}`, () => {
      assert.equal(isSafeToRepeat(method, p), expected);
    });
  }
});

describe('backoffDelay', () => {
  const retry = { ...DEFAULT_RETRY, baseDelayMs: 100, maxDelayMs: 1000 };
  test('doubles per attempt with full jitter', () => {
    assert.equal(backoffDelay(0, retry, () => 0.5), 50);
    assert.equal(backoffDelay(1, retry, () => 0.5), 100);
    assert.equal(backoffDelay(2, retry, () => 0.5), 200);
  });
  test('stays under maxDelayMs', () => {
    assert.equal(backoffDelay(20, retry, () => 0.999), 999);
  });
  test('can be zero', () => {
    assert.equal(backoffDelay(3, retry, () => 0), 0);
  });
});

describe('sleep', () => {
  test('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(15);
    assert.ok(Date.now() - started >= 10);
  });
  test('rejects at once for an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(sleep(10_000, controller.signal), /stop/);
  });
  test('rejects when aborted mid-wait', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(new Error('later'));
    await assert.rejects(pending, /later/);
  });
});

describe('retries', () => {
  test('429 then 200 succeeds after one retry', async () => {
    const { client, calls } = mockClient([json(429, { detail: 'slow' }), json(200, true)]);
    assert.equal(await client.health(), true);
    assert.equal(calls.length, 2);
  });

  test('Retry-After seconds decide the wait', async () => {
    const { client, sleeps } = mockClient([json(429, {}, { 'retry-after': '2' }), json(200, [])]);
    await client.flows.list();
    assert.deepEqual(sleeps, [2000]);
  });

  test('Retry-After HTTP date decides the wait', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    const { client, sleeps } = mockClient([json(503, {}, { 'retry-after': at }), json(200, [])]);
    await client.flows.list();
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! > 0 && sleeps[0]! <= 30_000, `waited ${sleeps[0]}`);
  });

  test('Retry-After is capped at maxDelayMs', async () => {
    const { client, sleeps } = mockClient([json(429, {}, { 'retry-after': '3600' }), json(200, [])], {
      retry: { maxDelayMs: 5000 },
    });
    await client.flows.list();
    assert.deepEqual(sleeps, [5000]);
  });

  test('without Retry-After it backs off exponentially', async () => {
    const { client, sleeps } = mockClient([json(503, {}), json(503, {}), json(503, {}), json(200, [])]);
    await client.flows.list();
    assert.deepEqual(sleeps, [250, 500, 1000]);
  });

  test('gives up after maxRetries and throws the last error', async () => {
    const { client, calls } = mockClient(json(503, { detail: 'down' }));
    await assert.rejects(client.flows.list(), (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error.status, 503);
      assert.equal(error.detail, 'down');
      return true;
    });
    assert.equal(calls.length, 4);
  });

  test('429 exhausted is a RateLimitError', async () => {
    const { client } = mockClient(json(429, { detail: 'slow' }, { 'retry-after': '1' }), { retry: { maxRetries: 1 } });
    await assert.rejects(client.flows.list(), (error: unknown) => error instanceof RateLimitError && error.retryAfterMs === 1000);
  });

  test('maxRetries 0 in the client turns retries off', async () => {
    const { client, calls } = mockClient(json(503, {}), { retry: { maxRetries: 0 } });
    await assert.rejects(client.flows.list(), ServerError);
    assert.equal(calls.length, 1);
  });

  test('maxRetries on a single call wins', async () => {
    const { client, calls } = mockClient(json(503, {}));
    await assert.rejects(client.flows.list({}, { maxRetries: 1 }), ServerError);
    assert.equal(calls.length, 2);
  });

  test('503 is retried for a create call too', async () => {
    const { client, calls } = mockClient([json(503, {}), json(201, { id: 'f', name: 'x' })]);
    await client.flows.create({ name: 'x' });
    assert.equal(calls.length, 2);
  });

  test('500 is retried for a read', async () => {
    const { client, calls } = mockClient([json(500, {}), json(200, { id: 'f' })]);
    await client.flows.get('f');
    assert.equal(calls.length, 2);
  });

  test('500 is retried for a read-only POST', async () => {
    const { client, calls } = mockClient([json(500, {}), json(200, 3)]);
    assert.equal(await client.flowRuns.count(), 3);
    assert.equal(calls.length, 2);
  });

  test('500 is not retried for a create call', async () => {
    const { client, calls } = mockClient([json(500, {}), json(200, {})]);
    await assert.rejects(client.deployments.createFlowRun('d1'), ServerError);
    assert.equal(calls.length, 1);
  });

  test('custom statuses replace the default list', async () => {
    const { client, calls } = mockClient([json(409, {}), json(200, {})], { retry: { statuses: [409] } });
    await client.flowRuns.create({ flow_id: 'f' });
    assert.equal(calls.length, 2);
  });

  test('404 is never retried', async () => {
    const { client, calls } = mockClient(json(404, { detail: 'Flow not found' }));
    await assert.rejects(client.flows.get('nope'), NotFoundError);
    assert.equal(calls.length, 1);
  });

  test('409 is not retried by default', async () => {
    const { client, calls } = mockClient(json(409, { detail: 'taken' }));
    await assert.rejects(client.variables.create({ name: 'a', value: 1 }), ConflictError);
    assert.equal(calls.length, 1);
  });
});

describe('network errors and timeouts', () => {
  const failing = (times: number, then: Response) => {
    let count = 0;
    return () => {
      count++;
      if (count <= times) throw new TypeError('fetch failed');
      return then.clone();
    };
  };

  test('a network error on a read is retried', async () => {
    const { client, calls } = mockClient(failing(2, json(200, true)));
    assert.equal(await client.health(), true);
    assert.equal(calls.length, 3);
  });

  test('a network error on a create call is not retried', async () => {
    const { client, calls } = mockClient(failing(1, json(200, {})));
    await assert.rejects(client.flowRuns.create({ flow_id: 'f' }), PrefectConnectionError);
    assert.equal(calls.length, 1);
  });

  test('a network error that never clears is a PrefectConnectionError', async () => {
    const { client } = mockClient(failing(99, json(200, {})), { retry: { maxRetries: 2 } });
    await assert.rejects(client.flows.get('f'), (error: unknown) => {
      assert.ok(error instanceof PrefectConnectionError);
      assert.ok(error.cause instanceof TypeError);
      return true;
    });
  });

  test('a slow response is a PrefectTimeoutError', async () => {
    const hang = (call: { signal: AbortSignal | null | undefined }) =>
      new Promise<Response>((_, reject) => {
        call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const { client, calls } = mockClient(hang, { timeoutMs: 20, retry: { maxRetries: 1 } });
    await assert.rejects(client.flows.get('f'), (error: unknown) => {
      assert.ok(error instanceof PrefectTimeoutError);
      assert.equal(error.timeoutMs, 20);
      return true;
    });
    assert.equal(calls.length, 2, 'a read is retried once after a timeout');
  });

  test('a per-call timeout overrides the client one', async () => {
    const hang = (call: { signal: AbortSignal | null | undefined }) =>
      new Promise<Response>((_, reject) => {
        call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const { client } = mockClient(hang, { timeoutMs: 60_000, retry: { maxRetries: 0 } });
    await assert.rejects(client.flows.get('f', { timeoutMs: 15 }), (error: unknown) => {
      return error instanceof PrefectTimeoutError && error.timeoutMs === 15;
    });
  });
});

describe('abort signal', () => {
  test('an already aborted signal stops before any request', async () => {
    const { client, calls } = mockClient(json(200, []));
    const controller = new AbortController();
    controller.abort(new Error('cancelled by caller'));
    await assert.rejects(client.flows.list({}, { signal: controller.signal }), /cancelled by caller/);
    assert.equal(calls.length, 0);
  });

  test('aborting during a request rejects with the signal reason, without retry', async () => {
    const controller = new AbortController();
    const hang = (call: { signal: AbortSignal | null | undefined }) =>
      new Promise<Response>((_, reject) => {
        call.signal?.addEventListener('abort', () => reject(call.signal?.reason));
        setTimeout(() => controller.abort(new Error('user hit stop')), 5);
      });
    const { client, calls } = mockClient(hang);
    await assert.rejects(client.flows.get('f', { signal: controller.signal }), /user hit stop/);
    assert.equal(calls.length, 1);
  });

  test('the signal reaches fetch', async () => {
    const { client, calls } = mockClient(json(200, true));
    await client.health({ signal: new AbortController().signal });
    assert.ok(calls[0]?.signal instanceof AbortSignal);
  });
});

describe('responses and headers', () => {
  test('204 resolves to undefined', async () => {
    const { client } = mockClient(json(204, null));
    assert.equal(await client.flows.delete('f'), undefined);
  });

  test('a JSON null body resolves to null', async () => {
    const { client } = mockClient(new Response('null', { status: 201, headers: { 'content-type': 'application/json' } }));
    assert.equal(await client.request('POST', '/logs/', []), null);
  });

  test('JSON without a content type is still parsed', async () => {
    const { client } = mockClient(new Response('"3.9.2"', { status: 200 }));
    assert.equal(await client.serverVersion(), '3.9.2');
  });

  test('a non-JSON body comes back as text', async () => {
    const { client } = mockClient(new Response('ok then', { status: 200, headers: { 'content-type': 'text/plain' } }));
    assert.equal(await client.request('GET', '/hello'), 'ok then');
  });

  test('accept and the API version header go on every request', async () => {
    const { client, calls } = mockClient(json(200, true));
    await client.health();
    assert.equal(calls[0]?.headers.get('accept'), 'application/json');
    assert.equal(calls[0]?.headers.get('x-prefect-api-version'), '0.8.4');
    assert.equal(calls[0]?.headers.get('content-type'), null);
  });

  test('content-type is set only when there is a body', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.flows.list();
    assert.equal(calls[0]?.headers.get('content-type'), 'application/json');
    assert.deepEqual(calls[0]?.body, {});
  });

  test('per-call headers are added', async () => {
    const { client, calls } = mockClient(json(200, true));
    await client.health({ headers: { 'x-trace': '42' } });
    assert.equal(calls[0]?.headers.get('x-trace'), '42');
  });

  test('a bad JSON error body still gives a typed error', async () => {
    const { client } = mockClient(new Response('<html>bad gateway</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    await assert.rejects(client.flows.get('f'), (error: unknown) => error instanceof NotFoundError && error.detail === '<html>bad gateway</html>');
  });
});
