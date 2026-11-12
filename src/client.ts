import { PrefectError } from './errors.ts';
import { DEFAULT_RETRY, Transport, type FetchLike, type RequestOptions, type RetryOptions } from './http.ts';
import { Automations } from './resources/automations.ts';
import { Blocks } from './resources/blocks.ts';
import { Deployments } from './resources/deployments.ts';
import { FlowRuns } from './resources/flow-runs.ts';
import { Flows } from './resources/flows.ts';
import { Logs, TaskRuns } from './resources/task-runs.ts';
import { Variables } from './resources/variables.ts';
import { WorkPools, WorkQueues } from './resources/work-pools.ts';

export const VERSION = '0.1.0';
/** The Prefect REST API version this client was written against (GET /version). */
export const API_VERSION = '0.8.4';
export const DEFAULT_API_URL = 'http://127.0.0.1:4200/api';
export const CLOUD_API_URL = 'https://api.prefect.cloud/api';

export interface PrefectClientOptions {
  /**
   * Full API URL, the same value as PREFECT_API_URL. For a self-hosted server that is
   * usually `http://host:4200/api`. For Prefect Cloud it is
   * `https://api.prefect.cloud/api/accounts/<account>/workspaces/<workspace>`.
   * Leave it out and pass `accountId` and `workspaceId` to build the Cloud URL.
   * @default "http://127.0.0.1:4200/api"
   */
  apiUrl?: string;
  /** Prefect Cloud API key (PREFECT_API_KEY), sent as `Authorization: Bearer`. */
  apiKey?: string;
  /** `user:password` for a self-hosted server with basic auth on (PREFECT_API_AUTH_STRING). */
  authString?: string;
  /** Prefect Cloud account id. Needs `workspaceId` too. */
  accountId?: string;
  /** Prefect Cloud workspace id. Needs `accountId` too. */
  workspaceId?: string;
  /** Base of the Cloud API, for Cloud regions or a proxy. @default "https://api.prefect.cloud/api" */
  cloudApiUrl?: string;
  /** Per-attempt timeout in milliseconds. 0 turns it off. @default 30000 */
  timeoutMs?: number;
  retry?: RetryOptions;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /**
   * Sent as X-PREFECT-API-VERSION. The server rejects a version older than it supports
   * with a 400, so keep this at the default unless you pin a server. `false` leaves the
   * header out.
   * @default "0.8.4"
   */
  apiVersion?: string | false;
  /** A fetch implementation. @default globalThis.fetch */
  fetch?: FetchLike;
}

export interface ClientInternals {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

type Env = Record<string, string | undefined>;

export class PrefectClient {
  readonly apiUrl: string;
  readonly flows: Flows;
  readonly deployments: Deployments;
  readonly flowRuns: FlowRuns;
  readonly taskRuns: TaskRuns;
  readonly logs: Logs;
  readonly workPools: WorkPools;
  readonly workQueues: WorkQueues;
  readonly variables: Variables;
  readonly blocks: Blocks;
  readonly automations: Automations;
  private readonly transport: Transport;

  constructor(options: PrefectClientOptions = {}, internals: ClientInternals = {}) {
    this.apiUrl = resolveApiUrl(options);
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new PrefectError('No fetch implementation found. Pass one as options.fetch.');
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!(timeoutMs >= 0)) throw new RangeError(`timeoutMs must be 0 or more, got ${timeoutMs}`);
    const retry = { ...DEFAULT_RETRY, ...definedOnly(options.retry ?? {}) };
    if (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0) {
      throw new RangeError(`retry.maxRetries must be a whole number of 0 or more, got ${retry.maxRetries}`);
    }

    this.transport = new Transport({
      apiUrl: this.apiUrl,
      headers: buildHeaders(options),
      fetch: fetchImpl,
      timeoutMs,
      retry,
      ...definedOnly(internals),
    });

    this.flows = new Flows(this.transport);
    this.deployments = new Deployments(this.transport);
    this.flowRuns = new FlowRuns(this.transport);
    this.taskRuns = new TaskRuns(this.transport);
    this.logs = new Logs(this.transport);
    this.workPools = new WorkPools(this.transport);
    this.workQueues = new WorkQueues(this.transport);
    this.variables = new Variables(this.transport);
    this.blocks = new Blocks(this.transport);
    this.automations = new Automations(this.transport);
  }

