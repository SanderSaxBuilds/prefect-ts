import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PrefectClient, PrefectError, resolveApiUrl, ServerError } from '../src/index.ts';
import { base64 } from '../src/client.ts';
import { json, mockClient } from './helpers.ts';

const noFetch = async () => new Response('true');

describe('API URL', () => {
  test('defaults to a local server', () => {
    assert.equal(resolveApiUrl({}), 'http://127.0.0.1:4200/api');
  });
  test('strips trailing slashes and spaces', () => {
    assert.equal(resolveApiUrl({ apiUrl: ' http://h:4200/api/// ' }), 'http://h:4200/api');
  });
  test('builds the Cloud workspace URL from ids', () => {
    assert.equal(
      resolveApiUrl({ accountId: 'acc-1', workspaceId: 'ws-2' }),
      'https://api.prefect.cloud/api/accounts/acc-1/workspaces/ws-2',
    );
  });
  test('cloudApiUrl changes the Cloud base', () => {
    assert.equal(
      resolveApiUrl({ accountId: 'a', workspaceId: 'w', cloudApiUrl: 'https://proxy.example/api/' }),
      'https://proxy.example/api/accounts/a/workspaces/w',
    );
  });
  test('a Cloud URL passed as apiUrl is used as is', () => {
    const url = 'https://api.prefect.cloud/api/accounts/a/workspaces/w';
    assert.equal(resolveApiUrl({ apiUrl: url }), url);
  });
  test('accountId without workspaceId is an error', () => {
    assert.throws(() => resolveApiUrl({ accountId: 'a' }), /both accountId and workspaceId/);
  });
  test('workspaceId without accountId is an error', () => {
    assert.throws(() => resolveApiUrl({ workspaceId: 'w' }), /both accountId and workspaceId/);
  });
  test('ids together with apiUrl is an error', () => {
    assert.throws(() => resolveApiUrl({ apiUrl: 'http://h/api', accountId: 'a', workspaceId: 'w' }), /not both/);
  });
  test('empty ids are an error', () => {
    assert.throws(() => resolveApiUrl({ accountId: '', workspaceId: 'w' }), /cannot be empty/);
  });
  test('an invalid URL is an error', () => {
    assert.throws(() => resolveApiUrl({ apiUrl: 'not a url' }), PrefectError);
  });
  test('a non-http scheme is an error', () => {
    assert.throws(() => resolveApiUrl({ apiUrl: 'ftp://h/api' }), /http or https/);
  });
});

describe('auth headers', () => {
  test('apiKey is sent as a bearer token', async () => {
    const { client, calls } = mockClient(json(200, true), { apiKey: 'pnu_abc' });
    await client.health();
    assert.equal(calls[0]?.headers.get('authorization'), 'Bearer pnu_abc');
  });

  test('authString is sent as basic auth', async () => {
    const { client, calls } = mockClient(json(200, true), { authString: 'admin:pass' });
    await client.health();
    assert.equal(calls[0]?.headers.get('authorization'), `Basic ${Buffer.from('admin:pass').toString('base64')}`);
  });

  test('base64 handles non-ASCII passwords', () => {
    assert.equal(base64('user:пароль'), Buffer.from('user:пароль', 'utf8').toString('base64'));
  });

  test('apiKey and authString together is an error', () => {
    assert.throws(() => new PrefectClient({ apiKey: 'k', authString: 'u:p', fetch: noFetch }), /not both/);
  });

  test('no auth sends no authorization header', async () => {
    const { client, calls } = mockClient(json(200, true));
    await client.health();
    assert.equal(calls[0]?.headers.get('authorization'), null);
  });

  test('custom headers are sent and can override defaults', async () => {
    const { client, calls } = mockClient(json(200, true), { headers: { 'x-team': 'data', 'x-prefect-api-version': '0.8.9' } });
    await client.health();
    assert.equal(calls[0]?.headers.get('x-team'), 'data');
    assert.equal(calls[0]?.headers.get('x-prefect-api-version'), '0.8.9');
  });

  test('apiVersion false leaves the version header out', async () => {
    const { client, calls } = mockClient(json(200, true), { apiVersion: false });
    await client.health();
    assert.equal(calls[0]?.headers.get('x-prefect-api-version'), null);
  });

  test('apiVersion pins a different version', async () => {
    const { client, calls } = mockClient(json(200, true), { apiVersion: '0.8.0' });
    await client.health();
    assert.equal(calls[0]?.headers.get('x-prefect-api-version'), '0.8.0');
  });
});

