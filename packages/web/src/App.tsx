import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session.tsx';
import { Layout } from './components/Layout.tsx';
import { Spinner } from './components/ui.tsx';
import { Login } from './pages/Login.tsx';
import { Register } from './pages/Register.tsx';
import { Connections } from './pages/Connections.tsx';
import { Syncs } from './pages/Syncs.tsx';
import { Settings } from './pages/Settings.tsx';

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
        <Routes>
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />
          <Route path="/syncs" element={<RequireAuth><Syncs /></RequireAuth>} />
          <Route path="/connections" element={<RequireAuth><Connections /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/syncs" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
