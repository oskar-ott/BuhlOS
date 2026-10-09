/** api/_lib/in-process-api.js — run office GET /api/<handler> calls inside the page's own function. */
export declare function inProcessFetch(
  input: string | URL,
  init?: RequestInit,
  deps?: {
    fetch?: typeof fetch;
    log?: (line: string) => void;
    handlers?: Record<string, () => (req: unknown, res: unknown) => unknown>;
  }
): Promise<Response>;
export declare function handlerKeyOf(pathname: string): string | null;
export declare function queryObject(searchParams: URLSearchParams): Record<string, string | string[]>;
export declare const HANDLER_KEYS: string[];
