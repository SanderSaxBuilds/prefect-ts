import { path } from '../http.ts';
import type { Automation, AutomationCountQuery, AutomationQuery } from '../types.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

/** Automations (event triggers with actions). Reads only. */
export class Automations extends Resource {
  get(id: string, options?: CallOptions): Promise<Automation> {
    return this.doGet<Automation>(path`/automations/${id}`, undefined, options);
  }

  list(query: AutomationQuery = {}, options?: CallOptions): Promise<Automation[]> {
    return this.doPost<Automation[]>('/automations/filter', query, options);
  }

  iterate(query?: AutomationQuery, options?: IterateOptions & CallOptions): AsyncGenerator<Automation, void, undefined> {
    return this.iterateFilter<Automation, AutomationQuery>('/automations/filter', query, options);
  }

  count(query: AutomationCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/automations/count', query, options);
  }

  /** Automations tied to a resource, such as `prefect.deployment.<id>`. */
  relatedTo(resourceId: string, options?: CallOptions): Promise<Automation[]> {
    return this.doGet<Automation[]>(path`/automations/related-to/${resourceId}`, undefined, options);
  }
}
