import type { ByteSource, ByteSourceSlice } from './byte-source';

export type HttpByteSource = ByteSource & {
  url: string;
  name: string;
  type: string;
};

type ProbeResult = {
  size: number | null;
  type: string;
  acceptRanges: boolean;
};

function guessNameFromUrl(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return last ? decodeURIComponent(last) : 'remote-media';
  } catch {
    return 'remote-media';
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

async function probeHttp(url: string, signal: AbortSignal): Promise<ProbeResult> {
  // Prefer HEAD to avoid downloading body; fall back to Range GET.
  try {
    const head = await fetch(url, { method: 'HEAD', signal });
    if (head.ok) {
      const size = parseContentLength(head.headers.get('Content-Length'));
      const type = head.headers.get('Content-Type') ?? '';
      const acceptRanges = /\bbytes\b/i.test(head.headers.get('Accept-Ranges') ?? '');
      if (size !== null) return { size, type, acceptRanges };
    }
  } catch {
    // ignore
  }

  const res = await fetch(url, {
    method: 'GET',
    signal,
    headers: { Range: 'bytes=0-0' },
  });

  const type = res.headers.get('Content-Type') ?? '';
  if (res.status === 206) {
    const total = parseTotalSizeFromContentRange(res.headers.get('Content-Range'));
    // Consume the tiny body so the connection can close cleanly.
    try {
      await res.arrayBuffer();
    } catch {
      // ignore
    }
    return { size: total, type, acceptRanges: true };
  }

  // Server ignored Range. Cancel body to avoid downloading the full file here.
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }

  const size = parseContentLength(res.headers.get('Content-Length'));
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

  constructor(url: string, size: number, type: string, name: string) {
    this.url = url;
    this.size = size;
    this.type = type;
    this.name = name;
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
    const res = await fetch(this.url, {
      method: 'GET',
      signal: this.controller.signal,
      headers: { Range: `bytes=${start}-${endInclusive}` },
    });
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

  constructor(url: string, size: number | null, type: string, name: string) {
    this.url = url;
    this.size = size ?? 0;
    this.type = type;
    this.name = name;
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
      const res = await fetch(this.url, { method: 'GET', signal: this.controller.signal });
      if (!res.ok) throw new Error(`HTTP fetch failed: ${res.status} ${res.statusText}`);
      const buf = await res.arrayBuffer();
      this.size = buf.byteLength;
      if (!this.type) this.type = res.headers.get('Content-Type') ?? '';
      return buf;
    })();
    return this.bufferPromise;
  }
}

export async function openHttpByteSource(url: string, options?: { name?: string }): Promise<HttpByteSource> {
  const name = options?.name ?? guessNameFromUrl(url);
  const probeController = new AbortController();
  const probe = await probeHttp(url, probeController.signal);
  const type = probe.type ?? '';

  if (probe.acceptRanges && probe.size !== null) {
    return new HttpRangeByteSource(url, probe.size, type, name);
  }

  const full = new HttpFullByteSource(url, probe.size, type, name);
  if (probe.size === null) {
    // Demuxers need a stable `size` for slicing. If the server didn't provide one,
    // fall back to a full download here.
    await full.arrayBuffer();
  }
  return full;
}
