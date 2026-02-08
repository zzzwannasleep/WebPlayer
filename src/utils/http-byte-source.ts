import type { ByteSource, ByteSourceSlice } from './byte-source';

export type HttpByteSource = ByteSource & {
  url: string;
  name: string;
  type: string;
};

export type HttpOpenOptions = {
  name?: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  referrerPolicy?: ReferrerPolicy;
  retryCount?: number;
  retryDelayMs?: number;
};

type ProbeResult = {
  size: number | null;
  type: string;
  acceptRanges: boolean;
};

export function guessNameFromUrl(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return last ? decodeURIComponent(last) : 'remote-media';
  } catch {
    return 'remote-media';
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retryCount: number,
  retryDelayMs: number,
): Promise<Response> {
  const maxRetries = Math.max(0, Math.floor(retryCount));
  const baseDelay = Math.max(0, Math.floor(retryDelayMs));

  let attempt = 0;
  while (true) {
    try {
      return await fetch(url, init);
    } catch (e: any) {
      if (init.signal?.aborted) throw e;
      if (e?.name === 'AbortError') throw e;
      if (attempt >= maxRetries) throw e;
      await sleepMs(baseDelay * Math.pow(2, attempt));
      attempt += 1;
    }
  }
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function parseTotalSizeFromContentRange(value: string | null): number | null {
  if (!value) return null;
  const m = /\/(\d+)\s*$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function tryGetLengthFromHeaders(headers: Headers): number | null {
  return (
    parseContentLength(headers.get('X-Content-Length')) ??
    parseContentLength(headers.get('Content-Length'))
  );
}

async function probeHttp(url: string, signal: AbortSignal, options: HttpOpenOptions): Promise<ProbeResult> {
  const baseHeaders = options.headers ?? {};
  const credentials = options.credentials;
  const referrerPolicy = options.referrerPolicy;
  const retryCount = options.retryCount ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 300;

  // Avoid HEAD for maximal compatibility (some servers/proxies close connections on HEAD).
  // We'll probe with small GETs below instead.
  let headSize: number | null = null;
  let headType = '';
  let headExplicitNoRange = false;

  // Probe for byte-range support with a tiny Range request.
  if (!headExplicitNoRange) {
    try {
      const headers = new Headers(baseHeaders);
      // Use `range` (lowercase) for maximal compatibility with naive proxies.
      headers.set('range', 'bytes=0-1');

      const res = await fetchWithRetry(
        url,
        {
          method: 'GET',
          signal,
          headers,
          credentials,
          referrerPolicy,
        },
        retryCount,
        retryDelayMs,
      );

      const type = res.headers.get('Content-Type') ?? headType ?? '';
      if (res.status === 206) {
        const total = parseTotalSizeFromContentRange(res.headers.get('Content-Range'));
        // Consume the tiny body so the connection can close cleanly.
        try {
          await res.arrayBuffer();
        } catch {
          // ignore
        }
        return { size: total ?? headSize, type, acceptRanges: true };
      }

      // Server ignored Range (or returned a normal 200). Cancel body to avoid downloading the full file here.
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }

      const size = tryGetLengthFromHeaders(res.headers) ?? headSize;
      return { size, type, acceptRanges: false };
    } catch {
      // ignore, try a simple GET next
    }
  }

  // Range probe failed (often due to CORS preflight on `Range`) — try a simple GET to at least detect size/type.
  const res = await fetchWithRetry(
    url,
    { method: 'GET', signal, headers: baseHeaders, credentials, referrerPolicy },
    retryCount,
    retryDelayMs,
  );
  const type = res.headers.get('Content-Type') ?? headType ?? '';
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
  const size = tryGetLengthFromHeaders(res.headers) ?? headSize;
  return { size, type, acceptRanges: false };
}

class HttpRangeSlice implements ByteSourceSlice {
  constructor(
    private readonly owner: HttpRangeByteSource,
    private readonly start: number,
    private readonly end: number,
  ) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.owner.fetchRange(this.start, this.end);
  }
}

class HttpRangeByteSource implements HttpByteSource {
  readonly name: string;
  readonly type: string;
  readonly url: string;
  readonly size: number;

  private controller = new AbortController();
  private baseHeaders: Record<string, string>;
  private credentials?: RequestCredentials;
  private referrerPolicy?: ReferrerPolicy;
  private retryCount: number;
  private retryDelayMs: number;

  constructor(url: string, size: number, type: string, name: string, options: HttpOpenOptions) {
    this.url = url;
    this.size = size;
    this.type = type;
    this.name = name;
    this.baseHeaders = options.headers ?? {};
    this.credentials = options.credentials;
    this.referrerPolicy = options.referrerPolicy;
    this.retryCount = options.retryCount ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 300;
  }