  /**
   * Reads PREFECT_API_URL, PREFECT_API_KEY and PREFECT_API_AUTH_STRING, the same
   * variables the Python SDK uses. `overrides` win over the environment.
   */
  static fromEnv(overrides: PrefectClientOptions = {}, env: Env = processEnv()): PrefectClient {
    const fromEnv: PrefectClientOptions = {};
    if (env.PREFECT_API_URL) fromEnv.apiUrl = env.PREFECT_API_URL;
    if (env.PREFECT_API_KEY) fromEnv.apiKey = env.PREFECT_API_KEY;
    if (env.PREFECT_API_AUTH_STRING) fromEnv.authString = env.PREFECT_API_AUTH_STRING;
    return new PrefectClient({ ...fromEnv, ...definedOnly(overrides) });
  }

  /** Shortcut for a Prefect Cloud workspace. */
  static cloud(
    options: { accountId: string; workspaceId: string; apiKey: string } & Omit<PrefectClientOptions, 'apiUrl'>,
  ): PrefectClient {
    return new PrefectClient(options);
  }

  /** True when the server answers its health check. Never throws for a down server. */
  async health(options?: RequestOptions): Promise<boolean> {
    try {
      return (await this.transport.request<boolean>({ method: 'GET', path: '/health' }, options)) === true;
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      return false;
    }
  }

  /** Throws unless the server is up and its database is reachable. Self-hosted servers only. */
  async ready(options?: RequestOptions): Promise<void> {
    await this.transport.request<unknown>({ method: 'GET', path: '/ready' }, options);
  }

  /** The Prefect server version, such as "3.9.2" (GET /admin/version). */
  serverVersion(options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: 'GET', path: '/admin/version' }, options);
  }

  /** The REST API version, such as "0.8.4" (GET /version). Not the Prefect release. */
  apiVersion(options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: 'GET', path: '/version' }, options);
  }

  /**
   * Sends any request to the API, for endpoints this client does not wrap yet. Auth,
   * retries, timeouts and typed errors work the same as for the wrapped calls.
   */
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    options?: RequestOptions & { query?: Record<string, string | number | boolean | undefined> },
  ): Promise<T> {
    const { query, ...rest } = options ?? {};
    return this.transport.request<T>(
      { method, path, ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) },
      rest,
    );
  }
}

export function resolveApiUrl(options: PrefectClientOptions): string {
  const { apiUrl, accountId, workspaceId } = options;
  if ((accountId === undefined) !== (workspaceId === undefined)) {
    throw new PrefectError('Prefect Cloud needs both accountId and workspaceId');
  }
  if (accountId !== undefined && workspaceId !== undefined) {
    if (apiUrl !== undefined) throw new PrefectError('Pass either apiUrl or accountId and workspaceId, not both');
    if (!accountId || !workspaceId) throw new PrefectError('accountId and workspaceId cannot be empty');
    const base = (options.cloudApiUrl ?? CLOUD_API_URL).replace(/\/+$/, '');
    return `${base}/accounts/${encodeURIComponent(accountId)}/workspaces/${encodeURIComponent(workspaceId)}`;
  }
  const url = (apiUrl ?? DEFAULT_API_URL).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PrefectError(`apiUrl is not a valid URL: ${apiUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PrefectError(`apiUrl must use http or https, got ${parsed.protocol}`);
  }
  return url;
}

function buildHeaders(options: PrefectClientOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiVersion = options.apiVersion ?? API_VERSION;
  if (apiVersion !== false) headers['x-prefect-api-version'] = apiVersion;
  if (options.apiKey && options.authString) {
    throw new PrefectError('Pass either apiKey or authString, not both');
  }
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  if (options.authString) headers.authorization = `Basic ${base64(options.authString)}`;
  return { ...headers, ...options.headers };
}

export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function processEnv(): Env {
  const proc = (globalThis as { process?: { env?: Env } }).process;
  return proc?.env ?? {};
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
