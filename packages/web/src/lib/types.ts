export type ProviderId = 'trakt' | 'simkl' | 'pmdb';
export type DataType = 'history' | 'progress';

export interface User {
  id: string;
  email: string;
  username: string | null;
  emailVerified: boolean;
  isAdmin: boolean;
}

export interface Connection {
  id: string;
  provider: ProviderId;
  label: string | null;
  status: string;
  createdAt: string;
  lastValidatedAt: string | null;
}

export interface ProviderStatus {
  provider: ProviderId;
  configured: boolean;
  /** Whether the one-click browser redirect flow is available. */
  redirect: boolean;
}

export interface Sync {
  id: string;
  name: string;
  source: ProviderId;
  target: ProviderId;
  dataTypes: DataType[];
  direction: 'one_way' | 'two_way';
  intervalMinutes: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface DataTypeReport {
  dataType: DataType;
  planned: number;
  added: number;
  skippedPresent: number;
  skippedOther: number;
  unmatched: number;
  notFound: number;
  failed: number;
  note?: string;
}

export interface SyncReport {
  source: ProviderId;
  target: ProviderId;
  preview: boolean;
  results: DataTypeReport[];
}

export interface RunOutcome {
  status: 'success' | 'partial' | 'error';
  reports: SyncReport[];
  error?: string;
}

export interface SyncRun {
  id: string;
  trigger: string;
  status: string;
  report: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  pmdb: 'PublicMetaDB',
};
