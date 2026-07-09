import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';
import type { User } from './types.ts';

interface SessionValue {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      setUser(await api.get<User>('/api/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <SessionContext.Provider value={{ user, loading, refresh, setUser }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