describe('construction', () => {
  test('fromEnv reads the Python SDK variables', () => {
    const client = PrefectClient.fromEnv(
      { fetch: noFetch },
      { PREFECT_API_URL: 'https://api.prefect.cloud/api/accounts/a/workspaces/w', PREFECT_API_KEY: 'k' },
    );
    assert.equal(client.apiUrl, 'https://api.prefect.cloud/api/accounts/a/workspaces/w');
  });

  test('fromEnv falls back to the local default', () => {
    const client = PrefectClient.fromEnv({ fetch: noFetch }, {});
    assert.equal(client.apiUrl, 'http://127.0.0.1:4200/api');
  });

  test('fromEnv overrides win over the environment', () => {
    const client = PrefectClient.fromEnv({ apiUrl: 'http://other:4200/api', fetch: noFetch }, { PREFECT_API_URL: 'http://env:4200/api' });
    assert.equal(client.apiUrl, 'http://other:4200/api');
  });

  test('fromEnv sends PREFECT_API_AUTH_STRING as basic auth', async () => {
    let auth: string | null = null;
    const client = PrefectClient.fromEnv(
      {
        fetch: async (_url, init) => {
          auth = new Headers(init.headers).get('authorization');
          return new Response('true');
        },
      },
      { PREFECT_API_AUTH_STRING: 'u:p' },
    );
    await client.health();
    assert.equal(auth, `Basic ${btoa('u:p')}`);
  });

  test('fromEnv reads process.env when no env is given', () => {
    const previous = process.env.PREFECT_API_URL;
    process.env.PREFECT_API_URL = 'http://from-process:4200/api';
    try {
      assert.equal(PrefectClient.fromEnv({ fetch: noFetch }).apiUrl, 'http://from-process:4200/api');
    } finally {
      if (previous === undefined) delete process.env.PREFECT_API_URL;
      else process.env.PREFECT_API_URL = previous;
    }
  });

  test('cloud() builds a workspace client', () => {
    const client = PrefectClient.cloud({ accountId: 'a', workspaceId: 'w', apiKey: 'k', fetch: noFetch });
    assert.equal(client.apiUrl, 'https://api.prefect.cloud/api/accounts/a/workspaces/w');
  });

  test('a negative timeout is an error', () => {
    assert.throws(() => new PrefectClient({ timeoutMs: -1, fetch: noFetch }), RangeError);
  });

  test('a fractional maxRetries is an error', () => {
    assert.throws(() => new PrefectClient({ retry: { maxRetries: 1.5 }, fetch: noFetch }), RangeError);
  });

  test('every resource is there', () => {
    const client = new PrefectClient({ fetch: noFetch });
    for (const key of ['flows', 'deployments', 'flowRuns', 'taskRuns', 'logs', 'workPools', 'workQueues', 'variables', 'blocks', 'automations'] as const) {
      assert.equal(typeof client[key], 'object', key);
    }
  });
});

describe('server status', () => {
  test('health is true when the server says true', async () => {
    const { client, calls } = mockClient(json(200, true));
    assert.equal(await client.health(), true);
    assert.equal(calls[0]?.path, '/health');
  });

  test('health is false when the server is down', async () => {
    const { client } = mockClient(json(503, {}), { retry: { maxRetries: 0 } });
    assert.equal(await client.health(), false);
  });

  test('health is false when the connection fails', async () => {
    const { client } = mockClient(() => {
      throw new TypeError('fetch failed');
    }, { retry: { maxRetries: 0 } });
    assert.equal(await client.health(), false);
  });

  test('health rethrows an abort', async () => {
    const { client } = mockClient(json(200, true));
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(client.health({ signal: controller.signal }), /stop/);
  });

  test('ready resolves on 200 and throws on 503', async () => {
    const ok = mockClient(json(200, { message: 'OK' }));
    await ok.client.ready();
    assert.equal(ok.calls[0]?.path, '/ready');
    const down = mockClient(json(503, { message: 'Database is not available' }), { retry: { maxRetries: 0 } });
    await assert.rejects(down.client.ready(), ServerError);
  });

  test('serverVersion reads /admin/version', async () => {
    const { client, calls } = mockClient(json(200, '3.9.2'));
    assert.equal(await client.serverVersion(), '3.9.2');
    assert.equal(calls[0]?.path, '/admin/version');
  });

  test('apiVersion reads /version', async () => {
    const { client, calls } = mockClient(json(200, '0.8.4'));
    assert.equal(await client.apiVersion(), '0.8.4');
    assert.equal(calls[0]?.path, '/version');
  });

  test('request() reaches unwrapped endpoints with query and body', async () => {
    const { client, calls } = mockClient(json(200, []));
    await client.request('POST', '/artifacts/filter', { limit: 1 }, { query: { x: 'y' } });
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.path, '/artifacts/filter');
    assert.equal(calls[0]?.url.searchParams.get('x'), 'y');
    assert.deepEqual(calls[0]?.body, { limit: 1 });
  });

  test('request() without a body sends none', async () => {
    const { client, calls } = mockClient(json(200, 'x'));
    await client.request('GET', '/hello');
    assert.equal(calls[0]?.body, undefined);
  });
});
