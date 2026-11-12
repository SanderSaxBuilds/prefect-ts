/** One entry of a 422 response, as FastAPI and pydantic report it. */
export interface ValidationIssue {
  type: string;
  loc: (string | number)[];
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

/** Base class for every error this client throws. */
export class PrefectError extends Error {
  override name = 'PrefectError';
}

export interface ApiErrorInit {
  status: number;
  method: string;
  url: string;
  body: unknown;
  headers: Headers;
}

/**
 * The server answered with a status outside 2xx.
 *
 * `detail` is the server's explanation. Prefect sends `{"detail": "..."}` for most
 * errors and `{"exception_message", "exception_detail", "request_body"}` for request
 * validation errors. Both shapes end up in `detail`.
 */
export class PrefectApiError extends PrefectError {
  override name = 'PrefectApiError';
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: Headers;
  readonly detail: unknown;

  constructor(init: ApiErrorInit) {
    const detail = extractDetail(init.body);
    super(`${init.method} ${pathOf(init.url)} returned ${init.status}${describe(detail)}`);
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.body = init.body;
    this.headers = init.headers;
    this.detail = detail;
  }
}

/** 400. Also what the server sends for an unsupported X-PREFECT-API-VERSION header. */
export class BadRequestError extends PrefectApiError {
  override name = 'BadRequestError';
}

/** 401. The API key is missing, wrong or expired. */
export class AuthenticationError extends PrefectApiError {
  override name = 'AuthenticationError';
}

/** 403. The key is valid but lacks access to this account, workspace or object. */
export class PermissionDeniedError extends PrefectApiError {
  override name = 'PermissionDeniedError';
}

/** 404. */
export class NotFoundError extends PrefectApiError {
  override name = 'NotFoundError';
}

/**
 * 409. A name is taken, or the server refused the object for another reason, such as
 * flow run parameters that fail the deployment's parameter schema.
 */
export class ConflictError extends PrefectApiError {
  override name = 'ConflictError';
}

/** 422. `issues` lists each field that failed validation. */
export class ValidationError extends PrefectApiError {
  override name = 'ValidationError';
  readonly issues: ValidationIssue[];

  constructor(init: ApiErrorInit) {
    super(init);
    this.issues = Array.isArray(this.detail) ? (this.detail as ValidationIssue[]) : [];
  }
}

/** 429. `retryAfterMs` is the server's Retry-After header, when it sent one. */
export class RateLimitError extends PrefectApiError {
  override name = 'RateLimitError';
  readonly retryAfterMs: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init);
    this.retryAfterMs = parseRetryAfter(init.headers.get('retry-after'));
  }
}

/** 5xx. */
export class ServerError extends PrefectApiError {
  override name = 'ServerError';
}

/** A single attempt took longer than the configured timeout. */
export class PrefectTimeoutError extends PrefectError {
  override name = 'PrefectTimeoutError';
  readonly timeoutMs: number;
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, timeoutMs: number) {
    super(`${method} ${pathOf(url)} timed out after ${timeoutMs} ms`);
    this.method = method;
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** The request never got a response: DNS failure, refused connection, reset socket. */
export class PrefectConnectionError extends PrefectError {
  override name = 'PrefectConnectionError';
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, cause: unknown) {
    super(`${method} ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.method = method;
    this.url = url;
  }
}

/** A run seen by `flowRuns.wait`, kept small so errors stay readable when logged. */
export interface WaitedRun {
  id: string;
  name?: string | null;
  state_type?: string | null;
  state_name?: string | null;
}

/** `flowRuns.wait` gave up before the run reached a terminal state. `flowRun` is the last read. */
export class FlowRunTimeoutError extends PrefectError {
  override name = 'FlowRunTimeoutError';
  readonly flowRun: WaitedRun;
  readonly timeoutMs: number;

  constructor(flowRun: WaitedRun, timeoutMs: number) {
    super(
      `Flow run ${flowRun.name ?? flowRun.id} was still ${flowRun.state_name ?? flowRun.state_type ?? 'unknown'} after ${timeoutMs} ms`,
    );
    this.flowRun = flowRun;
    this.timeoutMs = timeoutMs;
  }
}

/** `flowRuns.wait` with `throwOnFailure` saw a terminal state other than COMPLETED. */
export class FlowRunFailedError extends PrefectError {
  override name = 'FlowRunFailedError';
  readonly flowRun: WaitedRun & { state?: { message?: string | null } | null };

  constructor(flowRun: WaitedRun & { state?: { message?: string | null } | null }) {
    const message = flowRun.state?.message ? `: ${flowRun.state.message}` : '';
    super(`Flow run ${flowRun.name ?? flowRun.id} ended ${flowRun.state_name ?? flowRun.state_type}${message}`);
    this.flowRun = flowRun;
  }
}

/** Builds the error class that matches the response status. */
export function apiErrorFor(init: ApiErrorInit): PrefectApiError {
  const { status } = init;
  if (status === 400) return new BadRequestError(init);
  if (status === 401) return new AuthenticationError(init);
  if (status === 403) return new PermissionDeniedError(init);
  if (status === 404) return new NotFoundError(init);
  if (status === 409) return new ConflictError(init);
  if (status === 422) return new ValidationError(init);
  if (status === 429) return new RateLimitError(init);
  if (status >= 500) return new ServerError(init);
  return new PrefectApiError(init);
}

/** Pulls the explanation out of either Prefect error body shape. */
export function extractDetail(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if ('detail' in record) return record.detail;
    if ('exception_detail' in record) return record.exception_detail;
    if ('exception_message' in record) return record.exception_message;
    if ('message' in record) return record.message;
  }
  if (typeof body === 'string' && body.length > 0) return body;
  return undefined;
}

/**
 * Parses a Retry-After header, either delta-seconds or an HTTP date, into milliseconds.
 * Returns undefined for a missing or unreadable value.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  // An HTTP date always names the month. Without this check Date.parse("-1") is a valid date.
  if (!/[A-Za-z]{3}/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function describe(detail: unknown): string {
  if (detail === undefined || detail === null) return '';
  if (typeof detail === 'string') return `: ${detail}`;
  if (Array.isArray(detail)) {
    const parts = detail.map((issue) => {
      if (issue && typeof issue === 'object' && 'msg' in issue) {
        const { loc, msg } = issue as { loc?: unknown; msg: unknown };
        const where = Array.isArray(loc) ? loc.filter((part) => part !== 'body').join('.') : '';
        return where ? `${where}: ${String(msg)}` : String(msg);
      }
      return JSON.stringify(issue);
    });
    return `: ${parts.join(', ')}`;
  }
  return `: ${JSON.stringify(detail)}`;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
