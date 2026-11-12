import { path } from '../http.ts';
import type {
  WorkPool,
  WorkPoolCountQuery,
  WorkPoolCreate,
  WorkPoolQuery,
  WorkQueue,
  WorkQueueQuery,
  WorkQueueStatus,
} from '../types.ts';
import type { Body_read_work_queues_work_pools__work_pool_name__queues_filter_post } from '../schema.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

export type PoolQueueQuery = Omit<Body_read_work_queues_work_pools__work_pool_name__queues_filter_post, 'limit' | 'offset'> & {
  limit?: number;
  offset?: number;
};

export class WorkPools extends Resource {
  get(name: string, options?: CallOptions): Promise<WorkPool> {
    return this.doGet<WorkPool>(path`/work_pools/${name}`, undefined, options);
  }

  list(query: WorkPoolQuery = {}, options?: CallOptions): Promise<WorkPool[]> {
    return this.doPost<WorkPool[]>('/work_pools/filter', query, options);
  }

  iterate(query?: WorkPoolQuery, options?: IterateOptions & CallOptions): AsyncGenerator<WorkPool, void, undefined> {
    return this.iterateFilter<WorkPool, WorkPoolQuery>('/work_pools/filter', query, options);
  }

  count(query: WorkPoolCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/work_pools/count', query, options);
  }

  create(body: WorkPoolCreate, options?: CallOptions): Promise<WorkPool> {
    return this.doPost<WorkPool>('/work_pools/', body, options);
  }

  delete(name: string, options?: CallOptions): Promise<void> {
    return this.doDelete(path`/work_pools/${name}`, options);
  }

  /** Queues of one pool. Every pool has at least the queue named "default". */
  queues(poolName: string, query: PoolQueueQuery = {}, options?: CallOptions): Promise<WorkQueue[]> {
    return this.doPost<WorkQueue[]>(path`/work_pools/${poolName}/queues/filter`, query, options);
  }

  queue(poolName: string, queueName: string, options?: CallOptions): Promise<WorkQueue> {
    return this.doGet<WorkQueue>(path`/work_pools/${poolName}/queues/${queueName}`, undefined, options);
  }
}

export class WorkQueues extends Resource {
  get(id: string, options?: CallOptions): Promise<WorkQueue> {
    return this.doGet<WorkQueue>(path`/work_queues/${id}`, undefined, options);
  }

  /** Reads a queue of the default work pool by name. For other pools use `workPools.queue`. */
  getByName(name: string, options?: CallOptions): Promise<WorkQueue> {
    return this.doGet<WorkQueue>(path`/work_queues/name/${name}`, undefined, options);
  }

  list(query: WorkQueueQuery = {}, options?: CallOptions): Promise<WorkQueue[]> {
    return this.doPost<WorkQueue[]>('/work_queues/filter', query, options);
  }

  iterate(query?: WorkQueueQuery, options?: IterateOptions & CallOptions): AsyncGenerator<WorkQueue, void, undefined> {
    return this.iterateFilter<WorkQueue, WorkQueueQuery>('/work_queues/filter', query, options);
  }

  /** Health of a queue: whether it is ready, and when a worker last polled it. */
  status(id: string, options?: CallOptions): Promise<WorkQueueStatus> {
    return this.doGet<WorkQueueStatus>(path`/work_queues/${id}/status`, undefined, options);
  }
}
