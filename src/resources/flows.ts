import { path } from '../http.ts';
import type { Flow, FlowCountQuery, FlowCreate, FlowPageQuery, FlowQuery, FlowUpdate, Page } from '../types.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

export class Flows extends Resource {
  /**
   * Creates a flow, or returns the existing one with that name. The server answers
   * 201 for a new flow and 200 for an existing one, with the same body either way.
   */
  create(body: FlowCreate, options?: CallOptions): Promise<Flow> {
    return this.doPost<Flow>('/flows/', body, options);
  }

  get(id: string, options?: CallOptions): Promise<Flow> {
    return this.doGet<Flow>(path`/flows/${id}`, undefined, options);
  }

  getByName(name: string, options?: CallOptions): Promise<Flow> {
    return this.doGet<Flow>(path`/flows/name/${name}`, undefined, options);
  }

  /** Only tags can be changed. The server returns no body. */
  update(id: string, body: FlowUpdate, options?: CallOptions): Promise<void> {
    return this.doPatch(path`/flows/${id}`, body, options);
  }

  /** Deletes the flow together with its deployments and runs. */
  delete(id: string, options?: CallOptions): Promise<void> {
    return this.doDelete(path`/flows/${id}`, options);
  }

  /** One page of flows (limit and offset). Use `iterate` to walk all of them. */
  list(query: FlowQuery = {}, options?: CallOptions): Promise<Flow[]> {
    return this.doPost<Flow[]>('/flows/filter', query, options);
  }

  iterate(query?: FlowQuery, options?: IterateOptions & CallOptions): AsyncGenerator<Flow, void, undefined> {
    return this.iterateFilter<Flow, FlowQuery>('/flows/filter', query, options);
  }

  count(query: FlowCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/flows/count', query, options);
  }

  /** The `paginate` endpoint: 1-based pages with a total count. */
  page(query: FlowPageQuery = {}, options?: CallOptions): Promise<Page<Flow>> {
    return this.doPost<Page<Flow>>('/flows/paginate', query, options);
  }
}
