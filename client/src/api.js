// Thin fetch wrapper. All requests go to the same-origin /api path (Vite proxies
// to the backend in dev; nginx in prod), with cookies included for the session.

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  // FormData bodies are sent as-is so the browser sets the multipart boundary;
  // everything else is JSON-encoded.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: body == null ? undefined : isForm ? body : JSON.stringify(body),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || res.statusText, res.status, data);
  }
  return data;
}
