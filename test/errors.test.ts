import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  FlowRunFailedError,
  FlowRunTimeoutError,
  NotFoundError,
  parseRetryAfter,
  PermissionDeniedError,
  PrefectApiError,
  PrefectConnectionError,
  PrefectError,
  PrefectTimeoutError,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../src/index.ts';
import { apiErrorFor, extractDetail } from '../src/errors.ts';

const init = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  method: 'POST',
  url: 'http://127.0.0.1:4200/api/flows/filter?x=1',
  body,
  headers: new Headers(headers),
});

describe('apiErrorFor picks the class from the status', () => {
  const cases: [number, Function][] = [
    [400, BadRequestError],
    [401, AuthenticationError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, ServerError],
    [502, ServerError],
    [503, ServerError],
  ];
  for (const [status, cls] of cases) {
    test(`${status} is ${cls.name}`, () => {
      const error = apiErrorFor(init(status, { detail: 'x' }));
      assert.ok(error instanceof cls);
      assert.ok(error instanceof PrefectApiError);
      assert.ok(error instanceof PrefectError);
      assert.ok(error instanceof Error);
      assert.equal(error.status, status);
      assert.equal(error.name, cls.name);
    });
  }

  test('an unlisted 4xx stays a plain PrefectApiError', () => {
    const error = apiErrorFor(init(418, { detail: 'teapot' }));
    assert.equal(error.constructor, PrefectApiError);
    assert.equal(error.status, 418);
  });
});

describe('error detail', () => {
  test('reads {"detail": "..."}', () => {
    const error = apiErrorFor(init(404, { detail: 'Flow not found' }));
    assert.equal(error.detail, 'Flow not found');
    assert.equal(error.message, 'POST /api/flows/filter?x=1 returned 404: Flow not found');
  });

  test("reads Prefect's 422 shape with exception_detail", () => {
    const body = {
      exception_message: 'Invalid request received.',
      exception_detail: [
        { type: 'missing', loc: ['body', 'name'], msg: 'Field required' },
        { type: 'extra_forbidden', loc: ['body', 'nam'], msg: 'Extra inputs are not permitted', input: 1 },
      ],
      request_body: { nam: 1 },
    };
    const error = apiErrorFor(init(422, body)) as ValidationError;
    assert.equal(error.issues.length, 2);
    assert.deepEqual(error.issues[0]?.loc, ['body', 'name']);
    assert.match(error.message, /name: Field required, nam: Extra inputs are not permitted$/);
    assert.deepEqual(error.body, body);
  });

  test('reads the FastAPI 422 shape the spec documents', () => {
    const error = apiErrorFor(init(422, { detail: [{ type: 'missing', loc: ['body', 'flow_id'], msg: 'Field required' }] })) as ValidationError;
    assert.equal(error.issues.length, 1);
    assert.match(error.message, /flow_id: Field required/);
  });

  test('a 422 with a string detail has no issues', () => {
    const error = apiErrorFor(init(422, { detail: 'Invalid limit: must be less than or equal to 200.' })) as ValidationError;
    assert.deepEqual(error.issues, []);
    assert.match(error.message, /less than or equal to 200/);
  });

  test('falls back to exception_message, then message, then a text body', () => {
    assert.equal(extractDetail({ exception_message: 'boom' }), 'boom');
    assert.equal(extractDetail({ message: 'hi' }), 'hi');
    assert.equal(extractDetail('Internal Server Error'), 'Internal Server Error');
    assert.equal(extractDetail(''), undefined);
    assert.equal(extractDetail(undefined), undefined);
    assert.equal(extractDetail([1, 2]), undefined);
  });

  test('an object detail is printed as JSON', () => {
    const error = apiErrorFor(init(400, { detail: { code: 7 } }));
    assert.match(error.message, /returned 400: \{"code":7\}$/);
  });

  test('no body gives a short message', () => {
    const error = apiErrorFor(init(502, undefined));
    assert.equal(error.message, 'POST /api/flows/filter?x=1 returned 502');
  });

  test('keeps method, url and headers', () => {
    const error = apiErrorFor(init(500, null, { 'x-request-id': 'abc' }));
    assert.equal(error.method, 'POST');
    assert.equal(error.url, 'http://127.0.0.1:4200/api/flows/filter?x=1');
    assert.equal(error.headers.get('x-request-id'), 'abc');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  test('whole seconds', () => assert.equal(parseRetryAfter('3', now), 3000));
  test('fractional seconds', () => assert.equal(parseRetryAfter('1.5', now), 1500));
  test('zero', () => assert.equal(parseRetryAfter('0', now), 0));
  test('HTTP date in the future', () => assert.equal(parseRetryAfter('Fri, 13 Nov 2026 00:00:05 GMT', now), 5000));
  test('HTTP date in the past is 0', () => assert.equal(parseRetryAfter('Thu, 12 Nov 2026 00:00:00 GMT', now), 0));
  test('garbage is undefined', () => assert.equal(parseRetryAfter('soon', now), undefined));
  test('negative is undefined', () => assert.equal(parseRetryAfter('-1', now), undefined));
  test('empty and missing are undefined', () => {
    assert.equal(parseRetryAfter('', now), undefined);
    assert.equal(parseRetryAfter('  ', now), undefined);
    assert.equal(parseRetryAfter(null, now), undefined);
    assert.equal(parseRetryAfter(undefined, now), undefined);
  });
  test('RateLimitError exposes it', () => {
    const error = apiErrorFor(init(429, { detail: 'slow down' }, { 'retry-after': '7' })) as RateLimitError;
    assert.equal(error.retryAfterMs, 7000);
  });
  test('RateLimitError without the header', () => {
    const error = apiErrorFor(init(429, null)) as RateLimitError;
    assert.equal(error.retryAfterMs, undefined);
  });
});

describe('non-HTTP errors', () => {
  test('PrefectTimeoutError', () => {
    const error = new PrefectTimeoutError('GET', 'http://h/api/flows/1', 50);
    assert.equal(error.message, 'GET /api/flows/1 timed out after 50 ms');
    assert.equal(error.timeoutMs, 50);
    assert.ok(error instanceof PrefectError);
  });

  test('PrefectConnectionError keeps the cause', () => {
    const cause = new TypeError('fetch failed');
    const error = new PrefectConnectionError('GET', 'http://h/api/health', cause);
    assert.equal(error.cause, cause);
    assert.match(error.message, /fetch failed/);
  });

  test('FlowRunTimeoutError names the run and its state', () => {
    const error = new FlowRunTimeoutError({ id: 'r1', name: 'calm-fox', state_type: 'RUNNING', state_name: 'Running' }, 1000);
    assert.equal(error.message, 'Flow run calm-fox was still Running after 1000 ms');
    assert.equal(error.flowRun.id, 'r1');
  });

  test('FlowRunFailedError includes the state message', () => {
    const error = new FlowRunFailedError({
      id: 'r1',
      name: 'calm-fox',
      state_type: 'FAILED',
      state_name: 'Failed',
      state: { message: 'Flow run encountered an exception: ValueError' },
    });
    assert.equal(error.message, 'Flow run calm-fox ended Failed: Flow run encountered an exception: ValueError');
  });
});
