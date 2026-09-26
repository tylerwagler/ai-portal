import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Centered, ErrorNote } from '../components/Layout';
import { supabase, useSession } from '../lib/supabase';

/** Landing page of the password-reset email; the link signs the user in first. */
export default function Reset() {
  const session = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return setError(error.message);
    navigate('/', { replace: true });
  }

  if (session === undefined) return <Centered>Loading…</Centered>;
  if (!session) return <Centered><ErrorNote>This reset link has expired. Request a new one.</ErrorNote></Centered>;
  return (
    <Centered>
      <form onSubmit={submit} className="card space-y-4">
        <h1 className="text-xl font-semibold text-white">Choose a new password</h1>
        <input className="input" type="password" minLength={8} required autoComplete="new-password"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorNote>{error}</ErrorNote>
        <button className="btn w-full">Save password</button>
      </form>
    </Centered>
  );
}
