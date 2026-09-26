import { Check, X } from 'lucide-react';

/**
 * The same rules Supabase Auth enforces (GOTRUE_PASSWORD_MIN_LENGTH / _REQUIRED_CHARACTERS).
 * Auth also rejects passwords found in known breaches, which only the server can check.
 */
export const PASSWORD_RULES: [string, (p: string) => boolean][] = [
  ['At least 12 characters', (p) => p.length >= 12],
  ['A lower-case letter', (p) => /[a-z]/.test(p)],
  ['An upper-case letter', (p) => /[A-Z]/.test(p)],
  ['A number', (p) => /[0-9]/.test(p)],
];

export function passwordOk(password: string, confirm: string): boolean {
  return PASSWORD_RULES.every(([, test]) => test(password)) && password === confirm;
}

/** A new password typed twice, with the rules shown as they are met. */
export function NewPassword({ password, confirm, onPassword, onConfirm }: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
}) {
  const rules: [string, boolean][] = [
    ...PASSWORD_RULES.map(([label, test]): [string, boolean] => [label, test(password)]),
    ['Both passwords match', password.length > 0 && password === confirm],
  ];
  return (
    <>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" className="input" type="password" autoComplete="new-password" required
               value={password} onChange={(e) => onPassword(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="confirm">Confirm password</label>
        <input id="confirm" className="input" type="password" autoComplete="new-password" required
               value={confirm} onChange={(e) => onConfirm(e.target.value)} />
      </div>
      <ul className="space-y-1 text-sm" aria-live="polite">
        {rules.map(([label, met]) => (
          <li key={label} className={`flex items-center gap-2 ${met ? 'text-accent-green' : 'text-dark-500'}`}>
            {met ? <Check size={14} /> : <X size={14} />} {label}
          </li>
        ))}
        <li className="text-xs text-dark-500">Passwords found in known data breaches are refused.</li>
      </ul>
    </>
  );
}
