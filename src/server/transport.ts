import type {Transport, TransportResponse} from './runner';

/** Node fetch-backed transport. Relative URLs ("/mock/...") are expanded
 * against `base`. Header extraction matches case-insensitively; multiple
 * Set-Cookie headers are preserved joined by ", ". */
export function createFetchTransport(base = 'http://127.0.0.1:4174'): Transport {
  return {
    async send(request, signal): Promise<TransportResponse> {
      const url = new URL(request.url, base).toString();
      const headers = new Headers();
      for (const {name, value} of request.headers) headers.set(name, value);
      const response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body === '' ? undefined : request.body,
        signal,
      });
      const collected: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        collected[key] = value;
      });
      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length) collected['set-cookie'] = setCookies.join(', ');
      const body = await response.text();
      return {status: response.status, headers: collected, body};
    },
  };
}

export const fetchTransport: Transport = createFetchTransport();
