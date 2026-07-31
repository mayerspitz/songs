'use strict';

async function call(method, path, { body, binary, type, query } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: binary
      ? { 'Content-Type': type || 'application/octet-stream' }
      : (body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? (binary ? body : JSON.stringify(body)) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json();
  if (!res.ok) {
    const e = new Error((data && data.error) || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

export const api = {
  get: (p, query) => call('GET', p, { query }),
  post: (p, body) => call('POST', p, { body }),
  patch: (p, body) => call('PATCH', p, { body }),
  put: (p, body) => call('PUT', p, { body }),
  del: (p, body) => call('DELETE', p, { body }),
  upload: (p, blob, { type, query } = {}) => call('POST', p, { body: blob, binary: true, type, query }),
};
