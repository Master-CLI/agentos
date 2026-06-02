import { useState, useCallback } from 'react';

// When served by daemon directly, use same origin; when vite dev, use daemon port
const BASE = window.location.port === '3383'
  ? `http://${window.location.hostname}:3382`
  : '';

async function checkResponse(res: Response): Promise<Response> {
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res;
}

async function parseJson<T>(res: Response): Promise<T> {
  const contentLength = res.headers.get('content-length');
  const contentType = res.headers.get('content-type') ?? '';
  // Skip JSON parse for 204 No Content or empty bodies
  if (res.status === 204 || contentLength === '0') return undefined as unknown as T;
  if (!contentType.includes('application/json')) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export function useApi() {
  const get = useCallback(async <T = unknown>(path: string): Promise<T> => {
    const res = await fetch(`${BASE}${path}`);
    await checkResponse(res);
    return parseJson<T>(res);
  }, []);

  const post = useCallback(async <T = unknown>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    await checkResponse(res);
    return parseJson<T>(res);
  }, []);

  const put = useCallback(async <T = unknown>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await checkResponse(res);
    return parseJson<T>(res);
  }, []);

  return { get, post, put };
}

// Re-export a lightweight error-state helper for callers
export function useApiState<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const wrap = useCallback(async (fn: () => Promise<T>) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      setData(result);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, error, loading, wrap, setData };
}