  abort = () => {
    this.controller.abort();
  };

  slice(start = 0, end = this.size): ByteSourceSlice {
    const s = Math.max(0, Math.min(this.size, Math.floor(start)));
    const e = Math.max(s, Math.min(this.size, Math.floor(end)));
    return new HttpRangeSlice(this, s, e);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.fetchRange(0, this.size);
  }

  async fetchRange(start: number, endExclusive: number): Promise<ArrayBuffer> {
    if (this.controller.signal.aborted) throw new Error('HTTP source aborted');
    const endInclusive = Math.max(start, endExclusive - 1);
    const headers = new Headers(this.baseHeaders);
    headers.set('range', `bytes=${start}-${endInclusive}`);
    const res = await fetchWithRetry(
      this.url,
      {
        method: 'GET',
        signal: this.controller.signal,
        headers,
        credentials: this.credentials,
        referrerPolicy: this.referrerPolicy,
      },
      this.retryCount,
      this.retryDelayMs,
    );
    if (res.status !== 206) {
      // Some servers ignore Range and return 200 with the full body.
      if (res.ok && start === 0 && endExclusive === this.size) return await res.arrayBuffer();
      throw new Error(`HTTP range fetch not supported (status ${res.status})`);
    }
    return await res.arrayBuffer();
  }
}

class HttpFullSlice implements ByteSourceSlice {
  constructor(
    private readonly owner: HttpFullByteSource,
    private readonly start: number,
    private readonly end: number,
  ) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buf = await this.owner.getBuffer();
    return buf.slice(this.start, this.end);
  }
}

class HttpFullByteSource implements HttpByteSource {
  readonly name: string;
  type: string;
  readonly url: string;
  size: number;

  private controller = new AbortController();
  private bufferPromise: Promise<ArrayBuffer> | null = null;
  private baseHeaders: Record<string, string>;
  private credentials?: RequestCredentials;
  private referrerPolicy?: ReferrerPolicy;
  private retryCount: number;
  private retryDelayMs: number;

  constructor(url: string, size: number | null, type: string, name: string, options: HttpOpenOptions) {
    this.url = url;
    this.size = size ?? 0;
    this.type = type;
    this.name = name;
    this.baseHeaders = options.headers ?? {};
    this.credentials = options.credentials;
    this.referrerPolicy = options.referrerPolicy;
    this.retryCount = options.retryCount ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 300;
  }

  abort = () => {
    this.controller.abort();
  };

  slice(start = 0, end = this.size || 0): ByteSourceSlice {
    const s = Math.max(0, Math.floor(start));
    const e = Math.max(s, Math.floor(end));
    return new HttpFullSlice(this, s, e);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return await this.getBuffer();
  }

  async getBuffer(): Promise<ArrayBuffer> {
    if (this.bufferPromise) return this.bufferPromise;
    this.bufferPromise = (async () => {
      const res = await fetchWithRetry(
        this.url,
        {
          method: 'GET',
          signal: this.controller.signal,
          headers: this.baseHeaders,
          credentials: this.credentials,
          referrerPolicy: this.referrerPolicy,
        },
        this.retryCount,
        this.retryDelayMs,
      );
      if (!res.ok) throw new Error(`HTTP fetch failed: ${res.status} ${res.statusText}`);
      const buf = await res.arrayBuffer();
      this.size = buf.byteLength;
      if (!this.type) this.type = res.headers.get('Content-Type') ?? '';
      return buf;
    })();
    return this.bufferPromise;
  }
}

export async function openHttpByteSource(url: string, options?: HttpOpenOptions): Promise<HttpByteSource> {
  const isCrossOrigin = (() => {
    try {
      const u = new URL(url, window.location.href);
      return u.origin !== window.location.origin;
    } catch {
      return true;
    }
  })();

  const opts: HttpOpenOptions = {
    ...options,
    retryCount: options?.retryCount ?? 1,
    retryDelayMs: options?.retryDelayMs ?? 300,
    referrerPolicy:
      options?.referrerPolicy ?? (isCrossOrigin ? 'no-referrer' : undefined),
  };

  const name = opts.name ?? guessNameFromUrl(url);
  const probeController = new AbortController();
  const probe = await probeHttp(url, probeController.signal, opts);
  const type = probe.type ?? '';

  if (probe.acceptRanges && probe.size !== null) {
    return new HttpRangeByteSource(url, probe.size, type, name, opts);
  }

  const full = new HttpFullByteSource(url, probe.size, type, name, opts);
  if (probe.size === null) {
    // Demuxers need a stable `size` for slicing. If the server didn't provide one,
    // fall back to a full download here.
    await full.arrayBuffer();
  }
  return full;
}
