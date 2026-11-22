import { path } from '../http.ts';
import type {
  Deployment,
  DeploymentCountQuery,
  DeploymentCreate,
  DeploymentFlowRunCreate,
  DeploymentPageQuery,
  DeploymentQuery,
  DeploymentSchedule,
  DeploymentUpdate,
  FlowRun,
  Page,
} from '../types.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

export class Deployments extends Resource {
  /**
   * Creates a deployment, or updates the one with the same flow and name.
   * Prefect treats this endpoint as an upsert.
   */
  create(body: DeploymentCreate, options?: CallOptions): Promise<Deployment> {
    return this.doPost<Deployment>('/deployments/', body, options);
  }

  get(id: string, options?: CallOptions): Promise<Deployment> {
    return this.doGet<Deployment>(path`/deployments/${id}`, undefined, options);
  }

  /**
   * Reads a deployment by flow name and deployment name, the `flow/deployment` form
   * the Prefect CLI uses. `getByName("etl/nightly")` and `getByName("etl", "nightly")`
   * are the same call.
   */
  getByName(flowName: string, deploymentName?: string, options?: CallOptions): Promise<Deployment> {
    const [flow, deployment] = splitDeploymentName(flowName, deploymentName);
    return this.doGet<Deployment>(path`/deployments/name/${flow}/${deployment}`, undefined, options);
  }

  /**
   * Updates a deployment and returns no content (204).
   * BadRequestError (400) means the deployment parameters could not be hydrated.
   * NotFoundError (404) means the deployment or concurrency limit could not be found.
   * ConflictError (409) covers invalid job variables for the work pool, a mismatch
   * with an enforced parameter schema, or an invalid deployment parameter schema.
   * ValidationError (422) reports request validation failures.
   */
  update(id: string, body: DeploymentUpdate, options?: CallOptions): Promise<void> {
    return this.doPatch(path`/deployments/${id}`, body, options);
  }

  delete(id: string, options?: CallOptions): Promise<void> {
    return this.doDelete(path`/deployments/${id}`, options);
  }

  list(query: DeploymentQuery = {}, options?: CallOptions): Promise<Deployment[]> {
    return this.doPost<Deployment[]>('/deployments/filter', query, options);
  }

  iterate(
    query?: DeploymentQuery,
    options?: IterateOptions & CallOptions,
  ): AsyncGenerator<Deployment, void, undefined> {
    return this.iterateFilter<Deployment, DeploymentQuery>('/deployments/filter', query, options);
  }

  count(query: DeploymentCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/deployments/count', query, options);
  }

  page(query: DeploymentPageQuery = {}, options?: CallOptions): Promise<Page<Deployment>> {
    return this.doPost<Page<Deployment>>('/deployments/paginate', query, options);
  }

  /**
   * Creates a flow run from a deployment, the REST form of `prefect deployment run`.
   * The server merges parameters over the deployment's defaults. It returns 201
   * for a new run or 200 for an existing run with the same idempotency key.
   * BadRequestError (400) covers failed parameter hydration or a work queue given
   * for a deployment without a work pool. NotFoundError (404) means the deployment
   * could not be found. ConflictError (409) covers a mismatch with an enforced
   * parameter schema or an invalid deployment parameter schema.
   * ValidationError (422) reports request validation failures.
   */
  createFlowRun(id: string, body: DeploymentFlowRunCreate = {}, options?: CallOptions): Promise<FlowRun> {
    return this.doPost<FlowRun>(path`/deployments/${id}/create_flow_run`, body, options);
  }

  /** Same as `createFlowRun`, addressed by `flow/deployment` name. */
  async runByName(
    name: string,
    body: DeploymentFlowRunCreate = {},
    options?: CallOptions,
  ): Promise<FlowRun> {
    const deployment = await this.getByName(name, undefined, options);
    return this.createFlowRun(deployment.id, body, options);
  }

  pause(id: string, options?: CallOptions): Promise<void> {
    return this.doPost<void>(path`/deployments/${id}/pause_deployment`, undefined, options);
  }

  resume(id: string, options?: CallOptions): Promise<void> {
    return this.doPost<void>(path`/deployments/${id}/resume_deployment`, undefined, options);
  }

  schedules(id: string, options?: CallOptions): Promise<DeploymentSchedule[]> {
    return this.doGet<DeploymentSchedule[]>(path`/deployments/${id}/schedules`, undefined, options);
  }
}

export function splitDeploymentName(flowName: string, deploymentName?: string): [string, string] {
  if (deploymentName !== undefined) return [flowName, deploymentName];
  const slash = flowName.indexOf('/');
  if (slash <= 0 || slash === flowName.length - 1) {
    throw new TypeError(`Expected "flow-name/deployment-name", got "${flowName}"`);
  }
  return [flowName.slice(0, slash), flowName.slice(slash + 1)];
}
