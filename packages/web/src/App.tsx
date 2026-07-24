import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session.tsx';
import { Layout } from './components/Layout.tsx';
import { Spinner } from './components/ui.tsx';
import { Login } from './pages/Login.tsx';
import { Register } from './pages/Register.tsx';
import { ForgotPassword } from './pages/ForgotPassword.tsx';
import { ResetPassword } from './pages/ResetPassword.tsx';
import { Connections } from './pages/Connections.tsx';
import { Syncs } from './pages/Syncs.tsx';
import { Settings } from './pages/Settings.tsx';

const PAGE_TITLE: Record<string, string> = {
  '/login': 'Sign in',
  '/register': 'Create an account',
  '/forgot-password': 'Reset your password',
  '/reset-password': 'Choose a new password',
  '/syncs': 'Syncs',
  '/connections': 'Connections',
  '/settings': 'Settings',
};

/**
 * A single-page app never reloads, so without this the tab keeps whatever title
 * it had at first load and screen readers get no cue that the page changed.
 */
function RouteAnnouncer() {
  const { pathname } = useLocation();
  useEffect(() => {
    const page = PAGE_TITLE[pathname];
    document.title = page ? `${page} · Watchbridge` : 'Watchbridge';
  }, [pathname]);
  return null;
}

function FullPageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center text-muted">
      <Spinner />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return <FullPageSpinner />;
  if (user) return <Navigate to="/syncs" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <RouteAnnouncer />
        <Routes>
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />
          <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />
          <Route path="/reset-password" element={<PublicOnly><ResetPassword /></PublicOnly>} />
          <Route path="/syncs" element={<RequireAuth><Syncs /></RequireAuth>} />
          <Route path="/connections" element={<RequireAuth><Connections /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/syncs" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
