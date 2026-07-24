import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import {
  PROVIDER_LABEL,
  type Connection,
  type ProviderId,
  type ProviderStatus,
} from '../lib/types.ts';
import { Button, Card, Field, Input, Modal, Pill, Spinner } from '../components/ui.tsx';
import { IconCheck, IconTrash } from '../components/icons.tsx';

const DESCRIPTIONS: Record<ProviderId, string> = {
  trakt: 'Watch history, ratings and progress.',
  simkl: 'History and lists (progress limited).',
  pmdb: 'History, resume points and lists.',
  mdblist: 'History, resume points and watchlist.',
};

export function Connections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState<ProviderId | null>(null);
  const [params, setParams] = useSearchParams();
  const connectedParam = params.get('connected');
  const errorParam = params.get('error');

  const connectRedirect = async (provider: ProviderId) => {
    const { url } = await api.get<{ url: string }>(`/api/connections/${provider}/authorize`);
    window.location.href = url;
  };

  const clearBanner = () => {
    params.delete('connected');
    params.delete('error');
    setParams(params, { replace: true });
  };

  const load = async () => {
    const [conns, provs] = await Promise.all([
      api.get<Connection[]>('/api/connections'),
      api.get<ProviderStatus[]>('/api/connections/providers'),
    ]);
    setConnections(conns);
    setProviders(provs);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const connected = (p: ProviderId) => connections.find((c) => c.provider === p);

  const disconnect = async (id: string) => {
    await api.del(`/api/connections/${id}`);
    void load();
  };

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Connections</h1>
        <p className="mt-1 text-sm text-muted">Link the accounts you want to sync between.</p>
      </header>

      {connectedParam && (
        <div className="mb-4 flex items-center justify-between rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
          <span>Connected {PROVIDER_LABEL[connectedParam as ProviderId] ?? connectedParam}.</span>
          <button onClick={clearBanner} className="text-xs opacity-80 hover:opacity-100">
            Dismiss
          </button>
        </div>
      )}
      {errorParam && (
        <div role="alert" className="mb-4 flex items-center justify-between rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger">
          <span>
            Couldn’t connect {PROVIDER_LABEL[errorParam as ProviderId] ?? errorParam}. Please try
            again.
          </span>
          <button onClick={clearBanner} className="text-xs opacity-80 hover:opacity-100">
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-muted">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-3">
          {providers.map(({ provider, configured, redirect }) => {
            const conn = connected(provider);
            return (
              <Card key={provider} className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{PROVIDER_LABEL[provider]}</span>
                    {conn &&
                      (conn.status === 'active' ? (
                        <Pill tone="success">
                          <IconCheck className="text-[11px]" /> {conn.label ?? 'Connected'}
                        </Pill>
                      ) : (
                        <Pill tone="danger">Reconnect needed</Pill>
                      ))}
                    {!configured && !isKeyProvider(provider) && (
                      <Pill tone="neutral">Not configured</Pill>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted">
                    {conn && conn.status !== 'active'
                      ? `${PROVIDER_LABEL[provider]} is no longer accepting this sign-in. Syncs using it will keep failing until you connect again.`
                      : DESCRIPTIONS[provider]}
                  </p>
                </div>
                {conn ? (
                  <div className="flex items-center gap-2">
                    {conn.status !== 'active' && !isKeyProvider(provider) && (
                      <Button
                        variant="secondary"
                        onClick={() => (redirect ? connectRedirect(provider) : setLinking(provider))}
                      >
                        Reconnect
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      onClick={() => disconnect(conn.id)}
                      aria-label={`Disconnect ${PROVIDER_LABEL[provider]}`}
                    >
                      <IconTrash /> Disconnect
                    </Button>
                  </div>
                ) : !isKeyProvider(provider) && redirect ? (
                  <div className="flex flex-col items-end gap-1">
                    <Button variant="secondary" onClick={() => connectRedirect(provider)}>
                      Connect
                    </Button>
                    <button
                      onClick={() => setLinking(provider)}
                      className="text-xs text-faint transition-colors hover:text-muted"
                    >
                      Use a code instead
                    </button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={!configured}
                    onClick={() => setLinking(provider)}
                  >
                    Connect
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {linking === 'trakt' && (
        <DeviceModal
          title="Connect Trakt"
          start={() =>
            api
              .post<{
                userCode: string;
                verificationUrl: string;
                deviceCode: string;
                interval: number;
              }>('/api/connections/trakt/device')
              .then((r) => ({
                userCode: r.userCode,
                url: r.verificationUrl,
                pollToken: r.deviceCode,
                interval: r.interval,
              }))
          }
          poll={(t) =>
            api
              .post<{ status: string }>('/api/connections/trakt/device/poll', { deviceCode: t })
              .then((r) => r.status)
          }
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            void load();
          }}
        />
      )}
      {linking === 'simkl' && (
        <DeviceModal
          title="Connect Simkl"
          start={() =>
            api
              .post<{ userCode: string; verificationUrl: string; interval: number }>(
                '/api/connections/simkl/pin',
              )
              .then((r) => ({
                userCode: r.userCode,
                url: r.verificationUrl,
                pollToken: r.userCode,
                interval: r.interval,
              }))
          }
          poll={(t) =>
            api
              .post<{ status: string }>('/api/connections/simkl/pin/poll', { userCode: t })
              .then((r) => r.status)
          }
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            void load();
          }}
        />
      )}
      {(linking === 'pmdb' || linking === 'mdblist') && (
        <ApiKeyModal
          provider={linking}
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

interface StartResult {
  userCode: string;
  url: string;
  pollToken: string;
  interval: number;
}

function DeviceModal({
  title,
  start,
  poll,
  onClose,
  onDone,
}: {
  title: string;
  start: () => Promise<StartResult>;
  poll: (token: string) => Promise<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [state, setState] = useState<StartResult | null>(null);
  const [status, setStatus] = useState<'starting' | 'waiting' | 'error'>('starting');
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let active = true;
    start()
      .then((s) => {
        if (!active) return;
        setState(s);
        setStatus('waiting');
        timer.current = setInterval(
          async () => {
            try {
              const st = await poll(s.pollToken);
              if (st === 'connected') {
                clearInterval(timer.current);
                onDone();
              } else if (st === 'expired' || st === 'denied') {
                clearInterval(timer.current);
                setStatus('error');
              }
            } catch {
              /* keep polling */
            }
          },
          Math.max(3, s.interval) * 1000,
        );
      })
      .catch(() => setStatus('error'));
    return () => {
      active = false;
      clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title={title} onClose={onClose}>
      {status === 'starting' && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Preparing…
        </div>
      )}
      {status === 'error' && (
        <p role="alert" className="text-sm text-danger">Couldn’t link the account. Please try again.</p>
      )}
      {state && status === 'waiting' && (
        <div className="space-y-4">
          <ol className="space-y-2 text-sm text-muted">
            <li>
              1. Open{' '}
              <a
                href={state.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand-ink hover:underline"
              >
                {state.url.replace('https://', '')}
              </a>
            </li>
            <li>2. Enter this code:</li>
          </ol>
          <div className="tnum rounded-lg border border-border bg-elevated py-4 text-center font-mono text-2xl font-semibold tracking-[0.25em] text-ink">
            {state.userCode}
          </div>
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Waiting for you to authorize…
          </div>
        </div>
      )}
    </Modal>
  );
}

type KeyProvider = 'pmdb' | 'mdblist';

const isKeyProvider = (provider: ProviderId): provider is KeyProvider =>
  provider === 'pmdb' || provider === 'mdblist';

const KEY_PROVIDERS: Record<KeyProvider, { title: string; hint: string; placeholder: string }> = {
  pmdb: {
    title: 'Connect PublicMetaDB',
    hint: 'Create one in PublicMetaDB under Settings → API.',
    placeholder: 'pm-…',
  },
  mdblist: {
    title: 'Connect MDBList',
    hint: 'Find your API key at mdblist.com/preferences.',
    placeholder: 'Your MDBList API key',
  },
};

function ApiKeyModal({
  provider,
  onClose,
  onDone,
}: {
  provider: KeyProvider;
  onClose: () => void;
  onDone: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const meta = KEY_PROVIDERS[provider];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post(`/api/connections/${provider}`, { apiKey });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not validate the key');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={meta.title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="API key" hint={meta.hint} error={error ?? undefined}>
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={meta.placeholder}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Connect
          </Button>
        </div>
      </form>
    </Modal>
  );
}
