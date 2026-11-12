import { apiErrorFor, parseRetryAfter, PrefectConnectionError, PrefectTimeoutError } from './errors.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];

export interface RetryOptions {
  /** Extra attempts after the first one. 0 turns retries off. @default 3 */
  maxRetries?: number;
  /** First backoff step. Each retry doubles it, with full jitter. @default 500 */
  baseDelayMs?: number;
  /** Ceiling for one backoff step and for a Retry-After wait. @default 30000 */
  maxDelayMs?: number;
  /**
   * Statuses that are retried for every request. A 500, a timeout and a network error
   * are only retried for requests that are safe to repeat (reads, PUT, DELETE and the
   * read-only `filter`, `count`, `paginate` and `history` POST endpoints), so a create
   * call is never sent twice after the server may have already stored it.
   * @default [429, 502, 503, 504]
   */
  statuses?: number[];
}

/** Options that every call accepts as its last argument. */
export interface RequestOptions {
  /** Cancels the call, including any backoff wait in progress. */
  signal?: AbortSignal;
  /** Per-attempt timeout for this call. 0 turns it off. */
  timeoutMs?: number;
  /** Overrides `retry.maxRetries` for this call. */
  maxRetries?: number;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
}

export interface TransportConfig {
  apiUrl: string;
  headers: Record<string, string>;
  fetch: FetchLike;
  timeoutMs: number;
  retry: Required<RetryOptions>;
  /** Used by tests to skip real waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Used by tests to make jitter predictable. Returns a number in [0, 1). */
  random?: () => number;
  /** Used by tests to control the clock in `flowRuns.wait`. */
  now?: () => number;
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** 'text' returns the raw body, used for CSV log downloads. */
  responseType?: 'json' | 'text';
}

export const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  statuses: [429, 502, 503, 504],
};

const SAFE_METHODS = new Set(['GET', 'PUT', 'DELETE']);
const READ_ONLY_POST = /\/(filter|count|paginate|history|lateness)\/?$/;

/** True when repeating the request cannot create a second object. */
export function isSafeToRepeat(method: string, path: string): boolean {
  if (SAFE_METHODS.has(method)) return true;
  return method === 'POST' && READ_ONLY_POST.test(path);
}

/**
 * Builds a path from a template, percent-encoding each interpolated value.
 * `path\`/flows/name/${name}\`` turns "my flow" into "my%20flow".
 */
export function path(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    const text = String(value);
    if (text === '') throw new TypeError('A path segment cannot be empty');
    out += encodeURIComponent(text) + (strings[index + 1] ?? '');
  });
  return out;
}

export function buildUrl(apiUrl: string, requestPath: string, query?: Record<string, QueryValue>): string {
  const base = apiUrl.replace(/\/+$/, '');
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const search = params.toString();
  return search ? `${base}${suffix}?${search}` : `${base}${suffix}`;
}

/** Backoff for retry number `attempt` (0-based): full jitter over base * 2^attempt. */
export function backoffDelay(attempt: number, retry: Required<RetryOptions>, random: () => number): number {
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Transport {
  readonly config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  /** Waits, honoring the abort signal. Tests swap the implementation through `config.sleep`. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.config.sleep ?? sleep)(ms, signal);
  }

  now(): number {
    return (this.config.now ?? Date.now)();
  }

  async request<T>(req: ApiRequest, options: RequestOptions = {}): Promise<T> {
    const { config } = this;
    const url = buildUrl(config.apiUrl, req.path, req.query);
    const maxRetries = options.maxRetries ?? config.retry.maxRetries;
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    const safe = isSafeToRepeat(req.method, req.path);
    const wait = config.sleep ?? sleep;
    const random = config.random ?? Math.random;

    const headers: Record<string, string> = { accept: 'application/json', ...config.headers, ...options.headers };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.send(url, { method: req.method, headers, body }, timeoutMs, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        const failure =
          error instanceof PrefectTimeoutError ? error : new PrefectConnectionError(req.method, url, error);
        if (safe && attempt < maxRetries) {
          await wait(backoffDelay(attempt, config.retry, random), options.signal);
          continue;
        }
        throw failure;
      }

      if (response.ok) {
        return (await readBody(response, req.responseType ?? 'json')) as T;
      }

      const errorBody = await readBody(response, 'json').catch(() => undefined);
      const error = apiErrorFor({
        status: response.status,
        method: req.method,
        url,
        body: errorBody,
        headers: response.headers,
      });
      const retryable = config.retry.statuses.includes(response.status) || (safe && response.status === 500);
      if (retryable && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const delay =
          retryAfter !== undefined
            ? Math.min(retryAfter, config.retry.maxDelayMs)
            : backoffDelay(attempt, config.retry, random);
        await wait(delay, options.signal);
        continue;
      }
      throw error;
    }
  }

  private async send(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    try {
      const response = await this.config.fetch(url, { ...init, signal: controller.signal });
      return response;
    } catch (error) {
      if (timedOut) throw new PrefectTimeoutError(String(init.method), url, timeoutMs);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

async function readBody(response: Response, type: 'json' | 'text'): Promise<unknown> {
  const text = await response.text();
  if (type === 'text') return text;
  if (text === '') return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json') || /^[\s]*[[{"]|^(true|false|null|-?\d)/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
