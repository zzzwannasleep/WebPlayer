export type Env = {
  /**
   * Comma-separated hostname allowlist, e.g.:
   *   "v1.uhdnow.com,example.com,.example.org"
   * Use "*" to allow all (NOT recommended for a public domain).
   */
  ALLOWED_HOSTS?: string;
};

function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function parseIpv4(host: string): number[] | null {
  if (!isIpv4(host)) return null;
  const parts = host.split('.').map((s) => Number(s));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.includes('*')) return true;
  if (allowlist.includes(host)) return true;
  for (const entry of allowlist) {
    if (!entry.startsWith('.')) continue;
    const suffix = entry.toLowerCase();
    const h = host.toLowerCase();
    if (h === suffix.slice(1) || h.endsWith(suffix)) return true;
  }
  return false;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers':
      'Accept-Ranges,Content-Length,Content-Range,Content-Type,ETag,Last-Modified',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
    }

    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get('url');
    if (!target) return new Response('Missing ?url=', { status: 400, headers: corsHeaders() });

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('Invalid url', { status: 400, headers: corsHeaders() });
    }

    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return new Response('Unsupported protocol', { status: 400, headers: corsHeaders() });
    }

    // Basic SSRF hardening. Prefer explicit allowlist.
    if (targetUrl.hostname.toLowerCase() === 'localhost') {
      return new Response('Blocked host', { status: 403, headers: corsHeaders() });
    }
    if (targetUrl.hostname.includes(':')) {
      return new Response('Blocked host', { status: 403, headers: corsHeaders() });
    }
    const ipv4 = parseIpv4(targetUrl.hostname);
    if (ipv4 && isPrivateIpv4(ipv4)) {
      return new Response('Blocked host', { status: 403, headers: corsHeaders() });
    }

    const allowlist = parseAllowedHosts(env.ALLOWED_HOSTS);
    if (allowlist.length === 0) {
      return new Response('Set ALLOWED_HOSTS', { status: 403, headers: corsHeaders() });
    }
    if (!isHostAllowed(targetUrl.hostname, allowlist)) {
      return new Response('Host not allowed', { status: 403, headers: corsHeaders() });
    }

    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);

    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      redirect: 'follow',
    });

    const outHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) outHeaders.set(k, v);
    outHeaders.set('Vary', 'Origin');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  },
};

