import { CheckCircle2, Terminal } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';

import { ErrorNote } from '../components/Layout';
import { api } from '../lib/api';

type Pending = { user_code: string; device_name: string; status: string };

/** Approves a `claude-local --login` request; the CLI then receives its own API key. */
export default function Cli() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [pending, setPending] = useState<Pending>();
  const [approved, setApproved] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setPending(undefined);
    setError(undefined);
    if (code.replace(/[^a-z0-9]/gi, '').length !== 8) return;
    api<Pending>(`/cli/pending/${encodeURIComponent(code)}`).then(setPending, (e: Error) => setError(e.message));
  }, [code]);

  async function approve(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ device_name: string }>('/cli/approve', {
        method: 'POST',
        body: JSON.stringify({ user_code: code }),
      });
      setApproved(r.device_name);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (approved) {
    return (
      <div className="card flex items-center gap-3">
        <CheckCircle2 className="text-accent-green" />
        <p><strong className="text-white">{approved}</strong> is signed in. You can close this tab and return to your terminal.</p>
      </div>
    );
  }
  return (
    <form onSubmit={approve} className="card max-w-md space-y-4">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-white"><Terminal size={20} /> Approve a CLI sign-in</h1>
      <p className="text-sm text-dark-400">Check that this code matches the one shown in your terminal.</p>
      <input className="input text-center font-mono text-2xl tracking-widest uppercase" value={code}
             onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH" />
      {pending && <p className="text-sm">Device: <strong className="text-white">{pending.device_name}</strong></p>}
      <ErrorNote>{error}</ErrorNote>
      <button className="btn w-full" disabled={!pending}>Approve this device</button>
    </form>
  );
}
