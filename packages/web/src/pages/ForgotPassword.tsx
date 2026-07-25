import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { AuthShell } from './AuthShell.tsx';
import { Button, Field, Input } from '../components/ui.tsx';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    // The endpoint always responds the same way, so treat any completion as sent.
    try {
      await api.post('/api/auth/password/forgot', { email });
    } finally {
      setSent(true);
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Reset password" subtitle="We'll email you a link to set a new one.">
      {sent ? (
        <div className="space-y-4">
          <p role="status" className="rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
            If an account exists for {email || 'that address'}, a reset link is on its way. It expires in
            1 hour.
          </p>
          <Link to="/login" className="block text-center text-sm font-medium text-brand-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded">
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </Field>
            <Button type="submit" loading={loading} className="w-full">
              Send reset link
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-muted">
            Remembered it?{' '}
            <Link to="/login" className="font-medium text-brand-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded">
              Sign in
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
