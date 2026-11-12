import { NotFoundError } from '../errors.ts';
import { path } from '../http.ts';
import type { Variable, VariableCountQuery, VariableCreate, VariableQuery, VariableUpdate } from '../types.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

/** Any JSON value. Prefect stores variables as JSON, so objects and arrays round-trip. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export class Variables extends Resource {
  /**
   * Creates a variable. Names may only hold lowercase letters, digits, dashes and
   * underscores. A taken name is a ConflictError (409).
   */
  create(body: VariableCreate, options?: CallOptions): Promise<Variable> {
    return this.doPost<Variable>('/variables/', body, options);
  }

  get(id: string, options?: CallOptions): Promise<Variable> {
    return this.doGet<Variable>(path`/variables/${id}`, undefined, options);
  }

  getByName(name: string, options?: CallOptions): Promise<Variable> {
    return this.doGet<Variable>(path`/variables/name/${name}`, undefined, options);
  }

  /** The value of a variable, or `fallback` when no variable has that name. */
  async getValue<T = JsonValue>(name: string, fallback?: T, options?: CallOptions): Promise<T | undefined> {
    try {
      const variable = await this.getByName(name, options);
      return variable.value as T;
    } catch (error) {
      if (error instanceof NotFoundError) return fallback;
      throw error;
    }
  }

  /** Changes a variable by id. The server returns no body. */
  update(id: string, body: VariableUpdate, options?: CallOptions): Promise<void> {
    return this.doPatch(path`/variables/${id}`, body, options);
  }

  updateByName(name: string, body: VariableUpdate, options?: CallOptions): Promise<void> {
    return this.doPatch(path`/variables/name/${name}`, body, options);
  }

  /** Creates the variable or overwrites its value, then returns the stored variable. */
  async set(name: string, value: JsonValue, options: CallOptions & { tags?: string[] } = {}): Promise<Variable> {
    const { tags, ...call } = options;
    const body = { value, ...(tags ? { tags } : {}) };
    try {
      await this.updateByName(name, body, call);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return this.create({ name, ...body }, call);
    }
    return this.getByName(name, call);
  }

  delete(id: string, options?: CallOptions): Promise<void> {
    return this.doDelete(path`/variables/${id}`, options);
  }

  deleteByName(name: string, options?: CallOptions): Promise<void> {
    return this.doDelete(path`/variables/name/${name}`, options);
  }

  list(query: VariableQuery = {}, options?: CallOptions): Promise<Variable[]> {
    return this.doPost<Variable[]>('/variables/filter', query, options);
  }

  iterate(query?: VariableQuery, options?: IterateOptions & CallOptions): AsyncGenerator<Variable, void, undefined> {
    return this.iterateFilter<Variable, VariableQuery>('/variables/filter', query, options);
  }

  count(query: VariableCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/variables/count', query, options);
  }
}
