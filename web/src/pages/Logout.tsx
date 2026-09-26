import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Centered } from '../components/Layout';
import { CHAT_URL } from '../lib/config';
import { supabase } from '../lib/supabase';

/**
 * Where Open WebUI sends people when they sign out. Ends the portal session too; otherwise
 * Open WebUI's automatic redirect would sign them straight back in.
 */
export default function Logout() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    supabase.auth.signOut().finally(() => setDone(true));
  }, []);
  if (!done) return <Centered><p className="text-center text-dark-400">Signing you out…</p></Centered>;
  return (
    <Centered>
      <div className="card space-y-4 text-center">
        <CheckCircle2 className="mx-auto text-accent-green" />
        <h1 className="text-xl font-semibold text-white">You're signed out</h1>
        <a className="btn w-full" href={CHAT_URL}>Sign in again</a>
      </div>
    </Centered>
  );
}
