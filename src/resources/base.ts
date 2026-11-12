import type { RequestOptions, Transport } from '../http.ts';
import { paginate, type IterateOptions } from '../pagination.ts';
import type { Paging } from '../types.ts';

export type CallOptions = RequestOptions;

export abstract class Resource {
  protected readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  protected doGet<T>(path: string, query?: Record<string, string | number | boolean | undefined>, options?: CallOptions) {
    return this.transport.request<T>({ method: 'GET', path, ...(query ? { query } : {}) }, options);
  }

  protected doPost<T>(path: string, body: unknown, options?: CallOptions) {
    return this.transport.request<T>({ method: 'POST', path, body }, options);
  }

  protected doPatch(path: string, body: unknown, options?: CallOptions) {
    return this.transport.request<void>({ method: 'PATCH', path, body }, options);
  }

  protected doPut(path: string, body: unknown, options?: CallOptions) {
    return this.transport.request<void>({ method: 'PUT', path, body }, options);
  }

  protected doDelete(path: string, options?: CallOptions) {
    return this.transport.request<void>({ method: 'DELETE', path }, options);
  }

  /** Shared body of every `iterate` method: walks a filter endpoint with limit and offset. */
  protected iterateFilter<T, Q extends Paging>(
    path: string,
    query: Q | undefined,
    options: IterateOptions & CallOptions = {},
  ): AsyncGenerator<T, void, undefined> {
    const { pageSize, max, ...call } = options;
    const start = query ?? ({} as Q);
    return paginate<T>(
      (paging) => this.doPost<T[]>(path, { ...start, ...paging }, call),
      { ...(pageSize !== undefined ? { pageSize } : {}), ...(max !== undefined ? { max } : {}), ...(call.signal ? { signal: call.signal } : {}) },
      start,
    );
  }
}

export type { IterateOptions };
