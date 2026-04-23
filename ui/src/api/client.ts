const API_BASE = "/api";
const TOKEN_STORAGE_KEY = "dashboard_token";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Token bootstrap ────────────────────────────────────────────────
//
// On first load the token isn't in localStorage yet.  We fetch it once
// from /api/bootstrap-token (a public endpoint that is safe because the
// server only listens on 127.0.0.1), cache it in localStorage, and reuse
// it for every subsequent request.  If the server ever returns 401 (e.g.
// DB was wiped), we clear the cache and reload so the user gets a fresh
// token automatically.

let _cachedToken: string | null = localStorage.getItem(TOKEN_STORAGE_KEY);
// Deduplicate concurrent first-load requests — only one fetch in flight
let _tokenPromise: Promise<string> | null = null;

async function fetchBootstrapToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/bootstrap-token`);
  if (!res.ok) throw new Error("Failed to fetch dashboard token");
  const { token } = (await res.json()) as { token: string };
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  _cachedToken = token;
  return token;
}

async function getToken(): Promise<string> {
  if (_cachedToken) return _cachedToken;
  if (!_tokenPromise) {
    _tokenPromise = fetchBootstrapToken().finally(() => {
      _tokenPromise = null;
    });
  }
  return _tokenPromise;
}

// ── Core request ───────────────────────────────────────────────────

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const token = await getToken();
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
    ...options,
  });

  if (res.status === 401) {
    // Token is stale — clear cache and reload so we re-bootstrap cleanly
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    _cachedToken = null;
    window.location.reload();
    throw new ApiError(401, "Session expired, reloading…");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || res.statusText);
  }

  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", ...(data !== undefined && { body: JSON.stringify(data) }) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "PUT", ...(data !== undefined && { body: JSON.stringify(data) }) }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "PATCH", ...(data !== undefined && { body: JSON.stringify(data) }) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
