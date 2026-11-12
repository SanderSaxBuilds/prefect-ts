import { PrefectClient, type PrefectClientOptions } from '../src/index.ts';

export interface RecordedCall {
  method: string;
  url: URL;
  path: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

export type Reply = Response | ((call: RecordedCall) => Response | Promise<Response>);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const API = 'http://prefect.test/api';

/**
 * A fetch that answers from a queue of replies (the last one repeats) and records
 * each call. `sleeps` collects the delays the client asked for, nothing really waits.
 */
export function mockClient(replies: Reply[] | Reply = json(200, {}), options: PrefectClientOptions = {}) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let clock = 0;

  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const call: RecordedCall = {
      method: String(init.method),
      url,
      path: url.pathname.replace(/^\/api/, ''),
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(call);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    const response = typeof reply === 'function' ? await reply(call) : reply.clone();
    return response;
  };

  const client = new PrefectClient(
    { apiUrl: API, fetch, ...options },
    {
      sleep: async (ms, signal) => {
        signal?.throwIfAborted();
        sleeps.push(ms);
        clock += ms;
      },
      random: () => 0.5,
      now: () => clock,
    },
  );
  return { client, calls, sleeps, advance: (ms: number) => (clock += ms) };
}

export function flowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    name: 'brave-otter',
    flow_id: 'flow-1',
    state_type: 'RUNNING',
    state_name: 'Running',
    state: { id: 's1', type: 'RUNNING', name: 'Running', message: null },
    ...overrides,
  };
}
