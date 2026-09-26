import { Activity, ExternalLink, Save } from 'lucide-react';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';

import { ErrorNote, useMe } from '../components/Layout';
import { api, useApi } from '../lib/api';
import { DASHBOARD_URL } from '../lib/config';

type AdminUser = {
  id: string;
  email: string;
  role: 'pending' | 'user' | 'admin';
  status: 'active' | 'disabled';
  tier_id: string;
  created_at: string;
  tokens_30d: number;
  requests_30d: number;
};

type Tier = {
  id: string;
  display_name: string;
  description: string | null;
  price_monthly_cents: number;
  stripe_price_id: string | null;
  rate_limit_rpm: number | null;
  rate_limit_tpm: number | null;
  hourly_limit: number | null;
  daily_limit: number | null;
  weekly_limit: number | null;
  monthly_limit: number | null;
};

const LIMIT_FIELDS: [keyof Tier, string][] = [
  ['rate_limit_rpm', 'Req/min'],
  ['rate_limit_tpm', 'Tok/min'],
  ['hourly_limit', 'Hour'],
  ['daily_limit', 'Day'],
  ['weekly_limit', 'Week'],
  ['monthly_limit', 'Month'],
];

export default function Admin() {
  const { me } = useMe();
  if (me.user.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <>
      <Dashboard />
      <Users />
      <Tiers />
    </>
  );
}

function Dashboard() {
  return (
    <section className="card flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <Activity size={20} className="text-accent-green" />
        <div>
          <h2 className="text-lg font-semibold text-white">System dashboard</h2>
          <p className="text-sm text-dark-500">Live model, gateway and service health (pulsar-gui).</p>
        </div>
      </div>
      <a className="btn flex items-center gap-2" href={DASHBOARD_URL} target="_blank" rel="noreferrer">
        Open <ExternalLink size={14} />
      </a>
    </section>
  );
}

function Users() {
  const [q, setQ] = useState('');
  const { data: users, error, reload } = useApi<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q)}`);
  const { data: tiers } = useApi<Tier[]>('/admin/tiers');
  const [actionError, setActionError] = useState<string>();

  async function change(id: string, patch: Partial<AdminUser>) {
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setActionError(undefined);
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">Users</h2>
        <input className="input max-w-xs" placeholder="Search email or name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorNote>{error ?? actionError}</ErrorNote>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-dark-500">
            <tr><th className="py-2">Email</th><th>Plan</th><th>Role</th><th>Status</th><th className="text-right">Tokens 30d</th></tr>
          </thead>
          <tbody className="divide-y divide-dark-800">
            {users?.map((u) => (
              <tr key={u.id}>
                <td className="py-2 text-white">{u.email}</td>
                <td>
                  <select className="input py-1" value={u.tier_id} onChange={(e) => change(u.id, { tier_id: e.target.value })}>
                    {tiers?.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                  </select>
                </td>
                <td>
                  <select className="input py-1" value={u.role} onChange={(e) => change(u.id, { role: e.target.value as AdminUser['role'] })}>
                    <option value="user">user</option><option value="admin">admin</option><option value="pending">pending</option>
                  </select>
                </td>
                <td>
                  <button className={`rounded px-2 py-1 ${u.status === 'active' ? 'text-accent-green' : 'text-accent-red'}`}
                          onClick={() => change(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })}>
                    {u.status}
                  </button>
                </td>
                <td className="text-right tabular-nums">{Number(u.tokens_30d).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Tiers() {
  const { data: tiers, error, reload } = useApi<Tier[]>('/admin/tiers');
  return (
    <section className="card space-y-4">
      <h2 className="text-lg font-semibold text-white">Plans</h2>
      <p className="text-sm text-dark-500">Token limits per window; leave empty for no limit. Changes reach the gate within 30 seconds.</p>
      <ErrorNote>{error}</ErrorNote>
      {tiers?.map((t) => <TierRow key={t.id} tier={t} onSaved={reload} />)}
      <TierRow tier={null} onSaved={reload} />
    </section>
  );
}

function TierRow({ tier, onSaved }: { tier: Tier | null; onSaved: () => void }) {
  const empty: Tier = {
    id: '', display_name: '', description: null, price_monthly_cents: 0, stripe_price_id: null,
    rate_limit_rpm: null, rate_limit_tpm: null, hourly_limit: null, daily_limit: null, weekly_limit: null, monthly_limit: null,
  };
  const [t, setT] = useState<Tier>(tier ?? empty);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const num = (v: string) => (v === '' ? null : Math.max(0, Number(v)));

  async function save() {
    try {
      await api(`/admin/tiers/${encodeURIComponent(t.id)}`, { method: 'PUT', body: JSON.stringify(t) });
      setError(undefined);
      setSaved(true);
      if (!tier) setT(empty);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-dark-800 p-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <input className="input" placeholder="id (e.g. pro)" value={t.id} disabled={!!tier}
               onChange={(e) => setT({ ...t, id: e.target.value.toLowerCase() })} />
        <input className="input" placeholder="Name" value={t.display_name}
               onChange={(e) => setT({ ...t, display_name: e.target.value })} />
        <input className="input" placeholder="Price $/month" type="number" min={0} step="0.01"
               value={t.price_monthly_cents / 100} onChange={(e) => setT({ ...t, price_monthly_cents: Math.round(Number(e.target.value) * 100) })} />
        <input className="input" placeholder="Stripe price id" value={t.stripe_price_id ?? ''}
               onChange={(e) => setT({ ...t, stripe_price_id: e.target.value || null })} />
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {LIMIT_FIELDS.map(([field, label]) => (
          <label key={field} className="text-xs text-dark-500">{label}
            <input className="input mt-1" type="number" min={0} value={(t[field] as number | null) ?? ''}
                   onChange={(e) => setT({ ...t, [field]: num(e.target.value) })} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-ghost px-3 py-1.5 text-sm" onClick={save} disabled={!t.id || !t.display_name}>
          <Save size={14} /> {tier ? 'Save' : 'Add plan'}
        </button>
        {saved && <span className="text-xs text-accent-green">Saved</span>}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </div>
  );
}
