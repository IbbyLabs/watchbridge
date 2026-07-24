import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { Button, Card, Field, Input } from '../components/ui.tsx';
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

      <ChangePassword />

      <ExportData />

      <div className="mt-8">
        <Button variant="secondary" onClick={logout}>
          <IconLogout /> Sign out
        </Button>
      </div>
    </div>
  );
}

function ExportData() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/export', { credentials: 'include' });
      if (!res.ok) throw new Error('failed');
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `watchbridge-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not build the export. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-ink">Your data</h2>
      <Card className="p-5">
        <p className="text-sm text-muted">
          Download everything Watchbridge holds for you as one JSON file: your account, what is
          connected, how your syncs are set up, and what every run did. Provider sign-ins are left
          out, so the file cannot be used to reach your Trakt or Simkl account.
        </p>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <Button variant="secondary" className="mt-4" loading={busy} onClick={download}>
          Download my data
        </Button>
      </Card>
    </section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await api.post('/api/auth/password/change', { currentPassword: current, newPassword: next });
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-ink">Change password</h2>
      <Card className="p-5">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Current password">
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label="Confirm new password" error={error ?? undefined}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          {done && (
            <p className="rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
              Password updated. Other devices have been signed out.
            </p>
          )}
          <Button type="submit" loading={loading}>
            Update password
          </Button>
        </form>
      </Card>
    </section>
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
