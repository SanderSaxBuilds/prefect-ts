import type * as schema from './schema.ts';

/**
 * The spec marks every field that has a server-side default as optional, because the
 * same pydantic model describes what you send and what comes back. The server always
 * returns every field (null when empty), so response models drop the `?` here.
 * The integration suite checks that against a live server.
 */
export type Returned<T> = { [K in keyof T]-?: T[K] };

export type StateType = schema.StateType;
export type StateDetails = Returned<schema.StateDetails>;
export type State = Returned<Omit<schema.State, 'state_details'>> & { state_details: StateDetails };

export type Flow = Returned<schema.Flow>;
export type Deployment = Returned<schema.DeploymentResponse>;
export type DeploymentSchedule = Returned<schema.DeploymentSchedule>;
export type FlowRun = Returned<Omit<schema.FlowRunResponse, 'state'>> & { state: State | null };
export type TaskRun = Returned<Omit<schema.TaskRun, 'state'>> & { state: State | null };
export type Log = Returned<schema.Log>;
export type WorkPool = Returned<schema.WorkPoolResponse>;
export type WorkQueue = Returned<schema.WorkQueueResponse>;
export type WorkQueueStatus = Returned<schema.WorkQueueStatusDetail>;
export type Variable = Returned<schema.Variable>;
export type BlockType = Returned<schema.BlockType>;
export type BlockSchema = Returned<schema.BlockSchema>;
export type BlockDocument = Returned<schema.BlockDocument>;
export type Automation = Returned<schema.Automation>;

export type OrchestrationResult = Omit<schema.OrchestrationResult, 'state'> & { state: State | null };

export interface Page<T> {
  results: T[];
  /** Total number of matching objects. */
  count: number;
  limit: number;
  /** Total number of pages. */
  pages: number;
  /** 1-based page number. */
  page: number;
}

/** States after which a run never changes again without outside action. */
export const TERMINAL_STATE_TYPES: readonly StateType[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED'];

export function isTerminalState(type: StateType | null | undefined): boolean {
  return type !== null && type !== undefined && TERMINAL_STATE_TYPES.includes(type);
}

/** Body for `set_state`. Only `type` is required. */
export type StateCreate = schema.StateCreate;

export type FlowCreate = schema.FlowCreate;
export type FlowUpdate = schema.FlowUpdate;
export type DeploymentCreate = schema.DeploymentCreate;
export type DeploymentUpdate = schema.DeploymentUpdate;
export type DeploymentFlowRunCreate = schema.DeploymentFlowRunCreate;
export type FlowRunCreate = schema.FlowRunCreate;
export type FlowRunUpdate = schema.FlowRunUpdate;
export type LogCreate = schema.LogCreate;
export type VariableCreate = schema.VariableCreate;
export type VariableUpdate = schema.VariableUpdate;
export type WorkPoolCreate = schema.WorkPoolCreate;

export type FlowFilter = schema.FlowFilter;
export type FlowRunFilter = schema.FlowRunFilter;
export type TaskRunFilter = schema.TaskRunFilter;
export type DeploymentFilter = schema.DeploymentFilter;
export type WorkPoolFilter = schema.WorkPoolFilter;
export type WorkQueueFilter = schema.WorkQueueFilter;
export type LogFilter = schema.LogFilter;
export type VariableFilter = schema.VariableFilter;
export type BlockDocumentFilter = schema.BlockDocumentFilter;
export type BlockTypeFilter = schema.BlockTypeFilter;
export type BlockSchemaFilter = schema.BlockSchemaFilter;
export type AutomationFilter = schema.AutomationFilter;

export type FlowSort = schema.FlowSort;
export type FlowRunSort = schema.FlowRunSort;
export type TaskRunSort = schema.TaskRunSort;
export type DeploymentSort = schema.DeploymentSort;
export type LogSort = schema.LogSort;
export type VariableSort = schema.VariableSort;
export type BlockDocumentSort = schema.BlockDocumentSort;
export type AutomationSort = schema.AutomationSort;

/** limit and offset, shared by every filter endpoint. The server caps limit at 200 by default. */
export interface Paging {
  limit?: number;
  offset?: number;
}

export type FlowQuery = Omit<schema.Body_read_flows_flows_filter_post, 'limit' | 'offset'> & Paging;
export type FlowRunQuery = Omit<schema.Body_read_flow_runs_flow_runs_filter_post, 'limit' | 'offset'> & Paging;
export type TaskRunQuery = Omit<schema.Body_read_task_runs_task_runs_filter_post, 'limit' | 'offset'> & Paging;
export type DeploymentQuery = Omit<schema.Body_read_deployments_deployments_filter_post, 'limit' | 'offset'> & Paging;
export type LogQuery = Omit<schema.Body_read_logs_logs_filter_post, 'limit' | 'offset'> & Paging;
export type VariableQuery = Omit<schema.Body_read_variables_variables_filter_post, 'limit' | 'offset'> & Paging;
export type WorkPoolQuery = Omit<schema.Body_read_work_pools_work_pools_filter_post, 'limit' | 'offset'> & Paging;
export type WorkQueueQuery = Omit<schema.Body_read_work_queues_work_queues_filter_post, 'limit' | 'offset'> & Paging;
export type BlockDocumentQuery = Omit<
  schema.Body_read_block_documents_block_documents_filter_post,
  'limit' | 'offset'
> &
  Paging;
export type BlockTypeQuery = Omit<schema.Body_read_block_types_block_types_filter_post, 'limit' | 'offset'> & Paging;
export type BlockSchemaQuery = Omit<schema.Body_read_block_schemas_block_schemas_filter_post, 'limit' | 'offset'> &
  Paging;
export type AutomationQuery = Omit<schema.Body_read_automations_automations_filter_post, 'limit' | 'offset'> & Paging;

export type FlowCountQuery = schema.Body_count_flows_flows_count_post;
export type FlowRunCountQuery = schema.Body_count_flow_runs_flow_runs_count_post;
export type TaskRunCountQuery = schema.Body_count_task_runs_task_runs_count_post;
export type DeploymentCountQuery = schema.Body_count_deployments_deployments_count_post;
export type VariableCountQuery = schema.Body_count_variables_variables_count_post;
export type WorkPoolCountQuery = schema.Body_count_work_pools_work_pools_count_post;
export type BlockDocumentCountQuery = schema.Body_count_block_documents_block_documents_count_post;
export type AutomationCountQuery = schema.Body_count_automations_automations_count_post;

export type FlowPageQuery = Omit<schema.Body_paginate_flows_flows_paginate_post, 'page' | 'limit'> & PageParams;
export type FlowRunPageQuery = Omit<schema.Body_paginate_flow_runs_flow_runs_paginate_post, 'page' | 'limit'> &
  PageParams;
export type TaskRunPageQuery = Omit<schema.Body_paginate_task_runs_task_runs_paginate_post, 'page' | 'limit'> &
  PageParams;
export type DeploymentPageQuery = Omit<schema.Body_paginate_deployments_deployments_paginate_post, 'page' | 'limit'> &
  PageParams;

/** For the `paginate` endpoints, which count pages from 1 instead of using offset. */
export interface PageParams {
  page?: number;
  limit?: number;
}
