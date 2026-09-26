// Build-time settings. All of these are public values.
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const SUPABASE_KEY = required('VITE_SUPABASE_KEY', import.meta.env.VITE_SUPABASE_KEY);
// OAuth clients we own (Open WebUI, Cloudflare Access); their consent is approved without asking.
export const FIRST_PARTY_CLIENTS = (import.meta.env.VITE_FIRST_PARTY_CLIENTS ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);
export const CHAT_URL = import.meta.env.VITE_CHAT_URL ?? 'https://ai.elytrondefense.com';
export const API_URL = import.meta.env.VITE_API_URL ?? 'https://api.elytrondefense.com';
// pulsar-gui, behind Cloudflare Access (admins only).
export const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL ?? 'https://dash.elytrondefense.com';
