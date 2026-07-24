import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import {
  PROVIDER_LABEL,
  type Connection,
  type DataType,
  type ProviderId,
  type RunOutcome,
  type Sync,
  type SyncFilters,
  type SyncRun,
} from '../lib/types.ts';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Pill,
  Select,
  Spinner,
} from '../components/ui.tsx';
import {
  IconArrowRight,
  IconArrows,
  IconClock,
  IconPlus,
  IconTrash,
} from '../components/icons.tsx';

const PROVIDERS: ProviderId[] = ['trakt', 'simkl', 'pmdb', 'mdblist'];
const DATA_TYPES: { id: DataType; label: string }[] = [
  { id: 'history', label: 'Watch history' },
  { id: 'progress', label: 'Playback progress' },
  { id: 'ratings', label: 'Ratings' },
  { id: 'watchlist', label: 'Watchlist' },
];

export function Syncs() {
  const [syncs, setSyncs] = useState<Sync[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const [s, c] = await Promise.all([
      api.get<Sync[]>('/api/syncs'),
      api.get<Connection[]>('/api/connections'),
    ]);
    setSyncs(s);
    setConnections(c);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Syncs</h1>
          <p className="mt-1 text-sm text-muted">
            Move watch data between your connected accounts.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <IconPlus /> New sync
        </Button>
      </header>

      {loading ? (
        <div className="flex justify-center py-16 text-muted">
          <Spinner />
        </div>
      ) : syncs.length === 0 ? (
        <EmptyState title="No syncs yet">
          Create a sync to keep history and progress in step between Trakt, Simkl and PublicMetaDB.
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          {syncs.map((s) => (
            <SyncCard key={s.id} sync={s} onChange={load} />
          ))}
        </div>
      )}

      {creating && (
        <CreateSyncModal
          connections={connections}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function SyncCard({ sync, onChange }: { sync: Sync; onChange: () => void }) {
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [busy, setBusy] = useState<'preview' | 'run' | null>(null);
  const [runs, setRuns] = useState<SyncRun[] | null>(null);
  const now = useNow();
  const nextAt = nextRunAt(sync);

  const act = async (mode: 'preview' | 'run') => {
    setBusy(mode);
    setOutcome(null);
    try {
      setOutcome(await api.post<RunOutcome>(`/api/syncs/${sync.id}/${mode}`));
      if (mode === 'run') {
        onChange();
        setRuns(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    await api.patch(`/api/syncs/${sync.id}`, { enabled: !sync.enabled });
    onChange();
  };

  const remove = async () => {
    await api.del(`/api/syncs/${sync.id}`);
    onChange();
  };

  const loadRuns = async () => {
    setRuns(runs ? null : await api.get<SyncRun[]>(`/api/syncs/${sync.id}/runs`));
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-medium text-ink">{sync.name}</span>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          {PROVIDER_LABEL[sync.source]}
          {sync.direction === 'two_way' ? (
            <IconArrows className="text-brand" />
          ) : (
            <IconArrowRight className="text-brand" />
          )}
          {PROVIDER_LABEL[sync.target]}
        </span>
        <div className="flex items-center gap-1.5">
          {sync.dataTypes.map((d) => (
            <Pill key={d} tone="brand">
              {d}
            </Pill>
          ))}
        </div>
        {sync.intervalMinutes && (
          <Pill tone="neutral">
            <IconClock className="text-[11px]" /> every {formatInterval(sync.intervalMinutes)}
            {nextAt !== null && (
              <span className="text-faint"> · next {formatNextRun(nextAt, now)}</span>
            )}
          </Pill>
        )}
        {describeFilters(sync.filters) && (
          <Pill tone="neutral">{describeFilters(sync.filters)}</Pill>
        )}
        {sync.dataTypes.includes('ratings') && sync.ratingsAuthority && (
          <Pill tone="neutral">ratings from {PROVIDER_LABEL[sync.ratingsAuthority]}</Pill>
        )}
        {sync.propagateWatchlistRemovals && <Pill tone="neutral">watchlist removals on</Pill>}
        <LastRunPill sync={sync} now={now} />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={toggle}>
            {sync.enabled ? 'Enabled' : 'Paused'}
          </Button>
          <Button variant="secondary" loading={busy === 'preview'} onClick={() => act('preview')}>
            Preview
          </Button>
          <Button loading={busy === 'run'} onClick={() => act('run')}>
            Run now
          </Button>
          <Button variant="danger" onClick={remove} aria-label="Delete sync">
            <IconTrash />
          </Button>
        </div>
      </div>

      {outcome && <OutcomeView outcome={outcome} />}

      <div className="mt-3 border-t border-border pt-3">
        <button
          onClick={loadRuns}
          className="text-xs font-medium text-muted transition-colors hover:text-ink"
        >
          {runs ? 'Hide run history' : 'Run history'}
        </button>
        {runs && (
          <div className="mt-2 space-y-1">
            {runs.length === 0 ? (
              <p className="text-xs text-faint">No runs yet.</p>
            ) : (
              runs.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-xs text-muted">
                  <RunStatus status={r.status} />
                  <span className="tnum">{new Date(r.startedAt).toLocaleString()}</span>
                  <span className="text-faint">· {r.trigger}</span>
                  {r.error && <span className="text-danger">· {r.error}</span>}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function OutcomeView({ outcome }: { outcome: RunOutcome }) {
  if (outcome.status === 'error') {
    return (
      <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
        {outcome.error ?? 'Run failed'}
      </p>
    );
  }
  const preview = outcome.reports[0]?.preview;
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-elevated/60 px-3 py-2.5">
      {outcome.reports.map((rep, i) => (
        <div key={i}>
          <p className="text-xs font-medium text-muted">
            {PROVIDER_LABEL[rep.source]} → {PROVIDER_LABEL[rep.target]}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {rep.results.map((res) => (
              <Pill key={res.dataType} tone={res.added > 0 ? 'success' : 'neutral'}>
                {res.dataType}: {preview ? `${res.planned} to apply` : `+${res.added}`}
                {!preview && res.removed !== undefined && res.removed > 0 && ` · −${res.removed} removed`}
                {res.skippedPresent > 0 && ` · ${res.skippedPresent} already there`}
                {res.unmatched > 0 && ` · ${res.unmatched} unmatched`}
                {res.note && ` · ${res.note}`}
              </Pill>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * At-a-glance outcome of the last run. A sync that quietly stopped working is
 * the failure mode users notice last, so it belongs on the card, not behind the
 * run-history toggle.
 */
function LastRunPill({ sync, now }: { sync: Sync; now: number }) {
  if (!sync.lastRunAt) return <Pill tone="neutral">Never run</Pill>;
  const when = formatAgo(new Date(sync.lastRunAt).getTime(), now);
  if (sync.lastRunStatus === 'error') return <Pill tone="danger">Failed {when}</Pill>;
  if (sync.lastRunStatus === 'partial') return <Pill tone="danger">Partly failed {when}</Pill>;
  return <Pill tone="success">Ran {when}</Pill>;
}

/** Coarse relative time. Precision past "hours" is noise on a sync list. */
function formatAgo(at: number, now: number): string {
  const mins = Math.round((now - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function RunStatus({ status }: { status: string }) {
  const tone = status === 'success' ? 'bg-success' : status === 'error' ? 'bg-danger' : 'bg-brand';
  return <span className={`h-1.5 w-1.5 rounded-full ${tone}`} aria-hidden />;
}

function CreateSyncModal({
  connections,
  onClose,
  onDone,
}: {
  connections: Connection[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState<ProviderId>('trakt');
  const [target, setTarget] = useState<ProviderId>('pmdb');
  const [types, setTypes] = useState<DataType[]>(['history']);
  const [direction, setDirection] = useState<'one_way' | 'two_way'>('one_way');
  const [interval, setInterval] = useState('');
  const [syncMovies, setSyncMovies] = useState(true);
  const [syncShows, setSyncShows] = useState(true);
  const [syncSpecials, setSyncSpecials] = useState(true);
  const [ratingsAuthority, setRatingsAuthority] = useState<ProviderId | ''>('');
  const [propagateRemovals, setPropagateRemovals] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const connectedIds = new Set(connections.map((c) => c.provider));
  const ratingsOn = types.includes('ratings');
  // Two-way removals would delete an item just added on the other side.
  const canPropagateRemovals = types.includes('watchlist') && direction === 'one_way';

  const toggleType = (t: DataType) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  /** Only send a filters object when it narrows the default (sync everything). */
  const buildFilters = () => {
    const f: SyncFilters = {};
    if (!syncMovies) f.movies = false;
    if (!syncShows) f.shows = false;
    if (!syncSpecials) f.excludeSpecials = true;
    return Object.keys(f).length > 0 ? f : null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (source === target) return setError('Source and target must be different');
    if (types.length === 0) return setError('Pick at least one data type');
    if (!syncMovies && !syncShows) return setError('Turning off both movies and shows syncs nothing');
    if (ratingsOn && ratingsAuthority !== source && ratingsAuthority !== target)
      return setError('Pick which side is the ratings authority');
    setLoading(true);
    setError(null);
    try {
      await api.post('/api/syncs', {
        name: name || `${PROVIDER_LABEL[source]} → ${PROVIDER_LABEL[target]}`,
        source,
        target,
        dataTypes: types,
        ratingsAuthority: ratingsOn ? ratingsAuthority : null,
        propagateWatchlistRemovals: canPropagateRemovals && propagateRemovals,
        direction,
        intervalMinutes: interval ? Number(interval) : null,
        filters: buildFilters(),
      });
      onDone();
    } catch {
      setError('Could not create the sync');
    } finally {
      setLoading(false);
    }
  };

  const providerOption = (p: ProviderId) => (
    <option key={p} value={p}>
      {PROVIDER_LABEL[p]}
      {connectedIds.has(p) ? '' : ' (not connected)'}
    </option>
  );

  return (
    <Modal title="New sync" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" hint="Optional.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Trakt → PublicMetaDB"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Select value={source} onChange={(e) => setSource(e.target.value as ProviderId)}>
              {PROVIDERS.map(providerOption)}
            </Select>
          </Field>
          <Field label="To">
            <Select value={target} onChange={(e) => setTarget(e.target.value as ProviderId)}>
              {PROVIDERS.map(providerOption)}
            </Select>
          </Field>
        </div>
        <Field label="Data">
          <div className="flex flex-wrap gap-2">
            {DATA_TYPES.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={types.includes(d.id)}
                onClick={() => toggleType(d.id)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  types.includes(d.id)
                    ? 'border-brand bg-brand/15 text-ink'
                    : 'border-border text-muted hover:text-ink'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </Field>
        {ratingsOn && (
          <Field
            label="Ratings authority"
            hint="Ratings can't be dated, so one side must win a disagreement. Its score is copied to the other."
          >
            <Select
              value={ratingsAuthority === source || ratingsAuthority === target ? ratingsAuthority : ''}
              onChange={(e) => setRatingsAuthority(e.target.value as ProviderId | '')}
            >
              <option value="" disabled>
                Choose a side…
              </option>
              <option value={source}>{PROVIDER_LABEL[source]} (source)</option>
              <option value={target}>{PROVIDER_LABEL[target]} (target)</option>
            </Select>
          </Field>
        )}
        {canPropagateRemovals && (
          <Field
            label="Watchlist removals"
            hint="Off, an item taken off one watchlist stays on the other. On, Simkl also drops it from your history and clears its rating, because Simkl has no list-only removal."
          >
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={propagateRemovals}
                onChange={(e) => setPropagateRemovals(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-brand"
              />
              Remove items from the target when the source drops them
            </label>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Direction">
            <Select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'one_way' | 'two_way')}
            >
              <option value="one_way">One-way</option>
              <option value="two_way">Two-way</option>
            </Select>
          </Field>
          <Field label="Every (minutes)" hint="Blank = manual only.">
            <Input
              type="number"
              min={15}
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              placeholder="Manual"
            />
          </Field>
        </div>
        <Field label="Include" hint="Everything is included by default. Switch anything off to narrow the sync.">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleChip pressed={syncMovies} onClick={() => setSyncMovies((v) => !v)}>
              Movies
            </ToggleChip>
            <ToggleChip pressed={syncShows} onClick={() => setSyncShows((v) => !v)}>
              Shows
            </ToggleChip>
            <ToggleChip pressed={syncSpecials} onClick={() => setSyncSpecials((v) => !v)}>
              Specials
            </ToggleChip>
          </div>
        </Field>
        {!syncMovies && !syncShows && (
          <p className="text-sm text-danger">Turning off both movies and shows syncs nothing.</p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Create sync
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A short human summary of a sync's scope, or null when it syncs everything. */
function describeFilters(filters: SyncFilters | null): string | null {
  if (!filters) return null;
  const parts: string[] = [];
  if (filters.movies === false) parts.push('no movies');
  if (filters.shows === false) parts.push('no shows');
  if (filters.excludeSpecials) parts.push('no specials');
  const excluded = filters.exclude?.length ?? 0;
  if (excluded > 0) parts.push(`${excluded} excluded`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function ToggleChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
        pressed
          ? 'border-brand bg-brand/15 text-ink'
          : 'border-border text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** A ticking clock so relative times stay current without a page refresh. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** When the scheduler will next run this sync, or null if it won't (paused / manual). */
function nextRunAt(sync: Sync): number | null {
  if (!sync.enabled || !sync.intervalMinutes) return null;
  const last = sync.lastRunAt ? new Date(sync.lastRunAt).getTime() : 0;
  return last + sync.intervalMinutes * 60_000;
}

function formatNextRun(atMs: number, now: number): string {
  const mins = Math.round((atMs - now) / 60_000);
  if (mins <= 0) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}
