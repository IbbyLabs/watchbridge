import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { AuthShell } from './AuthShell.tsx';
import { Button, Field, Input } from '../components/ui.tsx';
import type { User } from '../lib/types.ts';

export function Login() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { setUser } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const verified = params.get('verified');
  const reset = params.get('reset');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await api.post<User>('/api/auth/login', { identifier, password });
      setUser(user);
      navigate('/syncs');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Welcome back to Watchbridge.">
      {verified === '1' && (
        <p className="mb-4 rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
          Email verified — you can sign in now.
        </p>
      )}
      {verified === '0' && (
        <p role="alert" className="mb-4 rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger">
          That verification link is invalid or expired.
        </p>
      )}
      {reset === '1' && (
        <p className="mb-4 rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
          Password updated — sign in with your new password.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email or username">
          <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label="Password" error={error ?? undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <div className="text-right">
          <Link to="/forgot-password" className="text-sm font-medium text-brand-ink hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" loading={loading} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        No account?{' '}
        <Link to="/register" className="font-medium text-brand-ink hover:underline">
          Create one
        </Link>
      </p>
    </AuthShell>
  );
}
