import { Copy, KeyRound, Plus, Terminal, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ErrorNote, useMe } from '../components/Layout';
import { api, useApi, type ApiKey, type Limit } from '../lib/api';
import { API_URL } from '../lib/config';

const LIMIT_LABELS: Record<string, string> = {
  requests_per_minute: 'Requests / minute',
  tokens_per_minute: 'Tokens / minute',
  tokens_hour: 'Tokens this hour',
  tokens_day: 'Tokens today',
  tokens_week: 'Tokens this week',
  tokens_month: 'Tokens this month',
};

export default function Account() {
  return (
    <>
      <Plan />
      <ClaudeCode />
      <Keys />
    </>
  );
}

function Plan() {
  const { me } = useMe();
  const price = me.plan.price_monthly_cents ? `$${(me.plan.price_monthly_cents / 100).toFixed(2)}/month` : 'Free';
  // Show limited windows; always show today's tokens so free-of-limits plans still see usage.
  const rows = Object.entries(me.usage).filter(([k, v]) => v.limit !== null || k === 'tokens_day');
  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">{me.plan.display_name} plan</h2>
        <span className="text-dark-400">{price}</span>
      </div>
      {me.plan.description && <p className="text-sm text-dark-400">{me.plan.description}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map(([key, limit]) => <UsageBar key={key} label={LIMIT_LABELS[key] ?? key} limit={limit} />)}
      </div>
    </section>
  );
}

function UsageBar({ label, limit }: { label: string; limit: Limit }) {
  const pct = limit.limit ? Math.min(100, (limit.used / limit.limit) * 100) : 0;
  const color = pct >= 90 ? 'bg-accent-red' : pct >= 70 ? 'bg-accent-orange' : 'bg-accent-cyan';
  const resets = new Date(limit.resets_at * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-dark-400">
          {limit.used.toLocaleString()} {limit.limit !== null ? `/ ${limit.limit.toLocaleString()}` : '· no limit'}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-dark-800">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {limit.limit !== null && <p className="mt-1 text-xs text-dark-500">Resets {resets}</p>}
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-dark-950 px-3 py-2 font-mono text-sm">
      <code className="flex-1 overflow-x-auto whitespace-nowrap">{text}</code>
      <button className="text-dark-500 hover:text-white" title="Copy" onClick={() => navigator.clipboard.writeText(text)}>
        <Copy size={16} />
      </button>
    </div>
  );
}

function ClaudeCode() {
  return (
    <section className="card space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Terminal size={18} /> Claude Code</h2>
      <p className="text-sm text-dark-400">Install <code>claude-local</code>, then sign in. Your browser approves the device; no key to copy.</p>
      <p className="text-sm">Linux and macOS</p>
      <CopyLine text={`curl -fsSL ${API_URL}/install/setup.sh | bash`} />
      <p className="text-sm">Windows (PowerShell)</p>
      <CopyLine text={`irm ${API_URL}/install/setup.ps1 | iex`} />
      <CopyLine text="claude-local --login" />
    </section>
  );
}

function Keys() {
  const { data: keys, error, reload } = useApi<ApiKey[]>('/keys');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string }>();
  const [actionError, setActionError] = useState<string>();

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const k = await api<{ name: string; key: string }>('/keys', { method: 'POST', body: JSON.stringify({ name }) });
      setCreated(k);
      setName('');
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke "${k.name}"? Apps using it stop working within 30 seconds.`)) return;
    try {
      await api(`/keys/${k.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <section className="card space-y-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><KeyRound size={18} /> API keys</h2>
      <p className="text-sm text-dark-400">
        For scripts and other tools. Use <code>{API_URL}/v1</code> as the OpenAI or Anthropic base URL.
      </p>
      {created && (
        <div className="space-y-2 rounded-lg border border-accent-green/40 bg-accent-green/10 p-3">
          <p className="text-sm">Copy <strong className="text-white">{created.name}</strong> now. It will not be shown again.</p>
          <CopyLine text={created.key} />
        </div>
      )}
      <form onSubmit={add} className="flex gap-2">
        <input className="input" placeholder="Key name, e.g. build server" required maxLength={80}
               value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn shrink-0"><Plus size={16} /> Create</button>
      </form>
      <ErrorNote>{error ?? actionError}</ErrorNote>
      <ul className="divide-y divide-dark-800">
        {keys?.map((k) => (
          <li key={k.id} className="flex items-center gap-3 py-3">
            <div className="flex-1">
              <p className="text-white">{k.name}</p>
              <p className="font-mono text-xs text-dark-500">
                {k.prefix}…{k.last4} · created {new Date(k.created_at).toLocaleDateString()}
              </p>
            </div>
            <button className="btn-ghost px-3" title="Revoke" onClick={() => revoke(k)}><Trash2 size={16} /></button>
          </li>
        ))}
        {keys?.length === 0 && <li className="py-3 text-sm text-dark-500">No keys yet.</li>}
      </ul>
    </section>
  );
}
