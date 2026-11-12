# prefect-ts

A typed TypeScript client for the [Prefect](https://www.prefect.io) REST API. It runs deployments, follows flow runs to the end, reads their task runs and logs, and manages variables, work pools, blocks and automations, on Prefect Cloud or a self-hosted server.

It has no runtime dependencies and uses the platform `fetch`, so it works in Node 20+, Bun, Deno, Cloudflare Workers and browsers. It ships ES modules and CommonJS. The model types are generated from the OpenAPI document of `prefect server start` 3.9.2, which is checked in as `openapi.json`.

## Install

```sh
npm install github:SanderSaxBuilds/prefect-ts
```

## Quick start

Run a deployment with parameters and wait for it to finish:

```ts
import { PrefectClient } from 'prefect-client-ts';

const prefect = PrefectClient.fromEnv(); // PREFECT_API_URL and PREFECT_API_KEY

const run = await prefect.deployments.runByName('etl/nightly', {
  parameters: { date: '2026-11-13', full_refresh: true },
});

const finished = await prefect.flowRuns.wait(run.id, { timeoutMs: 30 * 60_000 });
console.log(finished.state_type); // "COMPLETED", "FAILED", "CANCELLED" or "CRASHED"

for (const log of await prefect.flowRuns.logs(run.id)) {
  console.log(log.timestamp, log.message);
}
```

## Connecting

```ts
// Self-hosted server, the same URL as PREFECT_API_URL
const local = new PrefectClient({ apiUrl: 'http://127.0.0.1:4200/api' });

// Self-hosted with basic auth on (PREFECT_API_AUTH_STRING)
const guarded = new PrefectClient({ apiUrl: 'https://prefect.internal/api', authString: 'admin:secret' });

// Prefect Cloud from account and workspace ids
const cloud = PrefectClient.cloud({
  accountId: 'a1b2c3d4-...',
  workspaceId: 'e5f6a7b8-...',
  apiKey: process.env.PREFECT_API_KEY!,
});

// Prefect Cloud from the full workspace URL
const same = new PrefectClient({
  apiUrl: 'https://api.prefect.cloud/api/accounts/a1b2c3d4-.../workspaces/e5f6a7b8-...',
  apiKey: process.env.PREFECT_API_KEY!,
});
```

`PrefectClient.fromEnv()` reads `PREFECT_API_URL`, `PREFECT_API_KEY` and `PREFECT_API_AUTH_STRING`, the variables the Python SDK reads, so a machine set up for the `prefect` CLI works with no extra config. Options passed to `fromEnv` win over the environment.

The client sends `X-PREFECT-API-VERSION: 0.8.4`. Servers refuse a version older than they support with a 400, and `apiVersion: false` leaves the header out.

## Deployments

```ts
const deployment = await prefect.deployments.getByName('etl/nightly'); // or getByName('etl', 'nightly')
const run = await prefect.deployments.createFlowRun(deployment.id, {
  parameters: { date: '2026-11-13' },
  tags: ['manual'],
  job_variables: { env: { LOG_LEVEL: 'DEBUG' } },
  idempotency_key: 'nightly-2026-11-13', // the server returns the same run for a repeated key
});

await prefect.deployments.list({ deployments: { tags: { all_: ['prod'] } } });
await prefect.deployments.pause(deployment.id);
await prefect.deployments.resume(deployment.id);
await prefect.deployments.schedules(deployment.id);
```

`create`, `update` and `delete` are there too, for scripts that register deployments themselves.

## Flow runs

```ts
await prefect.flowRuns.get(id);
await prefect.flowRuns.list({
  flow_runs: { state: { type: { any_: ['FAILED', 'CRASHED'] } } },
  sort: 'START_TIME_DESC',
  limit: 20,
});
await prefect.flowRuns.count({ deployments: { id: { any_: [deploymentId] } } });
await prefect.flowRuns.states(id);    // every state, oldest first
await prefect.flowRuns.taskRuns(id);  // task runs of this flow run
await prefect.flowRuns.logs(id, { logs: { level: { ge_: 40 } } });
await prefect.flowRuns.downloadLogs(id); // the CSV the UI offers
```

### Waiting

`wait` polls until the run reaches COMPLETED, FAILED, CANCELLED or CRASHED and returns the final read. PAUSED and CANCELLING are not final, so it keeps waiting through them.

```ts
const run = await prefect.flowRuns.wait(id, {
  timeoutMs: 10 * 60_000,     // FlowRunTimeoutError after this, 0 waits forever, default 3 hours
  pollIntervalMs: 2000,       // default 2 seconds
  throwOnFailure: true,       // FlowRunFailedError for anything but COMPLETED
  onPoll: (r) => console.log(r.state_name),
  signal: AbortSignal.timeout(15 * 60_000),
});
```

### Changing state and cancelling

```ts
const result = await prefect.flowRuns.setState(id, { type: 'RUNNING' });
result.status; // "ACCEPT", "REJECT", "WAIT" or "ABORT"
result.state;  // the state the server actually set

await prefect.flowRuns.cancel(id, { message: 'stopped from the dashboard' });
```

`cancel` proposes CANCELLING, as `prefect flow-run cancel` does. A running flow moves to CANCELLING and its worker or runner stops it. A run that has not started yet is moved straight to CANCELLED by the server, which reports that as `status: "REJECT"` with a CANCELLED state, so check `result.state.type` rather than `status`.

## Task runs and logs

```ts
await prefect.taskRuns.get(id);
await prefect.taskRuns.list({ task_runs: { state: { type: { any_: ['FAILED'] } } } });
await prefect.taskRuns.states(id);

await prefect.logs.list({ logs: { text: { query: 'timeout' } }, sort: 'TIMESTAMP_DESC', limit: 50 });
await prefect.logs.create([
  { name: 'deploy-bot', level: 20, message: 'Triggered from CI', timestamp: new Date().toISOString(), flow_run_id: id },
]);
```

Log levels are the Python logging numbers: 10 debug, 20 info, 30 warning, 40 error, 50 critical.

## Variables

```ts
await prefect.variables.set('regions', ['eu-west-1', 'us-east-1']); // create or overwrite
const regions = await prefect.variables.getValue<string[]>('regions', []); // fallback when missing
await prefect.variables.create({ name: 'batch_size', value: 500, tags: ['etl'] });
await prefect.variables.updateByName('batch_size', { value: 1000 });
await prefect.variables.deleteByName('batch_size');
```

Values are JSON, so objects and arrays round-trip. Names may only hold lowercase letters, digits, dashes and underscores. A taken name is a `ConflictError`.

## Work pools, blocks and automations

```ts
await prefect.workPools.list();
await prefect.workPools.get('k8s-pool');
await prefect.workPools.queues('k8s-pool');
await prefect.workQueues.status(queueId); // healthy, late runs, last polled

const secret = await prefect.blocks.getByName('secret/db-password', undefined, { includeSecrets: true });
await prefect.blocks.listByType('aws-credentials');
await prefect.blocks.types();

await prefect.automations.list({ automations: { name: { any_: ['notify-on-failure'] } } });
await prefect.automations.relatedTo(`prefect.deployment.${deploymentId}`);
```

Secret fields of blocks come back masked unless `includeSecrets` is set.

## Filters

Filter objects follow the REST API one to one and are fully typed, so the editor completes `any_`, `like_`, `ge_`, `before_` and the rest. Filters on related objects combine with AND:

```ts
await prefect.flowRuns.list({
  flows: { name: { any_: ['etl'] } },
  deployments: { tags: { all_: ['prod'] } },
  flow_runs: {
    start_time: { after_: '2026-11-01T00:00:00Z' },
    state: { type: { not_any_: ['COMPLETED'] } },
  },
});
```

The server ignores body keys it does not know on filter endpoints and returns everything instead of an error, so a misspelled filter key quietly matches all rows. The types catch that at compile time, and the test suite checks every request body against `openapi.json`.

## Pagination

Every list endpoint takes `limit` and `offset`. The server rejects a `limit` above 200 with a 422. `iterate` walks all pages for you:

```ts
for await (const run of prefect.flowRuns.iterate({ flow_runs: { tags: { all_: ['nightly'] } } })) {
  console.log(run.name);
}

// at most 1000 runs, 100 per request
const runs = await collect(prefect.flowRuns.iterate({}, { pageSize: 100, max: 1000 }));
```

Flows, deployments, flow runs and task runs also have `page()`, which wraps the server's `paginate` endpoints and returns 1-based pages with a total count.

`paginate` and `collect` are exported for walking any other limit and offset endpoint.

## Errors

Every error extends `PrefectError`. A non-2xx response is a `PrefectApiError` with `status`, `detail`, `body`, `method`, `url` and `headers`, as one of these subclasses:

| Status | Class |
| --- | --- |
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 422 | `ValidationError`, with `issues` for each field |
| 429 | `RateLimitError`, with `retryAfterMs` |
| 5xx | `ServerError` |

```ts
import { ConflictError, NotFoundError, ValidationError } from 'prefect-client-ts';

try {
  await prefect.deployments.createFlowRun(id, { parameters: { count: 'three' } });
} catch (error) {
  if (error instanceof ConflictError) console.log(error.detail); // "... 'three' is not of type 'integer'"
  if (error instanceof ValidationError) for (const issue of error.issues) console.log(issue.loc, issue.msg);
  if (error instanceof NotFoundError) console.log('no such deployment');
}
```

Requests that never get a response throw `PrefectTimeoutError` or `PrefectConnectionError`. `flowRuns.wait` throws `FlowRunTimeoutError` and, with `throwOnFailure`, `FlowRunFailedError`. Both carry the last read of the run.

## Retries, timeouts and cancellation

429, 502, 503 and 504 are retried up to 3 times with exponential backoff and full jitter. A `Retry-After` header, in seconds or as an HTTP date, sets the wait instead, capped at `maxDelayMs`. A 500, a timeout and a network error are retried only for requests that are safe to repeat: reads, PUT, DELETE and the read-only `filter`, `count`, `paginate` and `history` endpoints. A call that creates something is never sent twice after the server may already have stored it.

```ts
const prefect = new PrefectClient({
  apiUrl,
  timeoutMs: 10_000, // per attempt, default 30 seconds, 0 turns it off
  retry: { maxRetries: 5, baseDelayMs: 250, maxDelayMs: 20_000, statuses: [429, 503] },
});

// per call
await prefect.flowRuns.get(id, { timeoutMs: 2000, maxRetries: 0, signal: controller.signal });
```

An `AbortSignal` stops the request and any backoff wait in progress, and the call rejects with the signal's reason.

## Endpoints not wrapped yet

`request` sends anything else through the same auth, retries and typed errors:

```ts
const artifacts = await prefect.request('POST', '/artifacts/filter', { limit: 10 });
```

## Types

Response models (`Flow`, `Deployment`, `FlowRun`, `TaskRun`, `Log`, `Variable`, `WorkPool`, `BlockDocument`, `Automation` and more) and every filter, sort and request body are exported. The full generated set is under the `schema` namespace:

```ts
import type { FlowRun, schema } from 'prefect-client-ts';
type Schedule = schema.CronSchedule;
```

The spec marks every field that has a default as optional, because one pydantic model describes both what you send and what comes back. The server always returns every field, null when empty, so the response types here drop the `?` on top-level fields. The integration suite checks that against a live server for each model it reads.

## Server behavior worth knowing

These came up while testing against Prefect 3.9.2 and are not in the OpenAPI document:

- Request validation errors come back as `{"exception_message", "exception_detail", "request_body"}`, not the `{"detail": [...]}` shape the spec lists for 422. A `limit` over 200 is a 422 with a plain string `detail`. `ValidationError` handles all three.
- `POST /flows/`, `/deployments/` and `/flow_runs/` document a 200 but answer 201 when they create something. `POST /flows/` answers 200 with the existing flow when the name is taken.
- `create_flow_run` with parameters that fail the deployment's schema is a 409, which the spec does not list.
- `GET /version` is the REST API version ("0.8.4"). The Prefect release ("3.9.2") is at `GET /admin/version`.

## Development

```sh
npm install
npm test                 # tsc --strict, build, 289 unit tests
npm run types            # regenerate src/schema.ts from openapi.json
npm run spec             # save openapi.json from a running server
```

### Integration tests

The integration suite runs against a real server. With `PREFECT_PYTHON` set it also serves `test/integration/flows.py` with `flow.serve()`, so the runs it creates really execute, fail and get cancelled.

```sh
pip install prefect
prefect server start

PREFECT_INTEGRATION=1 \
PREFECT_API_URL=http://127.0.0.1:4200/api \
PREFECT_PYTHON=$(which python) \
npm run test:integration
```

Each run uses fresh names and deletes what it created.

## License

MIT
