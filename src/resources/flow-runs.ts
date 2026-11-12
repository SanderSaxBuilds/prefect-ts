import { FlowRunFailedError, FlowRunTimeoutError } from '../errors.ts';
import { path } from '../http.ts';
import type {
  FlowRun,
  FlowRunCountQuery,
  FlowRunCreate,
  FlowRunPageQuery,
  FlowRunQuery,
  FlowRunUpdate,
  Log,
  LogQuery,
  OrchestrationResult,
  Page,
  State,
  StateCreate,
  TaskRun,
  TaskRunQuery,
} from '../types.ts';
import { isTerminalState } from '../types.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

export interface SetStateOptions extends CallOptions {
  /** Skips the server's orchestration rules. @default false */
  force?: boolean;
}

export interface CancelOptions extends SetStateOptions {
  /** Saved as the state message. */
  message?: string;
}

export interface WaitOptions {
  /** Give up after this long and throw FlowRunTimeoutError. 0 waits forever. @default 10800000 (3 hours, as in the Python SDK) */
  timeoutMs?: number;
  /** Time between reads. @default 2000 */
  pollIntervalMs?: number;
  /** Throw FlowRunFailedError when the run ends in FAILED, CRASHED or CANCELLED. @default false */
  throwOnFailure?: boolean;
  /** Called with each read, for progress output. */
  onPoll?: (flowRun: FlowRun) => void;
  signal?: AbortSignal;
}

export class FlowRuns extends Resource {
  /** Creates a flow run directly from a flow id. To run a deployment, use `deployments.createFlowRun`. */
  create(body: FlowRunCreate, options?: CallOptions): Promise<FlowRun> {
    return this.doPost<FlowRun>('/flow_runs/', body, options);
  }

  get(id: string, options?: CallOptions): Promise<FlowRun> {
    return this.doGet<FlowRun>(path`/flow_runs/${id}`, undefined, options);
  }

  update(id: string, body: FlowRunUpdate, options?: CallOptions): Promise<void> {
    return this.doPatch(path`/flow_runs/${id}`, body, options);
  }

  delete(id: string, options?: CallOptions): Promise<void> {
    return this.doDelete(path`/flow_runs/${id}`, options);
  }

  list(query: FlowRunQuery = {}, options?: CallOptions): Promise<FlowRun[]> {
    return this.doPost<FlowRun[]>('/flow_runs/filter', query, options);
  }

  iterate(query?: FlowRunQuery, options?: IterateOptions & CallOptions): AsyncGenerator<FlowRun, void, undefined> {
    return this.iterateFilter<FlowRun, FlowRunQuery>('/flow_runs/filter', query, options);
  }

  count(query: FlowRunCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/flow_runs/count', query, options);
  }

  page(query: FlowRunPageQuery = {}, options?: CallOptions): Promise<Page<FlowRun>> {
    return this.doPost<Page<FlowRun>>('/flow_runs/paginate', query, options);
  }

  /**
   * Proposes a new state. The server may accept it, change it, or reject it: always
   * check `result.status` (ACCEPT, REJECT, WAIT, ABORT) and `result.state`.
   */
  setState(id: string, state: StateCreate, options: SetStateOptions = {}): Promise<OrchestrationResult> {
    const { force = false, ...call } = options;
    return this.doPost<OrchestrationResult>(path`/flow_runs/${id}/set_state`, { state, force }, call);
  }

  /**
   * Asks for cancellation by proposing CANCELLING, as `prefect flow-run cancel` does.
   * A running flow moves to CANCELLING and its worker stops it. A run that never
   * started (SCHEDULED, PENDING) is moved straight to CANCELLED by the server, which
   * reports that as status REJECT with a CANCELLED state. Both count as success here,
   * so check `result.state.type`.
   */
  cancel(id: string, options: CancelOptions = {}): Promise<OrchestrationResult> {
    const { message, ...rest } = options;
    return this.setState(id, { type: 'CANCELLING', name: 'Cancelling', ...(message ? { message } : {}) }, rest);
  }

  /** Resumes a paused run, optionally with the input it is waiting for. */
  resume(id: string, runInput?: Record<string, unknown>, options?: CallOptions): Promise<OrchestrationResult> {
    return this.doPost<OrchestrationResult>(
      path`/flow_runs/${id}/resume`,
      runInput ? { run_input: runInput } : {},
      options,
    );
  }

  /** Every state the run has been in, oldest first. */
  states(id: string, options?: CallOptions): Promise<State[]> {
    return this.doGet<State[]>('/flow_run_states/', { flow_run_id: id }, options);
  }

  /**
   * Polls the run until it reaches COMPLETED, FAILED, CANCELLED or CRASHED and returns
   * the final read. Throws FlowRunTimeoutError when `timeoutMs` runs out first.
   */
  async wait(id: string, options: WaitOptions = {}): Promise<FlowRun> {
    const timeoutMs = options.timeoutMs ?? 10_800_000;
    const interval = options.pollIntervalMs ?? 2000;
    if (!(interval > 0)) throw new RangeError(`pollIntervalMs must be positive, got ${interval}`);
    const started = this.transport.now();
    const signalOption = options.signal ? { signal: options.signal } : {};

    for (;;) {
      const run = await this.get(id, signalOption);
      options.onPoll?.(run);
      if (isTerminalState(run.state_type)) {
        if (options.throwOnFailure && run.state_type !== 'COMPLETED') throw new FlowRunFailedError(run);
        return run;
      }
      const elapsed = this.transport.now() - started;
      if (timeoutMs > 0 && elapsed >= timeoutMs) throw new FlowRunTimeoutError(run, timeoutMs);
      const remaining = timeoutMs > 0 ? timeoutMs - elapsed : interval;
      await this.transport.wait(Math.min(interval, remaining), options.signal);
    }
  }

  /** Logs written by the run and its tasks, oldest first by default. */
  logs(id: string, query: LogQuery = {}, options?: CallOptions): Promise<Log[]> {
    return this.doPost<Log[]>('/logs/filter', withFlowRunLogs(id, query), options);
  }

  /** Every log line of the run, across as many pages as needed. */
  iterateLogs(id: string, query: LogQuery = {}, options?: IterateOptions & CallOptions): AsyncGenerator<Log, void, undefined> {
    return this.iterateFilter<Log, LogQuery>('/logs/filter', withFlowRunLogs(id, query), options);
  }

  /** The run's logs as the CSV file the Prefect UI offers for download. */
  downloadLogs(id: string, options?: CallOptions): Promise<string> {
    return this.transport.request<string>(
      { method: 'GET', path: path`/flow_runs/${id}/logs/download`, responseType: 'text' },
      options,
    );
  }

  /** Task runs that belong to this flow run. */
  taskRuns(id: string, query: TaskRunQuery = {}, options?: CallOptions): Promise<TaskRun[]> {
    const flowRuns = { ...(query.flow_runs ?? {}), id: { any_: [id] } };
    return this.doPost<TaskRun[]>('/task_runs/filter', { sort: 'EXPECTED_START_TIME_ASC', ...query, flow_runs: flowRuns }, options);
  }
}

function withFlowRunLogs(id: string, query: LogQuery): LogQuery {
  return { ...query, logs: { ...(query.logs ?? {}), flow_run_id: { any_: [id] } } };
}
