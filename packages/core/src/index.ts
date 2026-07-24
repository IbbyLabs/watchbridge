export { createLogger, type Logger } from './logger.js';
export { SecretBox, parseEncryptionKey, safeEqual } from './crypto/secretBox.js';
export {
  resolveClientIp,
  type ClientIpOptions,
  type ClientIpResult,
  type ResolveClientIpInput,
} from './net/clientIp.js';
export {
  expandTrustedProxies,
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  LOOPBACK,
  PRIVATE_RANGES,
} from './net/cloudflare.js';
export { loadConfig, ConfigStartupError, type AppConfig, type RawEnv } from './config/env.js';

// Providers
export * from './providers/types.js';
export { HttpClient, HttpError } from './providers/http.js';
export { RateGate, sharedRateGate } from './providers/rateGate.js';
export {
  TraktClient,
  type TraktTokens,
  type TraktConfig,
  type DeviceCode,
} from './providers/trakt.js';
export { SimklClient, type SimklConfig, type SimklPin } from './providers/simkl.js';
export { PmdbClient } from './providers/pmdb.js';
export { MdblistClient } from './providers/mdblist.js';

// Sync engine
export { idStrings, itemKey, hasIdentity, MatchIndex } from './sync/identity.js';
export {
  planHistorySync,
  planProgressSync,
  planRatingsSync,
  planWatchlistSync,
  type HistoryPlan,
  type ProgressPlan,
  type RatingsPlan,
  type WatchlistPlan,
} from './sync/plan.js';
export { includedByFilters, type SyncFilters } from './sync/filters.js';
export {
  runSync,
  type SyncSource,
  type SyncTarget,
  type SyncReport,
  type DataTypeReport,
  type RunSyncOptions,
} from './sync/engine.js';
