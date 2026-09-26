import { LogOut, MessageSquare, Shield, User } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { Link, NavLink, Navigate, useLocation } from 'react-router-dom';

import { useApi, type Me } from '../lib/api';
import { CHAT_URL } from '../lib/config';
import { supabase, useSession } from '../lib/supabase';

const MeContext = createContext<{ me: Me; reload: () => void } | null>(null);

/** The signed-in account, inside <SignedIn>. */
export function useMe() {
  const value = useContext(MeContext);
  if (!value) throw new Error('useMe outside <SignedIn>');
  return value;
}

/** Page shell for signed-in pages; sends signed-out visitors to /login and back. */
export function SignedIn({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  const { data: me, error, reload } = useApi<Me>(session ? '/me' : null);
  if (session === undefined) return <Centered>Loading…</Centered>;
  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (error) return <Centered><ErrorNote>{error}</ErrorNote></Centered>;
  if (!me) return <Centered>Loading…</Centered>;
  return (
    <MeContext.Provider value={{ me, reload }}>
      <div className="min-h-screen">
        <header className="border-b border-dark-800 bg-dark-900">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-1 px-4 py-3 text-sm">
            <Link to="/" className="mr-4 font-semibold text-white">AI Portal</Link>
            <Tab to="/" icon={<User size={16} />}>Account</Tab>
            {me.user.role === 'admin' && <Tab to="/admin" icon={<Shield size={16} />}>Admin</Tab>}
            <a href={CHAT_URL} className="flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-dark-800">
              <MessageSquare size={16} /> Chat
            </a>
            <span className="ml-auto hidden text-dark-500 sm:inline">{me.user.email}</span>
            <button
              className="ml-3 flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-dark-800"
              onClick={() => supabase.auth.signOut()}
            >
              <LogOut size={16} /> Sign out
            </button>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">{children}</main>
      </div>
    </MeContext.Provider>
  );
}

function Tab({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-lg px-3 py-1.5 ${isActive ? 'bg-dark-800 text-white' : 'hover:bg-dark-800'}`
      }
    >
      {icon} {children}
    </NavLink>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

export function ErrorNote({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
      {children}
    </p>
  );
}
