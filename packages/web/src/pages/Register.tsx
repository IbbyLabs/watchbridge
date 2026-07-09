import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { AuthShell } from './AuthShell.tsx';
import { Button, Field, Input } from '../components/ui.tsx';
import { IconCheck } from '../components/icons.tsx';

export function Register() {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post('/api/auth/register', { email, username: username || undefined, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <AuthShell title="Check your email" subtitle={`We sent a verification link to ${email}.`}>
        <div className="flex items-start gap-3 rounded-lg bg-success/10 px-3 py-3 text-sm text-success">
          <IconCheck className="mt-0.5 text-base" />
          <span>Click the link in that email to activate your account, then sign in.</span>
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          <Link to="/login" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create account" subtitle="Sync your watch history in a few clicks.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </Field>
        <Field label="Username" hint="Optional — you can sign in with either.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="Password" hint="At least 8 characters." error={error ?? undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        </Field>
        <Button type="submit" loading={loading} className="w-full">
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
