import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';

import { Centered, ErrorNote } from '../components/Layout';
import { supabase, useSession } from '../lib/supabase';

/** Auth's PKCE codes are UUIDs; /cli's own `code` (the CLI's 8-character user code) is not. */
const AUTH_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only same-origin paths are accepted as a destination after sign-in, minus what Auth appended
 * on an earlier attempt: supabase-js reads an `error` in the URL before the PKCE `code`, so a
 * leftover error from one failed sign-in would make every later, successful one land back here.
 */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  const url = new URL(next, window.location.origin);
  for (const p of ['error', 'error_code', 'error_description']) url.searchParams.delete(p);
  if (AUTH_CODE.test(url.searchParams.get('code') ?? '')) url.searchParams.delete('code');
  return url.pathname + url.search;
}

/** Microsoft Entra ID, Elytron's tenant only, is the only way in. */
export default function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const session = useSession();
  // Auth sends a failed sign-in back with error_description in the query or the fragment.
  const returned = params.get('error_description')
    ?? new URLSearchParams(window.location.hash.slice(1)).get('error_description')
    ?? undefined;
  const [error, setError] = useState<string | undefined>(returned);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={next} replace />;

  async function signIn() {
    setError(undefined);
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: { scopes: 'openid email profile', redirectTo: `${window.location.origin}${next}` },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  }

  return (
    <Centered>
      <div className="card space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Sign in</h1>
          <p className="text-sm text-dark-500">
            One account for chat, Claude Code, and the API: your Elytron Microsoft account.
          </p>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <button type="button" className="btn w-full" onClick={signIn} disabled={busy}>
          {busy ? 'Opening Microsoft sign-in…' : 'Sign in with Microsoft'}
        </button>
      </div>
    </Centered>
  );
}
