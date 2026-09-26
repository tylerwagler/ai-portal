import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';

import { Centered, ErrorNote } from '../components/Layout';
import { NewPassword, passwordOk } from '../components/NewPassword';
import { supabase, useSession } from '../lib/supabase';

type Mode = 'signin' | 'signup' | 'reset';

/** Only same-origin paths are accepted as a destination after sign-in. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const session = useSession();
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'signup' ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    const origin = window.location.origin;
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email, password, options: { emailRedirectTo: `${origin}${next}` },
        });
        if (error) throw error;
        if (!data.session) setNotice('Check your email to confirm your account.');
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/reset` });
        if (error) throw error;
        setNotice('If that account exists, a reset link is on its way.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Mode, string> = { signin: 'Sign in', signup: 'Create your account', reset: 'Reset password' };
  return (
    <Centered>
      <form onSubmit={submit} className="card space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-white">{titles[mode]}</h1>
          <p className="text-sm text-dark-500">One account for chat, Claude Code, and the API.</p>
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {mode === 'signin' && (
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" className="input" type="password" required autoComplete="current-password"
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        )}
        {mode === 'signup' && (
          <NewPassword password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
        )}
        <ErrorNote>{error}</ErrorNote>
        {notice && <p className="text-sm text-accent-green">{notice}</p>}
        <button className="btn w-full" disabled={busy || (mode === 'signup' && !passwordOk(password, confirm))}>
          {titles[mode]}
        </button>
        <div className="flex justify-between text-sm text-dark-400">
          {mode === 'signin' ? (
            <>
              <button type="button" onClick={() => setMode('signup')} className="hover:text-white">Create an account</button>
              <button type="button" onClick={() => setMode('reset')} className="hover:text-white">Forgot password?</button>
            </>
          ) : (
            <button type="button" onClick={() => setMode('signin')} className="hover:text-white">Back to sign in</button>
          )}
        </div>
      </form>
    </Centered>
  );
}
