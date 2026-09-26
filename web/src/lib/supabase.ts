import { createClient, type Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { SUPABASE_KEY } from './config';

// Supabase is served from this same origin, behind the edge.
export const supabase = createClient(window.location.origin, SUPABASE_KEY);

/** The current session; `undefined` while it is still loading. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

/** Calls Supabase Auth directly, for endpoints supabase-js does not wrap. */
export async function authApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${data.session?.access_token ?? ''}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.msg ?? body.message ?? body.error_description ?? `HTTP ${res.status}`);
  return body as T;
}
