import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { IconLink, IconSync } from './icons.tsx';
import { useSession } from '../lib/session.tsx';

const NAV = [
  { to: '/syncs', label: 'Syncs', icon: IconSync },
  { to: '/connections', label: 'Connections', icon: IconLink },
];

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-[15px] font-bold tracking-tight text-ink">
      <span className="h-2.5 w-2.5 rounded-[3px] bg-brand" aria-hidden />
      Watchbridge
    </span>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive ? 'bg-elevated text-ink' : 'text-muted hover:text-ink hover:bg-elevated/60'
            }`
          }
        >
          <Icon className="text-base" />
          {label}
        </NavLink>
      ))}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="px-2 py-2">
          <Wordmark />
        </div>
        <nav className="mt-4 flex flex-1 flex-col gap-1">
          <NavItems />
        </nav>
        <NavLink to="/settings" className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated hover:text-ink">
          {user?.username ?? user?.email ?? 'Settings'}
        </NavLink>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur md:hidden">
        <Wordmark />
        <nav className="ml-auto flex items-center gap-1">
          <NavItems />
          <NavLink to="/settings" className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
            Settings
          </NavLink>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 py-8 md:px-8">{children}</main>
    </div>
  );
}
