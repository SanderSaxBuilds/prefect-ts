import type { Paging } from './types.ts';

/** The server rejects a limit above this (PREFECT_SERVER_API_DEFAULT_LIMIT) with a 422. */
export const MAX_PAGE_SIZE = 200;

export interface IterateOptions {
  /** Objects per request. @default 200 */
  pageSize?: number;
  /** Stop after this many objects in total. */
  max?: number;
  signal?: AbortSignal;
}

/**
 * Walks a limit and offset endpoint page by page, yielding one object at a time.
 * `fetchPage` gets the paging for each request and returns that page.
 *
 * The walk stops when a page comes back shorter than the page size, or when `max`
 * objects have been yielded. `offset` in `start` is honored as the first offset.
 */
export async function* paginate<T>(
  fetchPage: (paging: Required<Paging>) => Promise<T[]>,
  options: IterateOptions = {},
  start: Paging = {},
): AsyncGenerator<T, void, undefined> {
  const pageSize = options.pageSize ?? start.limit ?? MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
  }
  const max = options.max ?? Number.POSITIVE_INFINITY;
  let offset = start.offset ?? 0;
  let yielded = 0;
  while (yielded < max) {
    options.signal?.throwIfAborted();
    const limit = Math.min(pageSize, max - yielded);
    const page = await fetchPage({ limit, offset });
    for (const item of page) {
      yield item;
      yielded++;
      if (yielded >= max) return;
    }
    if (page.length < limit) return;
    offset += page.length;
  }
}

/** Collects an async iterable into an array. */
export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}
