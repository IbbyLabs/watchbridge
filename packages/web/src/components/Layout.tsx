import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { IconLink, IconSettings, IconSync } from './icons.tsx';
import { Logo } from './Logo.tsx';
import { Footer } from './Footer.tsx';
import { useSession } from '../lib/session.tsx';

const PRIMARY = [
  { to: '/syncs', label: 'Syncs', icon: IconSync },
  { to: '/connections', label: 'Connections', icon: IconLink },
];

// The mobile tab bar carries Settings too, since there's no room for a sidebar.
const TABS = [...PRIMARY, { to: '/settings', label: 'Settings', icon: IconSettings }];

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5 text-[15px] font-bold tracking-tight text-ink">
      <Logo className="h-6 w-6" />
      Watchbridge
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-elevated focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="px-2 py-2">
          <Wordmark />
        </div>
        <nav className="mt-4 flex flex-1 flex-col gap-1">
          {PRIMARY.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
                  isActive ? 'bg-elevated text-ink' : 'text-muted hover:bg-elevated/60 hover:text-ink'
                }`
              }
            >
              <Icon className="text-base" />
              {label}
            </NavLink>
          ))}
        </nav>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
              isActive ? 'bg-elevated text-ink' : 'text-muted hover:bg-elevated hover:text-ink'
            }`
          }
        >
          <IconSettings className="text-base" />
          <span className="truncate">{user?.username ?? user?.email ?? 'Settings'}</span>
        </NavLink>
      </aside>

      {/* Mobile top bar: brand only, so nothing can overflow. */}
      <header className="sticky top-0 z-30 flex items-center border-b border-border bg-surface/90 px-4 py-3 backdrop-blur md:hidden">
        <Wordmark />
      </header>

      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-4xl flex-col px-4 pb-28 pt-6 focus:outline-none md:px-8 md:py-8 md:pb-8"
      >
        <div className="flex-1">{children}</div>
        <Footer />
      </main>

      {/* Mobile bottom tab bar: thumb-reachable, never overflows. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
                isActive ? 'text-brand-ink' : 'text-muted'
              }`
            }
          >
            <Icon className="text-xl" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
