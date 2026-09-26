import { useCallback, useEffect, useState } from 'react';

import { supabase } from './supabase';

/** Calls portal-api (same origin, under /portal) with the user's session. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`/portal${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${data.session?.access_token ?? ''}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`);
  return body as T;
}

/** Loads `path` once, with a `reload` to refresh after changes. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    if (!path) return;
    api<T>(path).then(setData, (e: Error) => setError(e.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export type Limit = { used: number; limit: number | null; resets_at: number };

export type Me = {
  user: { id: string; email: string; role: 'pending' | 'user' | 'admin' };
  plan: { id: string; display_name: string; description: string | null; price_monthly_cents: number };
  usage: Record<string, Limit>;
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  created_at: string;
  last_used_at: string | null;
};
