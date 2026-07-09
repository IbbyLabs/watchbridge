import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { Button, Card } from '../components/ui.tsx';
import { IconLogout } from '../components/icons.tsx';

export function Settings() {
  const { user, setUser } = useSession();
  const navigate = useNavigate();

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    navigate('/login');
  };

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Settings</h1>
      </header>
      <Card className="divide-y divide-border">
        <Row label="Email" value={user?.email ?? '—'} />
        <Row label="Username" value={user?.username ?? '—'} />
        {user?.isAdmin && <Row label="Role" value="Admin" />}
      </Card>
      <div className="mt-6">
        <Button variant="secondary" onClick={logout}>
          <IconLogout /> Sign out
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}
