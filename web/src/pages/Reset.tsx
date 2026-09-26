import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Centered, ErrorNote } from '../components/Layout';
import { NewPassword, passwordOk } from '../components/NewPassword';
import { supabase, useSession } from '../lib/supabase';

/** Landing page of the password-reset email; the link signs the user in first. */
export default function Reset() {
  const session = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message);
    navigate('/', { replace: true });
  }

  if (session === undefined) return <Centered>Loading…</Centered>;
  if (!session) return <Centered><ErrorNote>This reset link has expired. Request a new one.</ErrorNote></Centered>;
  return (
    <Centered>
      <form onSubmit={submit} className="card space-y-4">
        <h1 className="text-xl font-semibold text-white">Choose a new password</h1>
        <NewPassword password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
        <ErrorNote>{error}</ErrorNote>
        <button className="btn w-full" disabled={busy || !passwordOk(password, confirm)}>Save password</button>
      </form>
    </Centered>
  );
}
