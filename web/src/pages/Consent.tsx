import { useEffect, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';

import { Centered, ErrorNote } from '../components/Layout';
import { FIRST_PARTY_CLIENTS } from '../lib/config';
import { authApi, useSession } from '../lib/supabase';

type Details = {
  redirect_url?: string;
  client?: { id: string; name?: string };
  user?: { email?: string };
  scope?: string;
};

/**
 * Supabase Auth sends OAuth sign-ins (Open WebUI) here. Our own apps are approved
 * without a prompt; a returning user's earlier consent is honoured by Auth itself.
 */
export default function Consent() {
  const [params] = useSearchParams();
  const location = useLocation();
  const session = useSession();
  const id = params.get('authorization_id');
  const [details, setDetails] = useState<Details>();
  const [error, setError] = useState<string>();

  async function decide(action: 'approve' | 'deny') {
    try {
      const { redirect_url } = await authApi<{ redirect_url: string }>(
        `/oauth/authorizations/${encodeURIComponent(id!)}/consent`,
        { method: 'POST', body: JSON.stringify({ action }) },
      );
      window.location.replace(redirect_url);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!session || !id) return;
    authApi<Details>(`/oauth/authorizations/${encodeURIComponent(id)}`).then((d) => {
      if (d.redirect_url) window.location.replace(d.redirect_url);
      else if (d.client && FIRST_PARTY_CLIENTS.includes(d.client.id)) decide('approve');
      else setDetails(d);
    }, (e: Error) => setError(e.message));
  }, [session, id]);

  if (!id) return <Centered><ErrorNote>Missing authorization_id.</ErrorNote></Centered>;
  if (session === undefined) return <Centered>Loading…</Centered>;
  if (!session) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  if (error) return <Centered><ErrorNote>{error}</ErrorNote></Centered>;
  if (!details) return <Centered><p className="text-center text-dark-400">Signing you in…</p></Centered>;
  return (
    <Centered>
      <div className="card space-y-4">
        <h1 className="text-xl font-semibold text-white">Allow access?</h1>
        <p>
          <strong className="text-white">{details.client?.name ?? details.client?.id}</strong> wants to sign you in as{' '}
          <strong className="text-white">{details.user?.email}</strong>.
        </p>
        <p className="text-sm text-dark-500">Access requested: {details.scope}</p>
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={() => decide('approve')}>Allow</button>
          <button className="btn-ghost flex-1" onClick={() => decide('deny')}>Deny</button>
        </div>
      </div>
    </Centered>
  );
}
