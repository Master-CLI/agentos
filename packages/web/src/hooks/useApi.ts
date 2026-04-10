import { useState, useCallback } from 'react';

const BASE = `http://${window.location.hostname}:3382`;

export function useApi() {
  const get = useCallback(async <T = unknown>(path: string): Promise<T> => {
    const res = await fetch(`${BASE}${path}`);
    return res.json() as Promise<T>;
  }, []);

  const post = useCallback(async <T = unknown>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json() as Promise<T>;
  }, []);

  const put = useCallback(async <T = unknown>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<T>;
  }, []);

  return { get, post, put };
}
