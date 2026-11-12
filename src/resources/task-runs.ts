import { path } from '../http.ts';
import type { Log, LogCreate, LogQuery, Page, State, TaskRun, TaskRunCountQuery, TaskRunPageQuery, TaskRunQuery } from '../types.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

export class TaskRuns extends Resource {
  get(id: string, options?: CallOptions): Promise<TaskRun> {
    return this.doGet<TaskRun>(path`/task_runs/${id}`, undefined, options);
  }

  list(query: TaskRunQuery = {}, options?: CallOptions): Promise<TaskRun[]> {
    return this.doPost<TaskRun[]>('/task_runs/filter', query, options);
  }

  iterate(query?: TaskRunQuery, options?: IterateOptions & CallOptions): AsyncGenerator<TaskRun, void, undefined> {
    return this.iterateFilter<TaskRun, TaskRunQuery>('/task_runs/filter', query, options);
  }

  count(query: TaskRunCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/task_runs/count', query, options);
  }

  page(query: TaskRunPageQuery = {}, options?: CallOptions): Promise<Page<TaskRun>> {
    return this.doPost<Page<TaskRun>>('/task_runs/paginate', query, options);
  }

  /** Every state the task run has been in, oldest first. */
  states(id: string, options?: CallOptions): Promise<State[]> {
    return this.doGet<State[]>('/task_run_states/', { task_run_id: id }, options);
  }
}

export class Logs extends Resource {
  /** One page of logs. Sorted by timestamp, oldest first, unless `sort` says otherwise. */
  list(query: LogQuery = {}, options?: CallOptions): Promise<Log[]> {
    return this.doPost<Log[]>('/logs/filter', query, options);
  }

  iterate(query?: LogQuery, options?: IterateOptions & CallOptions): AsyncGenerator<Log, void, undefined> {
    return this.iterateFilter<Log, LogQuery>('/logs/filter', query, options);
  }

  /** Writes log lines. `level` is the Python logging number (10 debug, 20 info, 30 warning, 40 error). */
  create(logs: LogCreate[], options?: CallOptions): Promise<void> {
    return this.doPost<void>('/logs/', logs, options).then(() => undefined);
  }
}
