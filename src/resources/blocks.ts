import { path } from '../http.ts';
import type {
  BlockDocument,
  BlockDocumentCountQuery,
  BlockDocumentQuery,
  BlockSchema,
  BlockSchemaQuery,
  BlockType,
  BlockTypeQuery,
} from '../types.ts';
import { Resource, type CallOptions, type IterateOptions } from './base.ts';

export interface ReadBlockOptions extends CallOptions {
  /** Return secret fields in clear text instead of masked. @default false */
  includeSecrets?: boolean;
}

/** Block types, schemas and documents (saved blocks). Reads only. */
export class Blocks extends Resource {
  /** A saved block by id. */
  get(id: string, options: ReadBlockOptions = {}): Promise<BlockDocument> {
    const { includeSecrets, ...call } = options;
    return this.doGet<BlockDocument>(path`/block_documents/${id}`, secretsQuery(includeSecrets), call);
  }

  /**
   * A saved block by type slug and name, the same pair as `Block.load("slug/name")`
   * in Python. `getByName("secret/db-password")` and `getByName("secret", "db-password")`
   * are the same call.
   */
  getByName(slugOrRef: string, name?: string, options: ReadBlockOptions = {}): Promise<BlockDocument> {
    const [slug, blockName] = splitBlockRef(slugOrRef, name);
    const { includeSecrets, ...call } = options;
    return this.doGet<BlockDocument>(
      path`/block_types/slug/${slug}/block_documents/name/${blockName}`,
      secretsQuery(includeSecrets),
      call,
    );
  }

  /** Saved blocks. `include_secrets` in the query controls masking. */
  list(query: BlockDocumentQuery = {}, options?: CallOptions): Promise<BlockDocument[]> {
    return this.doPost<BlockDocument[]>('/block_documents/filter', query, options);
  }

  iterate(
    query?: BlockDocumentQuery,
    options?: IterateOptions & CallOptions,
  ): AsyncGenerator<BlockDocument, void, undefined> {
    return this.iterateFilter<BlockDocument, BlockDocumentQuery>('/block_documents/filter', query, options);
  }

  count(query: BlockDocumentCountQuery = {}, options?: CallOptions): Promise<number> {
    return this.doPost<number>('/block_documents/count', query, options);
  }

  /** Saved blocks of one type. */
  listByType(slug: string, options: ReadBlockOptions = {}): Promise<BlockDocument[]> {
    const { includeSecrets, ...call } = options;
    return this.doGet<BlockDocument[]>(path`/block_types/slug/${slug}/block_documents`, secretsQuery(includeSecrets), call);
  }

  types(query: BlockTypeQuery = {}, options?: CallOptions): Promise<BlockType[]> {
    return this.doPost<BlockType[]>('/block_types/filter', query, options);
  }

  type(slug: string, options?: CallOptions): Promise<BlockType> {
    return this.doGet<BlockType>(path`/block_types/slug/${slug}`, undefined, options);
  }

  schemas(query: BlockSchemaQuery = {}, options?: CallOptions): Promise<BlockSchema[]> {
    return this.doPost<BlockSchema[]>('/block_schemas/filter', query, options);
  }

  schema(id: string, options?: CallOptions): Promise<BlockSchema> {
    return this.doGet<BlockSchema>(path`/block_schemas/${id}`, undefined, options);
  }
}

function secretsQuery(includeSecrets: boolean | undefined) {
  return includeSecrets === undefined ? undefined : { include_secrets: includeSecrets };
}

export function splitBlockRef(slugOrRef: string, name?: string): [string, string] {
  if (name !== undefined) return [slugOrRef, name];
  const slash = slugOrRef.indexOf('/');
  if (slash <= 0 || slash === slugOrRef.length - 1) {
    throw new TypeError(`Expected "block-type-slug/block-name", got "${slugOrRef}"`);
  }
  return [slugOrRef.slice(0, slash), slugOrRef.slice(slash + 1)];
}
