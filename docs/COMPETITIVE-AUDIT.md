# Watchbridge competitive audit

A research audit of Watchbridge against every comparable tool we could find, plus the feature
requests and bug reports filed against those tools. Nothing here has been implemented. This is a
scored backlog and a list of hazards to design against.

## How this was produced

Sixteen research agents each took one competitor or problem domain and mined its README, docs,
changelog, issue tracker (open and closed, ranked by reactions), discussions, official API
reference, and the relevant Reddit and forum threads. Every finding had to carry a real source URL
or a real `gh` query result, and anything that could not be verified was marked as such.

Covered: PlexTraktSync, WatchState, JellyPlex-Watched, CrossWatch, the Jellyfin, Emby and Kodi Trakt
plugins, trakt-scrobbler, Universal Trakt Scrobbler, Trakt's own product and API, Simkl's own
product and API, MALSync, PlexAniSync, shinkro, AniBridge and the AniDB/TVDB/TMDB mapping datasets,
imdb-trakt-sync, TraktRater and the Letterboxd/IMDb/TV Time importers, MDBList, Kometa and the list
ecosystem, watch-data backup and export tools, and the operational conventions of the Servarr family
and Jellyfin.

That produced **739 findings across roughly 625 distinct sources**. A scoring pass then checked each
finding against the actual Watchbridge codebase and rated it, giving **565 scored items**, of which
**491 are not already built**. A per-category editing pass merged duplicates and ranked what
survived. The sections below are that output.

## Reading the scores

`Score = (impact x 2) + feasibility - effort penalty`, where impact and feasibility are 1 to 5 and
the effort penalty is S=0, M=1, L=2, XL=3. The range in practice is 1 to 15. Feasibility is judged
against Watchbridge's current architecture and the providers' real documented APIs, so a low
feasibility usually means the API does not expose what the feature needs, not that the code would be
hard to write.

`Have it?` is `no` or `partial`. Items already fully built were dropped from the tables and are
named in an "already covered" line at the end of each section.

## The audit's top finding — fixed

**Trakt playback progress was pulled without pagination and truncated at 100 items.**

`pullProgress` requested `/sync/playback?limit=100&extended=full` and never asked for a second page,
while the history pull did page correctly, so any user with more than 100 in-progress items silently
synced only the first 100. It now goes through `pageAll`, which was also hardened for the case this
raised: whether `/sync/playback` paginates at all was never confirmed, so `pageAll` stops when a
response exceeds the requested limit (an unpaginated endpoint returning everything at once) and when
a page repeats its first row (an endpoint ignoring `page`), rather than assuming either behaviour.

The surrounding context is confirmed. Trakt's phased 2026 rollout, per
[trakt-api discussion #681](https://github.com/trakt/trakt-api/discussions/681), was: mid-February
list-items pagination required, end of February collection endpoints, **mid-April unparameterised
requests start defaulting to 100 items**, and mid-June the maximum `limit` on all paginated
endpoints cut from 1000 to 250. Every one of those milestones has now passed. Two research agents
independently raised this as the highest-scoring finding in the audit.

The code reading is first-hand. The dates are from Trakt's own discussion thread.

## Known bug in the shipped watchlist feature (needs a decision)

**Trakt auto-removes a watchlist item once it is watched** — confirmed verbatim from Trakt's own
docs: *"When an item is watched, it will be automatically removed from the watchlist. For shows and
seasons, watching 1 episode will remove the entire show or season."* The watchlist sync is additive,
so when Simkl still lists a title as plan-to-watch (or hold) but Trakt has auto-removed it on watch,
each run re-adds it to Trakt, Trakt drops it again, and it never converges — burning the Trakt write
limit every run.

The fix is a behaviour fork, so it is **not** built yet:
- **Delivery memory for watchlist adds** (mirrors history): once added, never re-added even if the
  target no longer lists it. Stops the loop; consistent with the already-locked additive model; but a
  *manual* removal on the target is then also not undone. Needs a data-type discriminator on the
  `deliveries` table.
- **Watched-status check**: skip re-adding a title already watched on the target. Surgical to this
  exact case; leaves manual re-adds working; but couples watchlist sync to a history pull.

Awaiting Ibby's choice. Until then, a Trakt-target watchlist sync will not converge on watched titles.

## What the audit confirms is already right

The correctness foundations hold up well against the field. ID-only matching, the additive
idempotent planner, per-sync delta cursors, encrypted token storage, per-user provider linking, and
the delivery-memory table all came back as "already covered" against items that competitors are
still fighting. Several of the highest-scoring correctness items below are regression tests and
guards that protect properties Watchbridge already has, rather than new behaviour.

## Top 30 across every category

| # | Item | Area | Why it matters | Effort | Score |
|---|---|---|---|---|---|
| 1 | Verify Trakt pull paths handle mandatory pagination — DONE, and every milestone has already passed | Providers | Trakt enforces pagination and caps page size; unpaginated pulls silently return only the first page. `pageAll` loops and asks for 100 per page, inside the 250 cap. | S | 15 |
| 2 | Trakt is actively cutting max page size to 250 and enforcing mandatory pagination | Providers | Trakt's phased 2026 rollout (already past its Feb/April milestones by the current date) makes pagination mandatory on list/collection endpoints,... | S | 15 |
| 3 | Regression test: same sync re-run never inflates target play count | Sync correctness | Every Trakt media-server plugin has shipped a duplicate-history bug (100x replays, account lockouts); Watchbridge's architecture avoids the root... | S | 15 |
| 4 | Clamp writes that would push an episode number above the target's known episode total | Sync correctness | No guard exists today to stop a write when the source's episode number exceeds what the target entry actually has — the exact failure mode that... | S | 15 |
| 5 | Guard: refuse a run when the source unexpectedly returns zero items | Sync correctness | A documented Jellyfin-Trakt failure mode: syncing from a fresh/empty library propagated 'not watched' outward and wiped an entire Trakt history.... | S | 15 |
| 6 | Hard-abort on empty/partial source before any removal propagation ships | Sync correctness | A competitor deleted a user's entire watchlist when its source was unreachable and it read an empty snapshot as 'user removed everything'. This... | S | 15 |
| 7 | Warn users before OAuth token expiry instead of silent failures for weeks | Interface | Connection health (active/expiring/needs-reconnect) should be visible in the UI and emailed proactively, using infrastructure Watchbridge already has. | M | 14 |
| 8 | Expose per-item run detail (matched ref, ID types tried, reason) in the UI | Observability | The data for this already exists in Watchbridge's JSON run reports; the gap is exposing it per item so users can self-diagnose instead of filing... | M | 14 |
| 9 | pushProgress always calls /scrobble/pause — fails above ~80% progress on Trakt and likely MDBList | Sync correctness | TraktClient.pushProgress and MdblistClient.pushProgress unconditionally POST to the pause-style scrobble endpoint for every progress value 1-100.... | M | 14 |
| 10 | Guarantee exactly one write path per item per run (no double-scrobble) | Sync correctness | Confirm the additive planner never lets a progress push and a history push for the same item both materialize as a play, the most common... | S | 14 |
| 11 | Enforce a global per-provider outbound rate ceiling, not just per-sync concurrency | Providers | A shared app-wide client_id (Trakt, Simkl) means the whole app's API access can be revoked by one user's syncs firing concurrently, even though... | M | 13 |
| 12 | Add a documented per-provider rate-limit budget (Trakt: 1 write/sec, 1000 GET/5min) | Providers | Per-item fan-out writes exceed Trakt's documented 1 call/sec POST limit almost immediately; batch endpoints and a token bucket are the fix. | M | 13 |
| 13 | Treat HTTP 423 Locked as 'provider has blocked this app' — stop, don't retry | Providers | A circuit breaker per provider connection should trip on 423 (or repeated failed-refresh 401s), disabling the sync and requiring explicit user... | M | 13 |
| 14 | 'On Manual Interaction Required' event for expired/revoked provider tokens | Observability | A distinct, non-batched event for 'a human must act now' — the Watchbridge analogue is a Trakt/Simkl OAuth token expiring or being revoked, which... | M | 13 |
| 15 | Failure notifications (generic webhook / Apprise-compatible / Discord / ntfy) | Observability | A scheduled sync that silently stops working is worse than no sync at all. Watchbridge has zero notification surface today — a user only discovers... | M | 13 |
| 16 | Read-only/scriptable public API with API-key auth | Accounts | WatchState exposes ~120 documented endpoints under API-key/bearer auth so any script (Home Assistant, n8n, monitoring) can trigger syncs and read... | M | 13 |
| 17 | Full account data export (JSON snapshot) | Migration | Ship a synchronous 'Export my data' feature that produces a downloadable JSON snapshot of everything Watchbridge holds for a user (history,... | M | 13 |
| 18 | Distinguish 'nothing changed' from 'cursor stuck' and add periodic full reconciliation | Sync correctness | WatchState's two most-commented issues (44 and 36 comments) both describe delta export silently no-op'ing while a forced full export works fine —... | M | 13 |
| 19 | Fix the open Simkl episode non-convergence bug using the read-back-must-match-write-scope lesson | Sync correctness | Watchbridge has an open, known bug where writes into Simkl re-add all episodes every run (non-convergence). JellyPlex-Watched hit the identical... | M | 13 |
| 20 | Sync run aborts and drops delivery-memory bookkeeping when a later data type throws mid-run | Sync correctness | runSync() builds results for all requested data types inside one function call; if history succeeds (and is already pushed to the target) but the... | M | 13 |
| 21 | Simkl history push ignores not_found/added in the /sync/history response — false convergence bookkeeping | Sync correctness | pushHistory() posts to /sync/history and, on any non-throwing response, counts every movie/show/episode sent as 'added' without ever reading the... | M | 13 |
| 22 | Undo last sync run | Sync correctness | Turn Watchbridge's existing per-run report + delivery-memory table into an 'Undo this run' action: remove exactly the refs a given run added and... | M | 13 |
| 23 | Fix the known Simkl episode non-convergence bug (writes re-add all episodes every run) | Sync correctness | An already-open Watchbridge bug: Simkl episode writes never converge while movie writes do, meaning delivery memory isn't preventing replays for... | M | 13 |
| 24 | planProgressSync ignores timestamps entirely and can push progress backward | Sync correctness | The progress planner only compares /target.progress - source.progress/ against a 1-point threshold; it never reads ProgressEvent.pausedAt on... | M | 13 |
| 25 | HttpClient's single minIntervalMs doesn't distinguish Simkl's 10 GET/sec vs 1 POST/sec caps | Scheduling | Simkl documents two separate rate buckets: 10 GET/sec and 1 POST/sec. Watchbridge's SimklClient is configured with one flat minIntervalMs: 300... | S | 13 |
| 26 | Surface last-successful-run status per sync in the dashboard | Interface | WatchState's failure mode is quiet — users only notice missing data by accident. Watchbridge already stores lastRunAt and per-run status but... | S | 13 |
| 27 | Explicit initial-backfill choice: full history vs. new-data-only | Interface | On first connecting a sync, ask the user whether to backfill their entire history or start from now, and persist that cutoff. | S | 13 |
| 28 | Default any list created on a user's behalf to private, widen only on explicit opt-in | Security | Trakt's own web client shipped a bug where a private user's newly created list defaulted to public. A sync service creating lists on the user's... | S | 13 |
| 29 | Classify provider push responses: accepted / permanently-rejected / transient | Providers | Treat Trakt 409 (already scrobbled) as success and 404 as permanent-reject-don't-retry, rather than lumping all non-2xx into a generic failed count. | S | 13 |
| 30 | CSV export alongside JSON | Migration | Offer a flat 'one row per play' CSV export (title, year, type, season, episode, watched_at, imdb/tmdb/tvdb/etc ids, provider) next to the JSON... | S | 13 |

## Sync correctness

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Abort a run when a source pull returns zero or far fewer items than last time | A source that returns an empty or truncated snapshot (auth expiry, 5xx masquerading as empty, pagination change) is currently indistinguishable from "nothing to sync", and becomes catastrophic the moment any removal path exists. | no | 5 | 5 | S | 15 |
| Clamp or flag writes where the episode number exceeds the target's known episode total | No bound check exists, so an out-of-range episode write lands silently and produces the "season 2 episode 1 marked on season 1" class of wrong data. | no | 5 | 5 | S | 15 |
| Regression tests pinning idempotency and the delivery-memory path | The additive planner plus delivery memory already avoid duplicate plays, but nothing asserts that a second identical run writes zero items or that a cursor reset cannot bypass `DeliveriesStore`. | partial | 5 | 5 | S | 15 |
| Simkl history push ignores `not_found` in the response and counts everything as added | `pushHistory` never parses the `/sync/history` body, so rejected items are recorded as delivered and the cursor advances past them; this is the most likely root cause of the open Simkl episode non-convergence bug. | partial | 5 | 4 | M | 14 |
| `pushProgress` always posts `/scrobble/pause`, which Trakt rejects above ~80% | Every near-complete viewing session, the most common real case, fails silently and shows up only as an opaque failed counter. | no | 5 | 5 | M | 14 |
| Guarantee exactly one write path per item per run | With history and progress both enabled, a finished item can produce a history add and a stale sub-100 progress write in the same run, which is the duplicate-play and stuck-at-99% bug class. | partial | 5 | 4 | M | 14 |
| Progress planner ignores timestamps and can push progress backward | `planProgressSync` compares only a 1-point percentage delta and never reads `pausedAt`, so a deliberate rewind on one side can be reverted, and a completed watch can be overwritten by a stale partial position. | no | 5 | 4 | M | 13 |
| Distinguish "converged" from "cursor stuck", plus a user-facing full resync | A stuck delta cursor silently stops a sync forever while reports look clean, and recovery today needs direct DB access. | no | 5 | 4 | M | 13 |
| Isolate failures per data type and per direction | One throw in `runSync` discards already-computed results, so delivery memory is never recorded for items the target already accepted, and a partially successful run reports as a hard error. | partial | 5 | 4 | M | 13 |
| Trakt `/sync/playback` pull is not paginated | `pullProgress` makes a single `limit=100` call while `pullHistory` correctly loops via `pageAll`, so users past 100 in-progress items silently lose the tail every run. | no | 4 | 5 | S | 13 |
| Undo a sync run from the deliveries ledger | The `deliveries` table plus per-run JSON reports already contain what an undo needs, and no competitor offers one; a bad run currently has no recovery path. | partial | 5 | 4 | M | 13 |
| Full progress deadband spec: minimum floor, near-complete cutoff, timestamp tolerance | The single hardcoded 1-point threshold lets accidental few-second plays pollute a target's resume list and offers no cutoff where history should take over. | no | 4 | 5 | S | 13 |
| Guard against null/empty external-ID collisions in matching | Two distinct items with no usable IDs must never share a match key; nothing currently asserts `itemKey` cannot return a shared sentinel. | partial | 4 | 5 | S | 13 |
| Single-flight lock per sync | A manual "Run now" during a scheduler tick can race the same sync, producing concurrent writes and racing delivery-memory rows. | partial | 4 | 5 | S | 13 |
| Pagination discipline on every list-style provider read | Trakt is dropping default page sizes and tightening pagination on watched and list endpoints; a truncated read must never be treated as authoritative. | partial | 4 | 5 | S | 12 |
| Simkl pull swallows per-bucket errors to empty while the cursor still advances | Each bucket has a `.catch(() => [])` fallback and `advanceCursor` only inspects push failures, so a transient 5xx permanently skips whatever changed in that window. | partial | 4 | 4 | M | 12 |
| Guard against the "watched always wins over unwatched" feedback loop | Any un-watch feature without a changed-at arbitration re-marks the item watched from the other side on the next tick, which reads as data corruption. | no | 5 | 3 | M | 12 |
| Trakt auto-removes watchlist items on watch | Watching one episode removes the show from the Trakt watchlist, so an additive watchlist sync will re-add forever what Trakt keeps deleting. | no | 5 | 3 | M | 12 |
| Opt-in un-watch and removal propagation, with a named sync mode | The loudest open request across every comparable tool; needs a per-sync flag, a delivery-memory status column, and the empty-source guard above as a hard prerequisite. | no | 5 | 3 | L | 11 |
| Per-run write cap and a preview gate before first write to a new connection | A planner bug in a competitor injected roughly 1,287 fake events into a real account with no brake; the preview route already exists to build the gate on. | partial | 4 | 4 | M | 11 |
| Delivery-memory expiry or a per-sync "forget delivered refs" reset | Memory that never expires can resurrect data a user deliberately deleted downstream, with no UI escape. | partial | 4 | 4 | M | 11 |
| Durable retry queue for failed pushes and for `notFound` items | Transient push failures and unmatched items are counted once and then forgotten, so a play that never landed is invisible and never retried. | partial | 4 | 4 | M | 11 |
| Map Trakt 420 and 423 to typed, human-readable, non-retryable errors | `HttpClient` only special-cases 429 and 5xx, so an account-limit or lock surfaces as a raw status string and never flips the connection status. | no | 4 | 4 | M | 11 |
| Validate persisted JSON state on read and write | `cursors`, `dataTypes` and `report` are raw text columns; a malformed value can crash a run or silently fail to save while the UI reports success. | partial | 3 | 5 | S | 11 |
| Read-your-own-write inside a single run | A state change recorded during the pull phase must be included in the same run's push, not deferred a full interval with no error surfaced. | no | 4 | 4 | M | 11 |
| Recency-window and timestamp-tolerance dedup | Presence-only matching means minor timestamp drift, or a third-party scrobbler writing to the same account, can manufacture a duplicate play. | partial | 3 | 4 | S | 11 |
| Trakt history pull does not request specials or hidden-season episodes | Watched season-0 episodes can drop out of the source read entirely, which the additive planner reads as "not present" rather than a missing query parameter. | no | 3 | 5 | S | 11 |
| Direction configurable per data type, not per sync | One `direction` column applies to the whole `dataTypes` array, forcing users into overlapping duplicate syncs. | no | 4 | 4 | M | 11 |
| Conflict-resolution policy: authoritative source, newest wins, first-run mode | Two-way syncs have no arbitration beyond additive union, and the first run against an account with existing history offers no visible choice. | partial | 4 | 4 | M | 11 |
| Assert every config toggle changes actual plan output | A checkbox wired to the UI but never read by the planner reports success while doing nothing; the preview route makes this cheap to test. | partial | 3 | 5 | S | 11 |
| Document additive-only and no-rewatch in-product, and surface `unmatched` | These are deliberate correct tradeoffs, but undisclosed they get filed as bugs; the unmatched list should read "no shared external ID" rather than a bare count. | partial | 3 | 5 | S | 11 |
| Write semantics for new data types: rating granularity, side effects, timestamps | Trakt rates a bare show without episode expansion, Simkl rating writes mutate list membership and are destroyed on history removal, and `rated_at` must never be replaced by run time. | no | 4 | 4 | M | 11 |
| Tolerate unknown fields in provider responses and degrade per item | Current casts are permissive, but nothing pins that, and one malformed item should be recorded as failed rather than aborting the run. | partial | 3 | 5 | S | 10 |
| Normalize provider timestamps to UTC, never compare against local clock | Clock skew and mixed-zone timestamps cause self-reinforcing corruption that a re-run cannot repair; skew should cause a redundant re-read, never a permanent skip. | no | 3 | 4 | S | 10 |
| Round-trip progress values and edge-case timestamps across every provider pair | Unit mismatches (percent vs seconds vs ms) deserialize silently and only surface when a user notices a wildly wrong resume point. | no | 3 | 4 | S | 10 |
| Diff and batch construction guards | Removing one source item must affect exactly one target item, and per-item payloads must be built fresh rather than mutated from a hoisted accumulator. | no | 3 | 4 | S | 10 |
| Extend the delivery-memory key for future webhook and pull overlap | Keying on `itemKey` alone will double-fire once an event path exists alongside the scheduled pull. | partial | 3 | 4 | S | 10 |
| Give `deliveries` a status column (last-state upsert, not append log) | There is currently no way to represent "removed" as distinct from "never pushed", which blocks any removal propagation from ever converging. | no | 4 | 4 | L | 10 |
| Anime identity mapping layer with split-cour fold guard | Absolute-numbered sources cannot correctly sync against season-numbered targets without a range and ratio mapping dataset plus local overrides. | no | 5 | 2 | XL | 9 |
| Non-destructive `diverged` bucket in run reports | An item present on the target but gone from the source is currently invisible; flagging is the only shippable middle ground between ignoring and deleting. | no | 3 | 4 | M | 9 |

### Notes

- The Simkl item is the one confirmed live bug in this set and has a concrete root cause worth trying first: `pushHistory` posts to `/sync/history` and computes `added` from the input arrays, never from the response body. Simkl documents that a 201 does not mean the items were written; anime season mismatches and S00 specials land in `not_found`. Because `advanceCursor` only inspects `report.failed`, rejected items are recorded as delivered and the cursor moves past them. Fix is to derive `added`/`failed`/`notFound` from the parsed response and return only the confirmed refs. See the [Simkl add-to-history reference](https://api.simkl.org/api-reference/simkl/add-to-history.md) and the identical read-back-scope failure in [JellyPlex-Watched #355](https://github.com/luigi311/JellyPlex-Watched/issues/355) and [PlexTraktSync #1923](https://github.com/Taxel/PlexTraktSync/issues/1923).
- Two source-verified defects are cheap and independent of everything else: `pullProgress` calls `/sync/playback?limit=100` once instead of routing through the existing `pageAll` helper, and `pushProgress` unconditionally posts `/scrobble/pause` for progress values Trakt rejects above ~80%. Both fail silently and only show as counters. Pagination context: [trakt-api #775](https://github.com/trakt/trakt-api/discussions/775) and the truncation bug it caused in [PlexTraktSync #2452](https://github.com/Taxel/PlexTraktSync/issues/2452).
- The empty-source guard, the write cap, and the deliveries status column are all prerequisites for un-watch propagation, not follow-ups. Ship them first or the removal feature inherits the worst incident in the research set: a provider 500 read as an empty snapshot wiping roughly 7,350 records ([CrossWatch #358](https://github.com/cenodude/CrossWatch/issues/358), [CrossWatch #12](https://github.com/cenodude/CrossWatch/issues/12)). Store last-successful pull count per (syncId, provider, dataType) alongside the cursors and abort below a configurable fraction.
- Progress needs a policy decided once in `planProgressSync`, not per provider: newest `pausedAt` wins, never move backward without a newer timestamp, never overwrite a terminal watched state, and defer to the history data type above a near-complete cutoff. Competitor precedent for both halves: [JellyPlex-Watched #328](https://github.com/luigi311/JellyPlex-Watched/issues/328) (furthest-ahead instead of most-recent) and [PlexTraktSync #2196](https://github.com/Taxel/PlexTraktSync/issues/2196) (items trapped at 99.99%).
- Cursor design is the quiet failure mode. A stuck cursor produces a clean-looking report forever, so `SyncReport` needs a reason code separating "zero candidates because converged" from "zero candidates because cursor", plus a periodic reconciliation pass that ignores `syncs.cursors` and a `POST /api/syncs/:id/reset-cursor` route so recovery does not require DB access. Same pattern documented in [WatchState #831](https://github.com/arabcoders/watchstate/issues/831) and [WatchState #612](https://github.com/arabcoders/watchstate/issues/612).
- Failure isolation in `runSync` and `SyncRunner.execute` is a correctness issue, not just ergonomics: the forward direction, the back direction, and each data type share one try block, so a late throw discards delivery records for writes the target already accepted. Record deliveries and advance cursors per data type as each completes, and report partial rather than error.
- Traps to design against before the relevant features exist: Trakt removes a show from the watchlist when any episode is watched, so a watchlist cursor taken before a history push reads that as a user deletion ([Trakt API reference](https://jsapi.apiary.io/apis/trakt.apib)); two-way removal without changed-at arbitration produces the "unwatch keeps coming back" loop ([WatchState #78](https://github.com/arabcoders/watchstate/issues/78)); and an unbounded planner bug has real precedent in [scrob #82](https://github.com/ellite/scrob/issues/82).
- Already covered, dropped from the list: additive-only design prevents new-to-target items flipping the source to unwatched; ID-only never-by-title matching; no season/episode-number fallback; delivered checks keyed by external ID; failed or empty pull cannot drive deletions today; `watched_at` carried through verbatim from the source; 409 on scrobble treated as success; absence on source never unmarks the target; plan deduplicated by resolved identity; `notFound` is structurally inert; pagination already exhaustive on history pulls; history syncs for items the target does not hold; permissive provider response parsing; scheduler remains the sole authoritative trigger; no partial metadata signal can claim state; fan-out from one connection is cursor-isolated; Simkl `allow_rewatch` is never sent; planner emits no deletes; identity never depends on a mutable provider field.


## Data types and sync scope

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Per-sync media-type filter (movies / shows) | Syncs scope only by dataTypes, so a user who wants TV history synced cannot keep movies out. | no | 4 | 5 | M | 12 |
| Implement ratings sync | ratings is declared in DataType and provider capabilities but has no pull or push, so the capability model advertises a feature that does nothing. | partial | 5 | 4 | L | 12 |
| Timestamp provenance at the provider boundary | Confirm every watchedAt comes from the provider payload and reject offset-less strings, or history silently lands at the wrong instant. | partial | 4 | 4 | S | 12 |
| Explicit progress clear (null vs absent) | A reset resume point must push as a clear, not read as "nothing reported this run", or the stale position sticks forever. | no | 4 | 4 | S | 12 |
| Implement watchlist sync with a status map | watchlist is selectable today and does nothing, and Simkl hold/dropped have no Trakt equivalent so they need explicit mapping. | partial | 5 | 3 | L | 11 |
| Per-item exclusions and not-found skip list | No way to exclude a show from a sync and no memory of permanently unmatchable items, so failures repeat every run. | no | 4 | 4 | M | 11 |
| Rewatch / multiple plays | History collapses to one play per identity while Trakt and now Simkl both model repeat plays, so rewatch data is dropped every run. | no | 5 | 2 | XL | 10 |
| Per-item error isolation in a run | One unresolvable item (usually a special) should produce a single notFound, not abort the rest of the show or run. | partial | 3 | 4 | S | 10 |
| Specials / season-0 handling | Season-0 items need either an explicit episode mapping or an explicit skip toggle, otherwise they vanish or spam the report. | no | 3 | 4 | S | 10 |
| Progress authority rule | Two-way progress compares percentages only, so two devices can ping-pong small position differences each run. | partial | 3 | 4 | S | 10 |
| Minute-precision watched_at keys | Trakt zeroes seconds on watched_at, so any per-play key built on raw timestamps will never match what Trakt echoes back. | partial | 3 | 4 | S | 10 |
| Ratings write semantics | Ratings are update-not-additive: needs a precedence rule, a scale conversion table, season-level identity, and a no-op on equal values. | no | 4 | 3 | M | 9 |
| Per-direction, per-dataType config | direction and dataTypes are both sync-wide, so "history one way, progress both ways" cannot be expressed. | partial | 3 | 4 | M | 9 |
| Clamp progress to 0-100 | ProgressEvent.progress is an unvalidated number, so an off-spec provider value flows straight into the plan. | no | 2 | 5 | S | 9 |
| Simkl unknown-date sentinel | Simkl uses near-epoch timestamps to mean "watched, date unknown" and those pass through as a literal 1970 watch date. | no | 2 | 5 | S | 9 |
| Configurable watch thresholds | No floor or ceiling on what counts as a real play, so trivial partial plays sync identically to completions. | no | 3 | 4 | S | 9 |
| Tombstones before any removable type | Without a deleted-at marker, a deliberately removed rating or watchlist item is re-added on the next run. | no | 3 | 3 | M | 8 |
| Store the provider record id for progress | Trakt needs the playback entry id to clear a resume point, and pullProgress discards it today. | no | 3 | 3 | M | 8 |
| Missing or date-only watch dates | Decide and document what happens when a source gives no time or only a date, instead of an implicit midnight-UTC default. | no | 2 | 4 | S | 8 |
| Un-watch propagation | The most-discussed behavioural gap, but treating "absent from this pull" as unwatched risks mass false removals. | no | 3 | 3 | L | 7 |
| Trakt plan-limit reporting | Free-tier caps return 420 on writes, which must read as "blocked by your Trakt plan", not a retried failure. | no | 2 | 3 | S | 7 |
| Guards for numeric-progress providers | Any future count-based provider needs per-episode mapping, an episode-count clamp, and a fan-out ceiling. | no | 2 | 3 | S | 7 |
| Cross-catalog episode realignment | ID matching does not fix TVDB vs TMDB season splits, split-cour anime, or one-to-many episode mappings. | no | 3 | 2 | XL | 6 |
| Watchlist hygiene rules | Auto-remove watched items, age-based expiry, and an exclude-episodes option, all blocked on watchlist shipping first. | no | 3 | 2 | L | 6 |
| Trakt Favorites as its own type | /sync/favorites is a separate ranked list with its own activity cursor and no equivalent on the other providers. | no | 2 | 3 | M | 6 |
| Dropped-show state | Trakt models "dropped" with its own timestamp and no sync tool, including Watchbridge, carries it. | no | 2 | 3 | M | 6 |
| List sync (Trakt lists, MDBList) | An entirely new data model, but MDBList is list-native so the product fit is unusually good. | no | 3 | 2 | XL | 5 |
| Currently-watching / checkin | Trakt models a live auto-expiring watching state that a 60s-tick scheduler fits poorly. | no | 2 | 3 | L | 5 |
| Collection sync, or an explicit scope-out | Users assume "sync" covers their collection, so either model it or state in the docs that it is out of scope. | no | 2 | 2 | L | 4 |
| User-extensible ID spaces | The eight external id spaces are hardcoded, so adding one needs a code change. | no | 2 | 2 | L | 4 |
| Comments / notes sync | Trakt notes, Simkl memos, MDBList discussion; nobody ships this, so it is a differentiator rather than a gap. | no | 2 | 2 | XL | 3 |
| Opt-in fallback matcher | A normalized title+year fallback for items with no external id, opt-in per sync and never a default. | no | 1 | 1 | L | 1 |

### Notes

- The cheapest high-value cluster is all one schema change: a `filters` (or `mediaKinds` + `excludedRefs`) column on the `syncs` table, threaded into `planHistorySync`/`planProgressSync` as a pre-diff predicate, plus controls in `Syncs.tsx`. Media-type scoping, per-item exclusions, and the specials skip toggle all land on that one hook. Filtering also shrinks batch sizes against Simkl's 1 POST/sec write cap. Demand is documented: [aiometadata #572](https://github.com/cedya77/aiometadata/issues/572), and a MediaPortal user had ~6,000 episodes wrongly pushed when a plugin ignored its own exclusions ([thread](https://forum.team-mediaportal.com/threads/help-thousand-of-episodes-wrongly-sent-to-trakt.130560/)).
- Ratings and watchlist are the two declared-but-unbuilt types, and both fail if built with history's additive logic. Ratings are update semantics (a re-write of an equal value must be a no-op, since PlexTraktSync reset a decade of rating dates that way), need a normalized 0-10 internal scale with conversion only at the provider edge (a 0-100 source collapsing to all 1s is a real shipped bug, [TraktRater #42](https://github.com/damienhaynes/TraktRater/issues/42)), and need season as a rateable identity from the start rather than a later match-key migration. Neither type carries a timestamp, so "newest wins" does not apply and an explicit authoritative-source setting is required ([watchstate #786](https://github.com/arabcoders/watchstate/discussions/786)); removal needs a tombstone or deletions bounce back. Endpoint shapes: [Trakt](https://jsapi.apiary.io/apis/trakt.apib), [MDBList](https://api.mdblist.com/schema/).
- Rewatch is the largest single data-model gap and it got more visible, not less: Trakt has always supported multiple plays and Simkl shipped first-class rewatch sessions with rewatch_id/rewatch_status ([guide](https://api.simkl.org/guides/rewatches.md)), with a still-open request on a comparable tool ([CrossWatch #363](https://github.com/cenodude/CrossWatch/issues/363)). One agent argued the current one-play model is a fair simplification because the other providers cannot represent repeat plays; that was true before the Simkl launch and is now only true for PMDB and MDBList. If it is built, the dedupe key must be minute-truncated because Trakt zeroes seconds on watched_at ([discussion #694](https://github.com/trakt/trakt-api/discussions/694)), and collapse should use a time window rather than exact equality.
- Timestamp handling is the highest-scoring correctness cluster and it is small work: a shared `parseProviderTimestamp()` used by all four clients, plus an audit that no WatchEvent/ProgressEvent timestamp is ever built from `new Date()`. A nightly export where every entry shares the scheduler's own run time is the classic tell. Separately, Simkl deliberately sends near-epoch dates to mean "watched, date unknown" ([conventions](https://api.simkl.org/conventions/dates.md)), so anything before 2000-01-01 should normalize to null rather than render or push as a 1970 watch.
- Two items are product-behaviour decisions and should be confirmed with Ibby before any implementation, not chosen autonomously: the fallback when a source has no time or only a date (UTC midnight, noon, user timezone, or skip), and the default for un-watch propagation. Un-watch in particular needs a full, successful, non-empty source snapshot compared against the deliveries table before any removal is issued, and should be opt-in per sync.
- Per-direction and per-dataType configuration is the established shape in this space ([PlexTraktSync config.default.yml](https://github.com/Taxel/PlexTraktSync/blob/main/plextraktsync/config.default.yml)); today users work around it with two one-way syncs, which double-processes shared item state. If the full split is too much, the minimum is warning copy in the sync form about which side wins under two_way.
- Season-0 handling is worth doing before anime-adjacent syncs grow: PlexAniSync's hard exclusion of season 0 drove users to binary-patch running containers ([#230](https://github.com/RickDB/PlexAniSync/issues/230)), and an unhandled specials entry there stopped a whole show from syncing. Per-item try/catch in `runSync` plus an explicit specials toggle turns both failure modes into one quiet skip.
- Trakt's 2026 caps ([forum](https://forums.trakt.tv/t/updating-trakt-limits-for-2026/101592)) touch several future items at once: watchlist writes return 420 when full, lists are capped at 5, and collection has its own ceiling. Whenever those types ship, 420 needs to surface as a named plan-limit skip rather than a retried failure.
- List, collection, favorites, checkin, and notes sync are all real requests but each is a new data model on top of a type system that has no list concept at all. The only near-term action worth taking is a docs line stating that collection and lists are out of scope, since users otherwise assume "sync" includes them.

Already covered (dropped): per-sync dataTypes already provides the scrobble-type filtering competitors expose; delivery memory lives in Postgres/PGlite rather than a hand-rolled JSON backlog file, avoiding that corruption class (worth confirming a unique index on (syncId, itemKey)); Trakt's ~6-month playback auto-expiry is harmless under the current additive progress design.

## Providers and integrations

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Fix Trakt pagination gaps before mandatory 2026 enforcement | `pageAll()` already loops correctly for history, but `pullProgress` and any flat-limit call (e.g. `/sync/playback`) don't, and Trakt is making pagination mandatory and cutting page size to 250 through mid-2026. | partial | 5 | 5 | S | 15 |
| Classify push responses: accepted / permanently-rejected / transient | Branch on status in Trakt/Simkl push methods so 409 (already-scrobbled) counts as success and 404 counts as a non-retryable miss, instead of one generic failed bucket. | no | 4 | 5 | S | 13 |
| Enforce a global per-provider rate ceiling and use batch writes | Add a process-wide token bucket sized to each provider's documented limits (Trakt: 1 write/sec, 1000 GET/5min) and route through bulk endpoints instead of per-item fan-out; the existing ConcurrencyLimiter only caps concurrent sync jobs, not outbound calls. | partial | 5 | 4 | M | 13 |
| Circuit-break on HTTP 423 (provider has blocked the app) | Trip on 423 (or repeated failed-refresh 401s), flip the connection to a new "blocked" status, and require explicit user re-enable instead of continuing to hammer a provider that already said stop. | partial | 5 | 4 | M | 13 |
| Fix Simkl anime season/episode mapping | Set `use_tvdb_anime_seasons` for TVDB-numbered anime and send per-episode anidb/tvdb ids where available; current whole-show/season-number-only pushes are the likely cause of the open bug where Simkl re-adds all episodes every run. | no | 5 | 3 | M | 12 |
| Handle Trakt HTTP 420 as a distinct, human-readable, non-fatal outcome | 420 (account/plan limit) is not a rate limit and must not crash a batch or surface as a raw HTTP error; map it to a permanent per-item result with an actionable message, and expect it to become routine once Trakt's 2026 free-tier caps bite. | no | 4 | 4 | S | 12 |
| Extend MDBList to a full 4-datatype provider | MDBList's `/sync/ratings`, `/watchlist/items`, `/sync/collection`, `/sync/dropped` use the same ID envelope Watchbridge already parses for Trakt, making this the cheapest provider extension available. | partial | 4 | 5 | M | 12 |
| Assert pulled item count matches the provider's reported total | Log "pulled N of M" per page and flag a mismatch as a run warning, so a pagination bug can't silently truncate history/progress indefinitely with nothing in the logs to reveal it. | no | 4 | 4 | M | 11 |
| Validate every provider response through a schema at the adapter boundary | Add zod schemas per provider so a malformed 200 (an unexpected null field, a shape change) degrades one item to failed instead of crashing the whole run. | no | 4 | 4 | M | 11 |
| Add MyAnimeList / AniList (and AniDB / Kitsu) as sync providers | Watchbridge already carries mal/anilist/anidb in its ID union and matches on them, ahead of every competitor studied; this is the single biggest unbuilt opportunity in the research. | partial | 5 | 3 | XL | 10 |
| Add media-server providers, Jellyfin first, then Plex/Emby | Watchbridge covers zero media servers today, and three actively-maintained OSS projects exist specifically to fill this gap; it's the largest single capability gap identified. | no | 5 | 3 | XL | 10 |
| Treat partial failure mid-pagination as fatal, not silent truncation | A rate-limit blip during a large paginated pull should raise, not quietly return an incomplete list that the planner accepts as complete. | no | 3 | 4 | S | 10 |
| Serialize Trakt refresh-token rotation per connection | Each sync run builds a fresh TraktClient with its own in-memory token state; two concurrent syncs sharing one Trakt connection can race a single-use refresh token and lock each other out. | partial | 4 | 3 | M | 10 |
| Retry a not-found ID lookup with the next available ID type | Fall through a documented priority order (imdb→tmdb→tvdb→trakt/simkl) on a 404 and record which ids were tried, since a target simply not resolving a valid ID is routine, not a bug. | partial | 3 | 4 | S | 10 |
| Named, unit-labeled per-provider timeout/backoff config | Name timeout fields explicitly (e.g. `requestTimeoutMs`), validate ranges at load, and log effective values at startup so a configured timeout can't silently do nothing. | no | 3 | 4 | M | 9 |
| Publish a per-provider limitations/FAQ page | Document Simkl's stateful activities cursor, Trakt's required User-Agent, MDBList's quotas, and PMDB specifics up front instead of leaving them as internal notes. | no | 2 | 5 | S | 9 |
| Give Plex the same PIN/device-code auth UX as Trakt/Simkl | Reuse the existing device-code/PIN pattern for Plex's PIN-based flow instead of manual `X-Plex-Token` extraction, the worst-reviewed setup step among competitors. | partial | 3 | 4 | M | 9 |
| Add a generic inbound webhook endpoint | One authenticated `POST /api/webhooks/:apikey` route feeding SyncRunner as a new trigger type, since sync is currently poll-only up to `intervalMinutes` staleness. | no | 4 | 3 | L | 9 |
| Re-verify the Simkl client against the new OpenAPI 3.1 spec | Simkl's 2026 docs rewrite found "significant drift" from the live API and the old Apiary spec retires in October 2026; diff the current client against `api.simkl.org/openapi.json`. | partial | 2 | 5 | S | 9 |
| Surface per-provider capability ceilings in the UI | `ProviderCapabilities` already models things like `datedHistory`; extend it to cover hard ceilings (Simkl's list/comment endpoints are still [IN DEV]) and render them before a sync runs, not after data loss. | partial | 3 | 4 | M | 9 |
| Parse `Retry-After` as a duration, never a compared wall-clock timestamp | Comparing an absolute reset time against local time breaks across DST changes; always back off by the duration the header gives. | no | 2 | 5 | S | 9 |
| Document and stabilize the provider plugin contract | `SyncSource`/`SyncTarget`/`ProviderCapabilities` already form a clean typed contract; write it up as a stable extension point so new-tracker requests (a constant stream in this category) don't each require bespoke core work. | partial | 3 | 4 | M | 9 |
| Check status/content-type before JSON-parsing a provider response | An outage, proxy, or Cloudflare challenge page returned as HTML should throw a clear "unexpected content type" error, not a confusing JSON parse failure. | no | 2 | 4 | S | 8 |
| Let users bring their own Trakt/Simkl client id + secret per connection | A shared app credential can be throttled or suspended for every self-hoster at once; make the app-wide client id/secret an override-able default. | no | 3 | 3 | M | 8 |
| Capture Trakt's history action field for provenance | Trakt tags history items as scrobble/checkin/manual; storing it lets a future feature avoid re-pushing manually-backfilled entries or filter on it. | no | 2 | 4 | S | 8 |
| Keep the provider abstraction modular before a 5th/6th provider hardens it | Review `ProviderCapabilities`/`HttpClient` for cloud-API-only assumptions (no notion of a self-hosted base URL) before they become load-bearing for more providers. | no | 2 | 3 | S | 7 |
| Design a per-server multi-user identity model before adding any media server | Today's connection model is one app account = one set of provider connections; media servers are inherently multi-user, and retrofitting this after Jellyfin/Plex ship means a painful migration. | no | 4 | 2 | XL | 7 |
| Add a session-polling "Watcher" as a Plex-Pass/Emby-Premiere-free realtime path | Poll the sessions API directly with tunable thresholds instead of relying on paid-tier webhooks for near-real-time updates. | no | 3 | 3 | L | 7 |
| Add a generic CSV/JSON personal-data import | Let users import from an unsupported service (Netflix, MovieLens, filmweb) by uploading a file with a required ID column, rejecting rows with no recognized external id rather than falling back to title matching. | no | 3 | 3 | L | 7 |
| Letterboxd: one-way file import only, never a live two-way connection | Letterboxd's API is invite-only and its exports carry no TMDb/IMDb ids, so a live connection isn't realistic; scope to CSV import with ID resolution as an explicit opt-in step. | no | 3 | 1 | XL | 6 |
| Model user-mapping as one-to-many pairs, not a single-value dict | A hashtable-keyed mapping silently drops all but the last entry when one source user maps to multiple target users, a real household topology. | no | 2 | 3 | M | 6 |
| Add a Stremio addon as a live scrobble/ingest source | A standalone addon posting watch/progress events into the existing WatchEvent pipeline would give Watchbridge a live ingest source without needing a media server. | no | 3 | 2 | L | 6 |
| Design around Trakt's 2026 list/collection caps before building list sync | Trakt splits collection into a 1,000-item first-party-only library and a 100-item third-party ceiling, plus tightened list/rating caps; any future list/collection feature needs to design to the 100-item ceiling and surface it, not discover it via a 420. | no | 2 | 2 | M | 6 |
| Support multiple connections of the same provider type | Users expect to bridge two servers of the same kind (Plex-to-Plex, Jellyfin-to-Jellyfin); verify whether syncs reference a provider type or a specific connection id. | no | 2 | 3 | L | 5 |
| Prototype a Trakt-compatible read/scrobble API surface | Implementing a Trakt-shaped subset (`sync/watched`, `scrobble`) would let the large existing Kodi/mpv/Stremio/mobile Trakt-client ecosystem point at Watchbridge with just a base-URL change; high leverage but high execution risk, scope as its own project. | no | 3 | 2 | XL | 5 |

### Notes

- Trakt pagination — **resolved, and the dates are now pinned.** The earlier "June 30 2026" framing
  was wrong; there is no such deadline. Verified from
  [discussion #681](https://github.com/trakt/trakt-api/discussions/681), the rollout was four
  milestones, **all of which are already in the past**: mid-Feb 2026 (list items paginated, 1,000
  max), end of Feb 2026 (collection paginated), **15 April 2026** (default page size drops to 100,
  and to 10 for watchlist and favorites), **15 June 2026** (maximum page size drops from 1,000 to
  250). Watchbridge complies: `pageAll` loops, always sends an explicit `page` and `limit=100`
  (inside the 250 cap, and immune to the default-size change), and `pullProgress` now goes through
  it too. See also [#775](https://github.com/trakt/trakt-api/discussions/775).
- Simkl anime numbering: `pushHistory` groups episodes by season/number with no `use_tvdb_anime_seasons` flag and no per-episode ids block — very likely the direct cause of the already-open bug where Simkl writes re-add all episodes every run for anime. Fix both: set the flag for TVDB-numbered anime, and send per-episode anidb/tvdb ids where the source has them. [Simkl API ref](https://api.simkl.org/api-reference/simkl/add-to-history.md), [CrossWatch #394](https://github.com/cenodude/CrossWatch/issues/394), [jellyfin-plugin-simkl #23](https://github.com/jellyfin/jellyfin-plugin-simkl/issues/23)
- HTTP status semantics belong in one mapping: 409 = already-in-that-state (skip, never retry), 420 = permanent account/plan limit, 423 = provider has blocked the app (circuit-break), 429/5xx = backoff and retry. Skipping this is exactly how jellyfin-plugin-trakt ended up retrying a 409 and clobbering a user's resume position. [jellyfin-plugin-trakt #289](https://github.com/jellyfin/jellyfin-plugin-trakt/issues/289), [discussion #350](https://github.com/trakt/trakt-api/discussions/350)
- Refresh-token race: `ConnectionService` builds a fresh `TraktClient` per call with no shared lock, so two concurrent syncs on the same Trakt connection can both refresh near expiry and the second reuses an already-rotated (single-use) refresh token, locking the connection out. Add a per-connection lock around the refresh path. [discussion #495](https://github.com/trakt/trakt-api/discussions/495)
- Anime tracker providers: start with AniList (public GraphQL, straightforward OAuth) before MAL (needs OAuth app approval) or AniDB (UDP API, strict ban policies) — the ID plumbing (mal/anilist/anidb) already exists, only the client is missing. [MALSync #192](https://github.com/MALSync/MALSync/issues/192), [AniList rate limiting](https://docs.anilist.co/guide/rate-limiting)
- Media-server support carries a cluster of prerequisite decisions that need answering during that build, not after: a per-server multi-user identity model (one-to-many, not a dict), Jellyfin's per-user UserData route ignoring the `userId` param (write via legacy per-user routes and read back to verify), Plex Home vs shared/friend tokens having different capabilities, Jellyfin username:password-to-token exchange or Quick Connect instead of storing raw credentials, probing server version/edition at connect time (progress needs Jellyfin 10.9+, webhooks need Plex Pass/Emby Premiere), and never silently dropping an unrecognized library type. [WatchState identities guide](https://github.com/arabcoders/watchstate/blob/master/guides/identities.md), [jellyfin/jellyfin #15733](https://github.com/jellyfin/jellyfin/issues/15733), [JellyPlex-Watched #354](https://github.com/luigi311/JellyPlex-Watched/issues/354)
- Letterboxd has no self-serve API (invite-only beta) and its exports carry no TMDb/IMDb ids — the only honest scope is one-way CSV import with ID resolution as an explicit opt-in step, never automatic title matching (a Letterboxd title/year mismatch has already caused a confirmed silent mis-import elsewhere). [export post-mortem](https://www.feadin.eu/en/posts/letterboxd_i_love_you_but_we_need_to_talk_about_your_exports/), [letterboxd-trakt-sync #4](https://github.com/f0e/letterboxd-trakt-sync/issues/4)
- Rate limiting needs two layers together: a per-provider token bucket sized to documented limits (Trakt: 1 write/sec, 1000 GET/5min) shared process-wide, and batch endpoints instead of per-item writes — Trakt staff have specifically named per-item write fan-out as the pattern behind past API-key revocations.

Already covered in Watchbridge: anime ID matching via mal/anilist/anidb, Trakt OAuth refresh already keying off `expires_in`, Simkl support alongside Trakt/PMDB/MDBList, all four providers being typed REST clients with no HTML scraping, outbound requests already setting a real User-Agent and following redirects, Trakt push never calling the destructive `/scrobble/start`, `positionFromRuntime` already guarding null/zero/ambiguous-unit runtime bugs, Trakt history pull already paginating via `pageAll` (a regression test is worth adding), and MDBList pagination already handling `has_more`/offset correctly.


## Scheduling and performance

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Per-method request pacing (GET vs write) in HttpClient | One flat `minIntervalMs` (Trakt 350ms, Simkl 300ms) applies to every method, so consecutive POSTs run ~3x over the 1 write/sec both APIs document. | partial | 4 | 5 | S | 13 |
| Write-volume circuit breaker on the shared client_id | Nothing caps abnormal write volume per run or per user, so one runaway sync can get the app-wide Trakt/Simkl client_id throttled or locked for everyone. | partial | 5 | 3 | M | 12 |
| Floor the Retry-After backoff at 1s | `backoff()` has no minimum, so a `Retry-After: 0` turns rate-limit exhaustion into an instant retry burst. | no | 3 | 5 | S | 11 |
| Trakt history delta cursor via /sync/last_activities | `pullHistory(_since)` ignores its cursor and Trakt has no `lastActivityAll`, so every eligible tick re-pulls the entire history. | no | 4 | 4 | M | 11 |
| Threshold-switched full reconciliation | One planner path with no periodic or over-threshold full compare means a drifted delta cursor never self-heals. | no | 4 | 4 | M | 11 |
| Per-provider page-size tuning | `pageAll` uses a flat `limit = 100` everywhere, multiplying calls on first-run backfills. | partial | 3 | 5 | S | 11 |
| MDBList batching and daily-budget visibility | Free tier is 1,000 req/day; per-item writes exhaust it mid-run with no remaining-budget signal in the report. | no | 3 | 5 | S | 11 |
| Scheduled export job type | The scheduler already ticks for syncs; a second job kind gives scheduled backups without new infra. | partial | 3 | 5 | S | 11 |
| Configurable per-provider rate and concurrency ceilings | `minIntervalMs` is hardcoded per client with no documented or tunable ceiling, and nothing bounds burst across client instances. | partial | 3 | 4 | M | 10 |
| Authenticated inbound webhook to trigger a run | `POST /api/syncs/:id/run` needs a session cookie, so no external automation can trigger a run without scripting around auth. | partial | 3 | 4 | S | 10 |
| AniList and MAL rate handling for future clients | AniList's limit must be read live from `X-RateLimit-*`; MAL publishes none and needs a fixed ~1 req/s client-side bucket. | partial | 3 | 4 | S | 10 |
| Per-connection write serialization for Simkl | Simkl holds a 20s per-user write lock; two syncs targeting the same Simkl connection can collide and get `400 rate_limit`. | no | 3 | 4 | M | 9 |
| Incremental progress pulls | `pullProgress()` takes no `since`, so the full playback collection is re-pulled and re-diffed every tick despite `syncs.cursors` already existing. | partial | 3 | 4 | M | 9 |
| Durable, cancellable run state | No heartbeat, orphan sweep, or cancel, so a killed or hung run stays `running` forever with no UI recovery. | partial | 4 | 3 | L | 9 |
| Resumable checkpointing mid-run | Run outcomes are assembled at completion, so a run that dies at 90% re-burns the whole API budget on retry. | partial | 4 | 3 | L | 9 |
| Bounded memory for large histories | `MatchIndex` plus both full item arrays are materialized in-process, sharing memory with embedded PGlite. | no | 4 | 3 | L | 9 |
| Cursor pagination for new MDBList reads | MDBList deprecated offset/page paging in favour of `next_cursor` on sync-read endpoints. | no | 2 | 5 | S | 9 |
| Simkl per-type delta gating | Only the top-level `all` activities timestamp is compared, so unrelated ratings activity forces a three-bucket re-fetch. | partial | 2 | 4 | S | 8 |
| Source-pull cache with per-endpoint TTL | Every run re-fetches full state, and a provider 500 reads as "nothing to sync" rather than "source unavailable". | no | 3 | 3 | M | 8 |
| Throttled Simkl removal detection | Removal detection needs an unfiltered full refetch, which is exactly what gets client_ids suspended on a 60s tick. | partial | 3 | 3 | M | 8 |
| Change-detected ordering writes | Any future ordering feature must diff positions rather than re-assert order every run, as the deliveries table already does for membership. | partial | 2 | 4 | S | 8 |
| Batched-write capability flag | A `batched` provider capability trades atomicity for rate headroom, but `PushResult` has no partial-batch-failure semantics. | no | 2 | 3 | M | 6 |
| Event-driven per-item sync | Sub-60s reaction needs a player or media-server event source that does not exist yet. | no | 2 | 2 | L | 4 |

### Notes

- The two highest-scoring items share one file. `HttpClient` keeps a single `lastAt`/`minIntervalMs` pair in `pace()`, so adding a second timestamp bucket keyed on method (or a `minIntervalMsByMethod` option) fixes Trakt and Simkl write pacing in one diff. The cheap interim fix is raising the shared interval to 1000ms, at the cost of slower GET-heavy pulls.
- `backoff()` currently returns `Math.min(secs * 1000, maxBackoffMs)` straight from the `Retry-After` header with no floor. Trakt is documented to send `Retry-After: 0` on some 429s, which drains `maxRetries` in milliseconds. Clamp to at least 1000ms. See [trakt rate limiting](https://docs.trakt.tv/reference/rate-limiting) and [PlexTraktSync #2281](https://github.com/Taxel/PlexTraktSync/issues/2281).
- Outbound concurrency is already bounded, but only per client instance: `HttpClient.request()` serializes every call through a promise chain, so one connection never issues parallel requests. The real exposure is many connections and many users sharing one app-level `client_id`, which is what the circuit breaker item covers, not a per-client concurrency cap. Precedent for the shared-credential failure: [jellyfin-plugin-trakt #226](https://github.com/jellyfin/jellyfin-plugin-trakt/issues/226).
- A per-run write cap must be enforced after the diff, capping new writes rather than "first N source items read". Radarr capped reads and wasted the budget on already-synced items ([Radarr #7289](https://github.com/Radarr/Radarr/issues/7289)).
- Delta-cursor coverage is uneven and it is the same plumbing three times: Trakt history ignores its `since` argument entirely, `pullProgress()` has no `since` parameter in the `SyncSource` interface, and Simkl gates on the top-level `all` timestamp instead of the per-type sub-buckets already present in the same `/sync/activities` response. Trakt's documented trap: pin to `episodes.watched_at`/`movies.watched_at`, not `last_updated_at` on `/sync/watched/shows` ([trakt-api #876](https://github.com/trakt/trakt-api/issues/876), [Simkl sync guide](https://api.simkl.org/guides/sync.md)).
- Correctness trap on caching and full reconciliation: an empty or truncated source pull must never be treated as "nothing to sync". Pair the source cache with a fallback that reuses the last good pull and warns, and gate the full-compare path on a changed-item threshold so it doubles as cursor self-healing ([WatchState two-way sync](https://github.com/arabcoders/watchstate/blob/master/guides/two-way-sync.md), [Kometa settings](https://github.com/Kometa-Team/Kometa/blob/master/docs/files/settings.md)).
- The three L-effort items (durable run state, checkpointing, bounded memory) all want the same foundation: a heartbeat column on `syncRuns`, incremental report writes, a startup sweep for stale `running` rows, and a cancel path. Build it once as a small job abstraction so a future backup, restore, or import endpoint does not run inline and 504 behind the reverse proxy ([watchstate #833](https://github.com/arabcoders/watchstate/issues/833), [jellyfin #15041](https://github.com/jellyfin/jellyfin/issues/15041)).
- Simkl's separate 20s per-user write lock is a distinct failure from its request-rate caps. Serializing syncs that share a target connection id needs a per-connection queue, not a bigger interval, since the collision happens across sync runs rather than within one client.

**Already covered (dropped):** rate-limit backoff honouring `Retry-After` on 429/5xx plus `slow_down` device-code polling; proactive write pacing for Trakt; single-flight per sync id (the `inFlight` Set in `scheduler.ts` guards both the scheduled tick and manual `runNow`, so overlap is already impossible); safe Trakt history pagination (explicit `page`/`limit`, loops until a short page, never relies on server defaults); progress-only syncs at a short interval (per-sync `dataTypes` and `intervalMinutes` are independent columns already); flexible refresh cadence versus tiered competitors. Seven items were dropped as already implemented and ten near-duplicates were merged into the rows above.


## Interface and user experience

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| OAuth token expiry warning | Surface `connections.status`/`lastValidatedAt` as a health badge and email users before a token goes stale, instead of syncs failing silently for weeks. | partial | 5 | 5 | M | 14 |
| Explicit backfill choice at sync creation | Ask "full history vs. from now" when a sync is first created and persist the cutoff in `syncs.cursors`, instead of every sync silently doing a full pull. | partial | 4 | 5 | S | 13 |
| Last-run status badge per sync | Show `lastRunAt` + last-run status on each sync card in Syncs.tsx so a failing sync is visible without opening run history. | partial | 4 | 5 | S | 13 |
| Playback Progress management page | Add a page listing stored resume points across all connected providers with search/remove/mark-watched — a feature every close competitor (CrossWatch) has and Watchbridge lacks entirely. | no | 5 | 3 | L | 11 |
| Mandatory preview before a sync's first live run | Force the existing preview/dry-run endpoint before a brand-new sync's first real write, so a freshly connected provider with different timestamps can't steamroll existing history. | partial | 4 | 4 | M | 11 |
| Per-item run report detail | Extend `DataTypeReport` to carry sampled item titles/reasons for unmatched/notFound/failed, not just aggregate counts, so users can act on a run report instead of guessing. | partial | 4 | 4 | M | 11 |
| Human-readable provider error translation | Map Trakt/Simkl status codes (420, 426, Cloudflare 403/HTML body) to plain-language messages before they hit `SyncRun.error`, per the project's own human-readable-errors rule. | no | 4 | 4 | M | 11 |
| Surface the additive/no-unwatch-propagation guarantee | Add inline copy in the sync editor and a count line in run reports explaining that un-watching a source item is never mirrored — the single most-repeated complaint across every competitor tracker surveyed. | partial | 3 | 5 | S | 11 |
| Per-item exclusion / privacy list | Let users exclude specific titles from ever syncing (shared-account privacy, chronic mismatches), with a warning at add-time and search/pagination once the list grows. | no | 4 | 3 | M | 10 |
| In-app "what did this resolve to" lookup | A simple title/ID search page showing how each provider resolved an item, so users can self-diagnose a mismatch instead of filing a support request. | no | 4 | 3 | M | 10 |
| Cheap mitigations for the rewatch limitation | Never mark an item "watched" if the target already has any play for it, and let progress sync even when the target already shows watched — the most-recurring feature request across every tracker surveyed. | no | 4 | 3 | M | 10 |
| Restore-preview: diff a snapshot against the live account | Reuse the existing plan/preview machinery to show "what's in my backup that's no longer in my account" — no surveyed competitor offers this; genuine differentiator. | no | 4 | 3 | L | 9 |
| Local browsable/searchable history & progress view | A page over stored delivery/run data with title/date search, doubling as proof a sync or backup actually captured what's expected. | no | 4 | 4 | M | 9 |
| Run one data type, not the whole sync | Let a manual run/preview target a single data type via an override param, instead of forcing a full re-run to debug one broken type. | no | 3 | 4 | M | 9 |
| Browsable pending-queue UI | List/retry/purge whatever's still owed to a target once a retry queue exists, instead of failed items being invisible. | no | 3 | 4 | M | 9 |
| Preview shows the actual delta, not just counts | Extend preview to carry the real list of items that would change, not just "12 would be added," so users can actually verify before enabling a sync. | partial | 3 | 4 | M | 9 |
| Live-refresh the Syncs page after background runs | Poll or refetch syncs/runs periodically so a tab left open across a scheduled run doesn't show stale state and prompt a duplicate manual run. | partial | 3 | 4 | M | 9 |
| Per-data-type direction + per-type preview | Let each entry in `syncs.dataTypes` carry its own effective direction (not one global direction for the whole sync), with preview counts broken out per type. | partial | 3 | 4 | M | 9 |
| Warn about Simkl's native Trakt auto-import conflict | Note in the Trakt→Simkl connection flow that Simkl's own auto-import should be disabled to avoid two independent writers double-syncing. | no | 2 | 5 | S | 9 |
| Document capabilities Watchbridge already has | Add copy/docs covering composable sync topologies (mirror, hub-and-spoke), the existing duplicate-prevention via delivery-memory, and that Watchbridge already does the scheduled two-way sync Trakt/Simkl's own importers refuse to do. | partial | 2 | 5 | S | 9 |
| Show per-run duration | Compute `finishedAt - startedAt` in the run-history list — pure display, no backend change needed. | no | 2 | 5 | S | 9 |
| Scoped bulk-removal control | A Trakt-style scoped delete ("remove what this sync wrote," filterable by data type/media type/date range) with an explicit confirmation, for widespread bad writes. | no | 3 | 3 | M | 8 |
| Per-connection read-only toggle | A `readOnly` flag on the connection itself as a safety rail on top of per-sync direction, so a connection can never be written to regardless of any sync's setting. | partial | 2 | 4 | S | 8 |
| Per-user timezone display setting | Store a timezone preference and apply it when rendering watched/run timestamps, so users far from UTC don't see dates shifted by a day. | no | 2 | 4 | S | 8 |
| Actionable review queue for run outcomes | Let a user retry/correct a specific failed or wrong item from run history instead of only reading a JSON report. | partial | 3 | 3 | L | 7 |
| Persisted per-item correction overrides | Let a user pin a corrected ID/season/episode for a mismatched item, consulted before automatic matching on every future run. | no | 3 | 3 | L | 7 |
| Deep-link synced items to source and target | Once any per-item view exists, link each row out to the item on both provider sites using known URL schemes. | no | 2 | 4 | M | 7 |
| Distinguish new vs. known unmatched items | Track previously-seen unmatched item keys so the run report shows "N new unmatched" separately from "N known, unchanged" instead of an unchanging count users learn to ignore. | partial | 2 | 4 | M | 7 |
| Document Trakt's free-tier 1-app limit | Note at connect time that free Trakt accounts allow only one third-party app, so a failed connect doesn't read as a Watchbridge bug. | no | 1 | 5 | S | 7 |
| Label one-way syncs as "mirror" | Rename "one-way" to "mirror" with a short tooltip in the sync editor — copy-only change, sets the right expectation. | partial | 1 | 5 | S | 7 |
| Surface entitlement/tier-limit rejections in plain language | When a target rejects a write for account-tier reasons, say so in the run report instead of counting it as a generic failure. | no | 2 | 3 | M | 6 |
| Match-confidence + bulk-accept in preview | Score how many ID types matched per item and let users bulk-accept only above a threshold. | partial | 2 | 3 | M | 6 |
| Skip specials/season-0 toggle | A per-sync option to filter out season-0 episodes, which have inconsistent numbering across tmdb/tvdb/imdb. | no | 1 | 4 | S | 6 |
| "Playing now" live overlay | Deferred: Watchbridge is a scheduled poll sync with no watcher/webhook concept, so a live "paused just now" overlay has no foundation to build on until the Progress page ships. | no | 1 | 2 | M | 3 |
| "Currently watching" presence | Lowest-value item surveyed; arguably out of scope for a sync service since it needs a live signal Watchbridge doesn't ingest. | no | 1 | 2 | L | 2 |

### Notes

- The additive-only / no-unwatch-propagation behavior is real and already shipped (`planHistorySync`/`planProgressSync` in `packages/core/src/sync/plan.ts`), it just isn't explained anywhere in `packages/web/src/pages/Syncs.tsx`. This is the single most-repeated complaint across the whole competitive set ([RileyXX/IMDB-Trakt-Syncer#77](https://github.com/RileyXX/IMDB-Trakt-Syncer/issues/77), [Trakt forums](https://forums.trakt.tv/t/how-to-sync-deleted-items-from-watch-history/112569)) — the fix here is copy, not code.
- Mandatory first-run preview matters because a freshly connected provider with newer timestamps can overwrite correct history on its very first run; WatchState documents exactly this failure (6/6 watched flipped to unwatched). Watchbridge already has the dry-run mechanism (`POST /api/syncs/:id/preview`) that WatchState lacks — just gate the first real run behind it.
- Per-item run report detail and the "distinguish new vs. known unmatched" item are related but separate: the first is about naming which items failed and why on a given run; the second is about not re-flagging the same permanently-unmatched items forever. Both stem from `DataTypeReport` in `packages/core/src/sync/engine.ts` being count-only today.
- The exclusion list is the most cross-referenced unmet feature in the category (universal-trakt-scrobbler, librarySync, PlexTraktSync all raise it — [example](https://github.com/willtho89/librarySync/issues/68)). Build it with search/pagination from day one; Radarr/Sonarr users report exclusion lists becoming unusable once they hit hundreds of entries with no search.
- HTTP error translation directly conflicts with the project's own human-readable-errors rule today: `HttpError` in `packages/core/src/providers/http.ts` just carries a raw status + body, and nothing maps Trakt's 420 (account limit) or 426 (VIP-only) to a sentence a user can act on ([Trakt VIP methods](https://docs.trakt.tv/docs/vip-methods)).
- The Playback Progress page and the local browsable history view are the two biggest structural gaps: Watchbridge has no per-item browsing surface anywhere in `packages/web/src/pages/`, while three separate competitor codebases (CrossWatch chief among them) treat this as a baseline feature for the exact providers Watchbridge already integrates.
- Restore-preview (diff a snapshot against the live account) is worth calling out as a genuine differentiator, not table stakes — no surveyed tool (Trakt, Simkl, WatchState, CrossWatch, TraktRater) offers it, and Watchbridge is unusually well positioned since it already normalizes both sides to external-ID refs.
- Two items were deliberately left out of the main table as forward-looking design constraints rather than buildable tickets today: keep any future deletion-propagation flag fully separate from `syncs.direction` (PlexTraktSync users confused a single flag doing both — [issue](https://github.com/Taxel/PlexTraktSync/issues/1872)), and require explicit confirm + dry-run on any future destructive action.
- Also excluded as not currently applicable: MDBList list-aggregation staleness (Watchbridge only calls MDBList's live `/sync/watched` and `/sync/playback` endpoints, not its list feature), public/private list-visibility preconditions (no visibility-gated data source exists), and opt-in crowd-sourced correction sharing (only relevant if Watchbridge ever adds fuzzy matching — it's ID-only today).


## Observability and operations

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Per-item run detail: labels, reasons, browsable, downloadable | Run reports only carry aggregate added/skipped/failed/notFound counts; extend to per-item title/reason with a searchable run-detail view, CSV export, and a force-run debug dump. | partial | 5 | 4 | M | 14 |
| Notification/alerting system (webhook, Discord, ntfy, Apprise) | Watchbridge has zero notification mechanism; add transition-based alerts (not per-error spam) for run failures, connection reauth/error, and recovery, with a documented generic webhook plus Discord/ntfy/Apprise channels, real auth fields, and per-event opt-in. | no | 5 | 4 | L | 13 |
| Dead/expired connection detection, reconnect banner, out-of-band alert | `connections.status` already models active/reauth/error and the UI could show it, but nothing ever calls `ConnectionStore.setStatus()` on a refresh failure, so a dead token silently stays "active" forever. | partial | 5 | 4 | M | 13 |
| Match health diagnostics (taxonomy + cross-run view + inspect tool) | ID-matching failures only surface as an aggregate notFound/unmatched count; add a named taxonomy (duplicate id, weak match, no strong id), a cross-run health view, and a per-item inspect endpoint. | partial | 5 | 3 | L | 11 |
| Rate-limit / throttle visibility as a distinct run outcome | `HttpClient` already retries 429s honoring Retry-After, but that backoff never reaches the user-facing report, so a throttled run looks identical to a bare failure or a silently incomplete one. | partial | 4 | 4 | M | 11 |
| Detect and flag stalled scheduled syncs | A sync with a dead connection or scheduler bug just shows a stale `lastRunAt` with no reason; compute expected-vs-actual drift against `intervalMinutes` and surface a "stalled: reason" badge. | no | 4 | 4 | M | 11 |
| Health/status endpoint overhaul (per-connection, per-sync, named dependency) | `/api/health` only pings the DB; extend it to report per-connection auth state, recent sync failure counts, and named degraded dependencies, keeping an unauthenticated ping alongside a deeper check for external dashboards. | partial | 4 | 4 | M | 11 |
| Connection test button + redacted diagnostics/system report | There's no way to validate a connection or hand support a diagnostics dump; add a "test connection" action making one real request per provider, plus a "copy diagnostics" action (version, redacted connection status, recent run outcomes). | no | 4 | 4 | M | 11 |
| Prometheus `/metrics` endpoint with app-specific counters | No metrics surface exists; a native `/metrics` (runs by status, added/skipped/failed/notFound, run duration, rate-limit hits, scheduler tick lag) beats a third-party API-scraping exporter that can't see internal timings. | no | 4 | 4 | M | 11 |
| Auto-generated OpenAPI/Swagger docs for the HTTP API | No documented API contract exists; Fastify's swagger plugins can generate one from the existing typed routes almost for free, and it's a prerequisite for any external tooling. | no | 3 | 5 | S | 11 |
| Configurable + runtime-adjustable log level | `createLogger` is pino-based (level is mutable at runtime) but no `LOG_LEVEL` env var or in-app control exists, so changing verbosity requires a restart. | partial | 3 | 4 | S | 11 |
| Explain non-obvious partial-outcome categories (early-stopped backfill, refused write) | `DataTypeReport` has no field distinguishing "provider paginated out" from "hit a configured cutoff" from "refused to write because it'd leave a gap"; an unexplained short or suppressed run reads as data loss. | no | 3 | 4 | S | 10 |
| Post-run reconciliation report with a trust grade | Run reports store raw counts but never compare them against an independent source-side total; add a lightweight green/yellow/red completeness grade per run. | partial | 3 | 4 | S | 10 |
| Every safety guard must assert its input exists and log which guards fired | A guard silently reading an empty/wrong source runs "disabled" forever with no error — this is the exact shape of a real incident in a competitor tool; log which correctness mechanisms (cursor, delivery-memory, concurrency lock) were actually consulted each run. | no | 3 | 4 | S | 10 |
| Disk/DB size visibility and run-history retention policy | `syncRuns` and `deliveries` rows accumulate indefinitely with no cleanup job or size visibility; add a retention setting and surface DB/disk size in an About panel. | no | 3 | 4 | M | 9 |
| Surface item-level provenance ("which sync added this") | The `deliveries` table already records syncId/target/itemKey, but nothing in the UI answers "which sync put this item on the target," which matters once multiple syncs write into one place. | partial | 3 | 4 | M | 9 |
| Access logging, log suppressor rules, clickable log-to-item links | No Fastify request-logging middleware exists; add one on top of the existing pino logger, plus a way to quiet expected per-item warnings and deep-link a report entry back to its run. | partial | 3 | 4 | M | 9 |
| Tasks page: scheduler operator view with next/last run and manual trigger | The scheduler and `syncs.lastRunAt`/`intervalMinutes` already hold the data, but nothing aggregates it into one "is the scheduler alive" view with a run-now button. | partial | 3 | 4 | M | 9 |
| Non-convergence alarm: writes with zero new source activity | Flag when a run's `added` count is nonzero but nothing new arrived from the source since the last cursor — the same shape as Watchbridge's own known Simkl episode re-add bug. | no | 3 | 3 | M | 8 |
| Instance-wide events/activity feed at INFO level | There's no single chronological place to see connection state changes, token refreshes, or settings changes short of reading logs or run-by-run history. | partial | 3 | 3 | M | 8 |
| Live per-run progress state (phase, current provider, rate-limit wait) | A slow-but-healthy sync (rate-limited by a provider) looks identical to a hung one; expose a lightweight in-flight phase marker while a run is active. | no | 3 | 3 | M | 8 |
| Version/update awareness (in-app changelog + update-available banner) | `APP_VERSION` is baked from the git tag but nothing surfaces the changelog or compares it against the latest release. | partial | 2 | 4 | S | 7 |
| Avoid flattening log severity if a syslog transport is ever added | Not applicable today (stdout only), but worth avoiding: don't bury real severity as a text prefix in a single flat "info" priority if a syslog sink is added later. | no | 1 | 5 | S | 7 |
| Surface per-provider health/degradation, not just connected/error | `connections.status` is a flat active/reauth/error; a provider running degraded (rate-limited, or dark for an extended period) has no visible state before a sync starts silently failing. | partial | 2 | 3 | M | 6 |
| "Custom Script" notification connection as an extensibility escape hatch | Lower priority than the core notification channels given the sandboxing/security questions of running arbitrary scripts in-container, but a real breadth win once the core system exists. | no | 2 | 2 | L | 4 |
| In-UI log viewer with download, rolling files | No file-based log sink or log-serving route exists; a non-CLI operator can't self-diagnose or attach logs to a bug report without shell access to the host. | no | 2 | 2 | L | 4 |

### Notes

- The single most concrete, verified finding in this whole set: `ConnectionStore.setStatus()` is defined at `packages/server/src/connections/store.ts:122` but has zero call sites anywhere in `packages/server/src` — a dead Trakt/Simkl refresh token never actually flips a connection to `reauth`/`error`, it just sits at `active` forever. Wiring that one call site (in the refresh-failure path in `trakt.ts`/`runner.ts`) unlocks the reconnect banner and the notification system for free. ([PlexTraktSync#2502](https://github.com/Taxel/PlexTraktSync/issues/2502))
- Notifications should be transition-based, not per-error: fire on "last run failed after a success" or "N consecutive failures," never on every individual error — this is the exact blocker the WatchState maintainer cited for not shipping notifications at all. ([watchstate discussion #628](https://github.com/arabcoders/watchstate/discussions/628))
- Build webhook auth (bearer/basic/header) and custom headers into the notification schema from day one — retrofitting them after the schema ships means a migration, and homelab receivers behind Authelia/Access/Cloudflare Access assume both exist. ([Sonarr#2257](https://github.com/Sonarr/Sonarr/issues/2257), [Sonarr#8672](https://github.com/Sonarr/Sonarr/issues/8672))
- The non-convergence alarm (writes with zero new source activity) isn't hypothetical here — it's the same shape as Watchbridge's own open Simkl episode re-add bug (episodes get re-added every run with no new watch activity). A monitoring signal for "added > 0 but no new source events since the last cursor" would have caught it automatically. ([anibridge#234](https://github.com/anibridge/anibridge/issues/234), [PlexAniSync#241](https://github.com/RickDB/PlexAniSync/issues/241))
- `HttpClient` already retries on 429/5xx honoring `Retry-After` — the gap is entirely visibility, not correctness. Thread a "throttled, resumed after Nms" note up into the report instead of leaving a throttled run looking like a bare failure or a silently incomplete one. ([CrossWatch#63](https://github.com/cenodude/CrossWatch/issues/63))
- The safety-guard logging item generalizes a real incident: WatchState shipped a date-based conflict guard silently reading an always-empty scratch value for an extended period with no error. Watchbridge's cursor/delivery-memory checks are the same shape of risk and deserve a per-run log line stating which guards were actually consulted and what they resolved to.
- Health checks should name the specific degraded dependency ("Trakt connection unavailable," "Simkl token expired") rather than a generic ok/degraded flag — Servarr's own docs frame this as the difference between a monitoring alert someone acts on and one they mute. ([Servarr system.md](https://github.com/Servarr/Wiki/blob/master/sonarr/system.md))
- Match-health diagnostics (row 4) is the largest single merge — it folds together a named taxonomy for match failures, a cross-run aggregation view, and a per-item on-demand inspector, since all three answer the same "why didn't this item sync" question from a different angle. ([watchstate media-health guide](https://github.com/arabcoders/watchstate/blob/master/guides/media-health.md))
- `syncRuns` and `deliveries` rows currently have no retention or cleanup job; on a 60s scheduler tick this is unbounded growth on the embedded PGlite database with no operator-visible warning until disk pressure becomes an incident.

**Already covered (dropped from the table):** distinguishing idempotent "already exists" skips from real failures (`PushResult.skipped` vs `failed`); ID-only matching with unmatched items already routed through `notFound` rather than a silent title-matching fallback; keeping expected per-item misses at debug log level so info-level output stays clean; structured JSON logging via pino (a human-readable console format is the only remaining gap there).


## Import, export and migration

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Full data export (JSON + CSV), reliable delivery | A synchronous "export my data" route producing a downloadable JSON snapshot plus a flat CSV of history/progress, with a manifest recording expected item counts so it fails loudly instead of shipping a silently-truncated file | no | 5 | 4 | M | 13 |
| Restore-to-provider: push a snapshot back into a connected account | Treat an uploaded/stored Watchbridge snapshot as a synthetic `SyncSource` and run it through the existing planner/engine to restore a provider account, chunked and checkpointed so a large restore can resume, and listing real stored artifacts rather than reconstructing filenames | no | 5 | 4 | L | 12 |
| Scheduled, automatic backup snapshots (safety net before risky runs) | Auto-snapshot both sides of a sync the first time it goes live, plus a periodic scheduled backup job piggybacking on the existing scheduler, so a bad write always has something to fall back on | no | 4 | 4 | M | 11 |
| Config/settings export-import (syncs + connection metadata, no secrets) | Export/import sync definitions and connection metadata as portable JSON with credentials stripped or re-encrypted, plus an optional boot-time config file so an instance can be provisioned idempotently from GitOps/Ansible | no | 3 | 4 | M | 11 |
| Full resync / reset-cursor action per sync | A `POST /api/syncs/:id/reset-cursor` route to clear a sync's stored cursor and force a full replay after a reconnect or mapping-override change | partial | 3 | 5 | S | 11 |
| Generic mappable CSV/JSON importer + export-format presets (migration hub) | A column-mappable importer (Letterboxd, IMDb, Filmweb, Serializd, dead trackers) feeding the existing additive planner, parsed by header name so it never crashes on a renamed column, plus export presets shaped for each target's own import format | no | 5 | 3 | XL | 11 |
| Revert/undo last sync run | Extend the delivery ledger with enough per-run detail (which refs were added, to which target, when) to support a "revert last run" action that re-issues inverse calls where the target provider allows removal | no | 4 | 3 | L | 9 |
| TV Time migration importer | Parse TV Time's GDPR export (and the community "Liberator" format) into `WatchEvent`/`MediaRef` rows with a per-item diff report, to catch the migration wave from TV Time's July 2026 shutdown | no | 4 | 3 | L | 9 |
| IMDb import via file upload only, never a session-cookie connection | Support IMDb strictly through CSV upload/export, never by storing a user's raw browser session cookie as a stored credential | no | 2 | 3 | L | 5 |

Already covered: none. Watchbridge has no export, backup, restore, or import route of any kind today — every item in this category is a real gap.

### Notes

- The export item folds in several angles raised separately: destination should default to a direct HTTP download and, for scheduled exports, an `EXPORT_DIR`-mounted volume path — never third-party storage OAuth, which is exactly the credential-custody cost Trakt cited when it killed Automatic Backups ([forum thread](https://forums.trakt.tv/t/retiring-automatic-backups/102430)). CSV is the human-readable pair to JSON's fidelity ([Trakt CSV request](https://forums.trakt.tv/t/i-want-to-export-as-csv/108128), [Simkl export formats](https://docs.simkl.org/how-to-use-simkl/advanced-usage/import-export-data/exporting-from-simkl/export-data-formats)).
- Restore is the clearest whitespace across every competitor surveyed — nobody closes the loop from "file on disk" back to "account restored" ([traktexport](https://github.com/purarue/traktexport), [TraktRater#152](https://github.com/damienhaynes/TraktRater/issues/152)). Build it on the existing `runSync`/`planHistorySync` additive planner (`packages/core/src/sync/engine.ts:77`, `packages/core/src/sync/plan.ts:23`) so restore is just another `SyncSource`.
- Restore reliability trap: WatchState's restore endpoint once reconstructed a filename by convention instead of listing what it had actually written, and failed to find its own backup ([watchstate#632](https://github.com/arabcoders/watchstate/issues/632)). Any restore UI must enumerate real stored artifacts.
- The generic CSV/JSON importer is the single highest-leverage item in this research set — a decade of duplicate asks on TraktRater alone ([#13](https://github.com/damienhaynes/TraktRater/issues/13), [#177](https://github.com/damienhaynes/TraktRater/issues/177), [#108](https://github.com/damienhaynes/TraktRater/issues/108)), plus Simkl's own Letterboxd importer as prior art ([Simkl docs](https://docs.simkl.org/how-to-use-simkl/advanced-usage/import-export-data/importing-to-simkl/supported-platforms/letterboxd)). Preserve each row's original watched/added timestamp rather than defaulting to import time, and hash uploaded files to guard against duplicate re-imports.
- CSV parsing trap: IMDb and Letterboxd both change export layout over time and split across multiple files (watched/ratings/diary); parse by header name, not column position, and fail with a clear "unrecognised format" error rather than crashing ([TraktRater#173](https://github.com/damienhaynes/TraktRater/issues/173), [#129](https://github.com/damienhaynes/TraktRater/issues/129)).
- Config export is a distinct feature from data export — it's the syncs/connections rows, not the watch history — and repeatedly requested for moving a hand-tuned setup between instances ([MALSync#2145](https://github.com/MALSync/MALSync/issues/2145), [Prowlarr#2542](https://github.com/Prowlarr/Prowlarr/issues/2542)); keep it separate from the credentials it excludes (`connections.credentials`, encrypted via `SecretBox`).
- TV Time's official shutdown (15 July 2026) makes its importer a time-boxed opportunity; Trakt's own importer already drops rewatches and randomly omits episodes, which is a low bar to beat ([Trakt forum](https://forums.trakt.tv/t/tv-time-import-missing-episodes-rewatches-questions/114469), [Trakt TV Time help thread](https://forums.trakt.tv/t/coming-from-tv-time-we-re-here-to-help/114199)).
- IMDb has no public API; every real integration either uses the desktop CSV export or a raw session cookie against IMDb's internal GraphQL — a session-cookie connection would contradict Watchbridge's own encrypt-everything credential model, so IMDb support should stay file-based only ([Letterboxd-to-IMDb](https://github.com/TobiasPankner/Letterboxd-to-IMDb)).


## Accounts, multi-user and admin

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| API-key / bearer-token auth for a scriptable public API | No app API key exists today; adding one (scoped read-only vs read-write from the start) unlocks cron, Home Assistant, n8n and other companion-tool automation that only a browser session can drive right now | no | 5 | 4 | M | 13 |
| Surface connection reauth/error status on token failure | `ConnectionStore.setStatus()` exists but nothing ever calls it, so a revoked Simkl token or a failed Trakt refresh just fails scheduled syncs silently forever with no reconnect signal anywhere | partial | 4 | 4 | M | 11 |
| Admin UI and RBAC on the existing isAdmin flag | `users.isAdmin` exists with no admin routes or page built on it, so once more than one person shares an instance nobody can see, disable, or manage other accounts | partial | 4 | 4 | M/L | 11 |
| Native OIDC/SSO login for app accounts | Only local email+password exists; homelab users expect Authentik/Authelia/Keycloak login, and skipping PKCE, nonce handling, and RP-initiated logout would reproduce bugs Immich already hit in production | no | 5 | 2 | L | 10 |
| Serialize OAuth token refresh per connection | Two concurrent operations against the same connection can both refresh its token and invalidate each other's refresh token, the exact failure that has forced PlexTraktSync users to restart their container | no | 3 | 4 | S | 10 |
| Forward-auth / trusted-header proxy mode, off by default | Users fronting Watchbridge with Authentik/Cloudflare Access want to skip the internal login; ship as an explicit env-gated mode built on the existing trusted-proxy CIDR logic, never a bypass by network origin alone | partial | 3 | 3-4 | M | 9 |
| Self-service account deletion with provider token revocation | No account-deletion route exists; a user can't remove their data or have Watchbridge revoke stored Trakt/Simkl tokens on the way out | no | 3 | 4 | M | 9 |
| Multiple connections of the same provider per user | `connections.label` hints this was intended, but there's no confirmed support for two accounts of the same provider (e.g. two Trakt logins) per user, and no invite flow beyond `REGISTRATION_ENABLED` | partial | 3 | 4 | M | 9 |
| Declarative admin bootstrap without a long-lived key | No CLI or first-boot provisioning path; automated/GitOps deploys need either a human to register the first admin or a permanent baked-in credential | no | 2 | 3 | M | 6 |
| Cross-account identity linking for shared/household use | No concept of linking two Watchbridge accounts or a shared-account topology; cheap to decide the shape now, expensive to retrofit later if ever wanted | partial | 2 | 2 | XL | 3 |

Already covered: per-user self-service provider linking (each user already connects and encrypts their own Trakt/Simkl/PMDB/MDBList credentials independently, ahead of Jellyfin's admin-only model and PlexTraktSync's one-container-per-user model) — worth calling out in product copy, no engineering work needed.

### Notes

- API key: add an `apiKeys` table plus a bearer preHandler beside `requireAuth` in `packages/server/src/plugins/auth.ts`, reusing `newOpaqueToken`/`hashToken` from `auth/tokens.ts`; scope keys (read-only vs read-write) from day one so it isn't a breaking migration later ([Sonarr#7549](https://github.com/Sonarr/Sonarr/issues/7549)), and expose a minimal list/run/report surface reusing `routes/syncs.ts` handlers ([WatchState API.md](https://github.com/arabcoders/watchstate/blob/master/API.md), [Sonarr#7230](https://github.com/Sonarr/Sonarr/issues/7230)).
- Reauth signal: catch 401/403 in the token-refresh path (`connections/service.ts`, `providers/trakt.ts:209-220`) and in `sync/runner.ts`'s catch block, call `ConnectionStore.setStatus(id, 'reauth')`, and render a reconnect banner in `Connections.tsx` instead of a generic error ([Simkl error conventions](https://api.simkl.org/conventions/errors.md), [Sonarr#7874](https://github.com/Sonarr/Sonarr/issues/7874)).
- Admin/RBAC: add a `requireAdmin` preHandler beside `requireAuth`, a new `routes/admin.ts` (list/disable users, view all syncs/connections), and a `pages/Admin.tsx` page; existing per-user scoping in `connections/service.ts` and the sync routes already isolates data correctly ([Sonarr#1682](https://github.com/Sonarr/Sonarr/issues/1682), [jellyfin-plugin-trakt#221](https://github.com/jellyfin/jellyfin-plugin-trakt/issues/221)).
- OIDC: build via `openid-client` with issuer discovery, auto-register, and role-claim mapping onto `isAdmin`; from day one always send PKCE (S256), treat an empty-string nonce as absent rather than a hard mismatch, and pass `id_token_hint` on RP-initiated logout ([Immich OIDC docs](https://docs.immich.app/administration/oauth/), [immich#26930](https://github.com/immich-app/immich/issues/26930), [immich#29055](https://github.com/immich-app/immich/issues/29055), [immich#29111](https://github.com/immich-app/immich/issues/29111)); ship the API-key item alongside or before it so non-browser clients are never locked out ([jellyfin-meta#28](https://github.com/jellyfin/jellyfin-meta/issues/28)).
- Token refresh race: make refresh an atomic read-modify-write on the connection row instead of an in-memory cached token, so two concurrent syncs can't consume and invalidate each other's refresh token.
- Forward-auth: gate behind an env flag like `AUTH_TRUST_PROXY_HEADER` (default off), verify the peer IP against `expandTrustedProxies` (`core/net/cloudflare.ts`) before honoring any header, and keep the trusted list configurable — WatchState hardcoded this and drew complaints ([Prowlarr#2477](https://github.com/Prowlarr/Prowlarr/issues/2477), [Radarr#11291](https://github.com/Radarr/Radarr/issues/11291), [WatchState FAQ](https://github.com/arabcoders/watchstate/blob/master/FAQ.md)).
- Account deletion: add `DELETE /api/auth/account` gated on re-entering the password (not just a typed username), revoke/forget provider tokens via `ConnectionService`, then cascade-delete connections/syncs/runs/deliveries before the user row ([Trakt account-deletion PR](https://github.com/trakt/trakt-web/pull/2814)).


## Deployment and configuration

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Scheduled automatic database backups, pre-migration snapshot and repair path | A scheduled backup task (pg_dump for Postgres, PGlite's own export for the embedded path) written atomically and verified before being marked complete, plus a snapshot taken before applying a drizzle-kit migration so a bad migration or disk corruption has a recovery path | no | 5 | 3 | L | 11 |
| Reverse-proxy docs + honoring X-Forwarded-Proto for absolute URLs | Publish copy-paste nginx/Caddy/Traefik configs, and make sure absolute URLs in verification/reset emails derive scheme correctly rather than only trusting a fixed `APP_URL` | partial | 3 | 5 | S | 11 |
| Timezone / clock-skew handling and audit | Add an explicit `TZ` posture and audit every provider client for local-time date parsing, since a silent TZ-dependent offset on `watched_at`/`paused_at` would corrupt the exact field history dedupe and any future timestamp-based conflict resolution rely on | partial | 3 | 4 | S | 10 |
| Startup preflight for data-directory writability | Check the mounted data/DB path is writable by the running uid before PGlite/Postgres connects, logging the expected uid:gid clearly instead of an opaque crash | no | 3 | 4 | S | 10 |
| Automated changelog generation, surfaced in-app | Generate CHANGELOG entries and GitHub releases from conventional commits on tagged releases, and add a "what's new" link next to the version already returned by `/api/health` | partial | 2 | 5 | S | 9 |
| Config/settings backup and restore | Export/import sync definitions and connection metadata (secrets excluded or re-encrypted) as a portable, validated file, for migrating hosts or recovering from a corrupted PGlite volume | no | 3 | 4 | M | 9 |
| Restore UI: list, download, delete, upload-restore | A dedicated Backups page with list/restore/delete per row, a manual "Backup Now" button, and upload-to-restore from an external file, gated behind a confirmation step since restore is destructive | no | 4 | 3 | L | 9 |
| Full env-var config coverage with UI indicating env-locked settings | Document env-over-stored-config precedence as new settings (backups, notifications, URL base) are added, and make sure the settings UI never silently ignores an edit to a field that's actually fixed by env var | partial | 2 | 5 | S | 9 |
| Retry/backoff loops must respect the remaining request time budget | Any DB-lock retry/backoff between the in-process scheduler and concurrent API writes must be bounded to the remaining request timeout, not a fixed retry count, so a request can't be killed mid-retry with the write silently lost | no | 3 | 3 | M | 8 |
| Single distribution path (GHCR only) is a point-of-failure risk | Confirm the GHCR image namespace is org-owned (IbbyLabs), not tied to a personal account, so a single account issue can't delete the image history | partial | 2 | 4 | S | 8 |
| Per-provider outbound proxy configuration | Let a specific provider's traffic route through an HTTP/SOCKS5 proxy, scoped per-connection rather than a single process-wide env var — Watchbridge's own history includes a global `HTTPS_PROXY` breaking all outbound traffic | no | 2 | 4 | S | 8 |
| Detect and warn on cloned instances sharing one connection | Stamp a random install id at first boot and warn when the same connection's credentials are used from two different install ids in a short window, guarding against a cloned homelab container racing its sibling | no | 2 | 4 | S | 8 |
| Ensure the container reaps child processes (init/tini as PID 1) | Confirm the image runs an init as PID 1, and explicitly await/reap any subprocess a future feature (e.g. a pg_dump-based backup) might spawn | no | 1 | 5 | S | 7 |
| Opt-in, disclosed analytics/telemetry toggle | If usage or crash-reporting telemetry is ever added, ship it off-by-default with a plainly-worded setting stating the exact payload and an env var that force-disables it | no | 1 | 5 | S | 7 |
| Add an Unraid Community Applications template | Publish an Unraid CA XML template pointing at the existing multi-arch GHCR image, documenting any PUID/PGID mapping needed for the data volume | no | 1 | 4 | S | 6 |
| URL Base / subpath support for reverse-proxy deployment | Thread a `URL_BASE` env var through Vite base config, React Router basename, the session cookie path, and email links, always serving/redirecting from bare root so a bad setting can't lock the operator out | no | 3 | 2 | L | 6 |

Already covered: headless/always-on Docker deployment with an in-process scheduler is already the architecture, just under-marketed ([UTS#88](https://github.com/trakt-tools/universal-trakt-scrobbler/issues/88)); external Postgres alongside embedded PGlite is already supported via one `DATABASE_URL` (only a documented migration path and retention split for high-churn tables remain, [Servarr env vars](https://github.com/Servarr/Wiki/blob/master/sonarr/environment-variables.md)); non-interactive/headless credential setup is solved by construction since connections are browser OAuth or plain API-key POSTs with app-level secrets from env vars ([PlexTraktSync#845](https://github.com/Taxel/PlexTraktSync/issues/845)); and the per-sync `{source, target, dataTypes}` model already avoids the multi-instance routing limitation some competitors hit ([Notifiarr MDBList docs](https://notifiarr.wiki/pages/integrations/mdblist/)).

### Notes

- Backups are the standing gap across this whole category: Watchbridge holds encrypted OAuth tokens, sync definitions, delta cursors, and delivery-memory rows with no backup at all today, so losing the DB means re-authing every provider from scratch ([Servarr backup settings](https://github.com/Servarr/Wiki/blob/master/sonarr/settings.md), [Jellyfin backup bug](https://github.com/jellyfin/jellyfin/issues/15536)). The scheduled-backup, config-export, and restore-UI rows above are three faces of the same underlying feature and should ship together — a backup with no restore UI is unusable for non-CLI operators.
- Config/settings backup-restore here overlaps with the config-export item covered in depth in the import-export-migration section; the distinct angle in this category is host migration and recovery from a corrupted PGlite volume, not day-to-day sync-config portability.
- Reverse-proxy docs should mirror Servarr's exact header list (`Host`, `X-Forwarded-For`, `X-Forwarded-Host` with port, `X-Forwarded-Proto`, websocket `Upgrade`/`Connection`) ([Servarr reverse-proxy guide](https://github.com/Servarr/Wiki/blob/master/sonarr/installation/reverse-proxy.md)); Watchbridge already resolves client IP from forwarded headers with a trusted-proxy allowlist (`net/clientIp.ts`, `plugins/realIp.ts`), so this is documentation plus one absolute-URL check in `mail/templates.ts`.
- Timezone handling is a correctness trap, not just an ops nicety: CrossWatch shipped scrobble timestamps silently offset by the container's TZ, and WatchState's `stale_database_date` bug causes updates to be silently skipped with no repair path once data is tainted ([watchstate FAQ](https://github.com/arabcoders/watchstate/blob/master/FAQ.md)). Add a CI test run with a non-UTC `TZ` asserting stored/compared timestamps stay UTC-correct.
- The retry/backoff and PID-1-reaping items are both preventive "bug to avoid" entries with no confirmed occurrence in Watchbridge today (Dockerfile isn't in the repo map) — cheap to verify now, expensive to discover in production ([watchstate#849](https://github.com/arabcoders/watchstate/issues/849), [watchstate#773](https://github.com/arabcoders/watchstate/issues/773)).
- URL base/subpath support is high-effort and low-feasibility (touches Vite base config, React Router basename, cookie path, and email links all at once) but blocks a very common single-domain homelab layout; the hard requirement is that a bad setting must never be able to 404 the whole UI with no recovery, unlike a Jellyfin bug that did exactly that ([jellyfin#16291](https://github.com/jellyfin/jellyfin/issues/16291)).
- The cloned-instance-detection and single-distribution-path items are both low-probability, low-cost mitigations rather than active fires — worth a small stamp-an-install-id check and a one-time confirmation that the GHCR namespace is org-owned, respectively.


## Security and privacy

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Default any list created on a user's behalf to private | Trakt's own web client once shipped a bug where a private user's newly created list defaulted to public; any future list-creation call must default private and only widen on explicit opt-in | no | 4 | 5 | S | 13 |
| Confirm rate limiting covers login, password reset, and email verification | `RateLimiter` and `SIGNUP_RATE_PER_HOUR` exist but appear signup-specific; a public login endpoint without brute-force protection is a standard hardening gap | partial | 3 | 5 | S | 11 |
| Treat notification-provider inputs as untrusted | Applies to the planned Apprise / Custom Script connections: shelling out with user-supplied URLs or titles is a command-injection vector unless built with argv arrays and escaping from day one | no | 3 | 5 | S | 11 |
| Key delta cursors and delivery memory to the resolved remote account | If a connection is re-authorized to a different remote account, stale cursors/delivery memory must not serve or push the previous account's data | no | 4 | 3 | M | 10 |
| Honor source-provider privacy/visibility flags before sync | Once anime-native providers like AniList are added, entries marked private/hidden-from-status-lists must be filtered before they enter the sync plan, not exported anyway | no | 3 | 4 | S | 10 |
| 2FA/MFA on local accounts, plus a session/device list | Watchbridge is internet-exposed and holds live third-party OAuth tokens; the `sessions` table already carries ip/userAgent/lastSeenAt, so a device list is mostly a UI layer on existing data | partial | 4 | 3 | L | 9 |
| Document a compliance stance on Simkl's API terms | Simkl's terms restrict use alongside "competing services" unless the app itself provides Simkl login+sync (Watchbridge does); worth a written note rather than an assumption | no | 2 | 5 | S | 9 |
| Document/expose base-URL and subpath support for reverse-proxy deployments | No documented subpath handling beyond a single `APP_URL` value; self-hosters running behind Authelia/Authentik/Cloudflare Access will ask for it | partial | 2 | 4 | S | 8 |
| Certificate-validation strictness setting for self-signed endpoints | Not urgent while all providers are public HTTPS APIs; becomes relevant once a self-hosted target (private-CA OIDC issuer, internal webhook) is added | no | 1 | 4 | S | 6 |

Already covered: the settings-save invariant that unmodified secrets are never overwritten (`PublicConnection`/`toPublic` never includes `credentials`, and writes only go through dedicated per-provider POST routes); and the OAuth/API-key-only connection model, which never requires scraping or a public profile like some competitor backup tools do.

### Notes

- List privacy: any future list-creation call on a provider client must default private and only widen to match the source list's privacy once the user explicitly opts in via the `Syncs.tsx` list-pair config ([Trakt web PR#2914](https://github.com/trakt/trakt-web/pull/2914)).
- Rate limiting: verify (and add if missing) `RateLimiter` (`plugins/rateLimit.ts`) usage on login, password-reset-request, and email-verification-resend in `routes/auth.ts`, not only on registration ([WatchState config](https://github.com/arabcoders/watchstate/blob/master/config/config.php)).
- Notification inputs: when Apprise/Custom Script connections are built, invoke external processes with argv arrays (never a shell string), allowlist accepted URL schemes, and HTML-escape any item/sync titles before they reach a notification body ([Uptime Kuma#7391](https://github.com/louislam/uptime-kuma/issues/7391)).
- Cursor/delivery keying: add a resolved remote-account-id column to `connections`, captured on connect/reauth in `ConnectionService`; invalidate `syncs.cursors` and clear stale `deliveries` rows in `SyncRunner` when that id changes, so reconnecting to a different remote account can't push or read against the wrong one ([universal-trakt-scrobbler#347](https://github.com/trakt-tools/universal-trakt-scrobbler/issues/347)).
- Privacy/visibility flags: once AniList or similar providers ship, read `isPrivate`/hidden-from-status-list on pull and drop those refs before they reach `planHistorySync`/`planProgressSync`, with a per-sync opt-in toggle to include them ([MALSync#414](https://github.com/MALSync/MALSync/issues/414)).
- 2FA/MFA: add TOTP secret and recovery-code columns to `users`, an enroll/verify flow in `auth/service.ts`/`routes/auth.ts`; expose the existing `sessions` table as a device list with a revoke action in `Settings.tsx` ([Radarr#8200](https://github.com/Radarr/Radarr/issues/8200)).
- Simkl compliance: add a short README/docs note that Watchbridge provides native Simkl login+sync (satisfying the "competing services" clause), track the $150/mo revenue threshold as a self-hosted project, and link back to simkl.com from the Simkl connection UI ([Simkl API terms](https://github.com/SIMKL/API/blob/master/apiary.apib)).
- Subpath support: add Fastify prefix routing in `app.ts` driven by `APP_URL`'s path component; do not copy WatchState's bypass-all-auth-for-local-network pattern — cookie-session auth should hold regardless of network path ([WatchState FAQ](https://github.com/arabcoders/watchstate/blob/master/FAQ.md)).


## Accessibility and internationalisation

| Item | What / why | Have it? | Impact | Feas. | Effort | Score |
|---|---|---|---|---|---|---|
| Live regions for async status | Auth banners, form success/error text, sync run outcomes and device-link polling all update the DOM with no `aria-live`/`role="status"`, so screen reader users get no notice anything happened | no | 4 | 5 | S | 13 |
| Field error association | `Field`'s error `<span>` sits next to the input with no `aria-describedby`/`aria-invalid` wiring, so a screen reader user tabbing into an invalid field hears nothing about the error | no | 4 | 4 | M | 11 |
| Toggle buttons expose no state | The data-type picker buttons on the create-sync form change look on selection but carry no `aria-pressed`, so AT users can't tell which are selected | no | 3 | 5 | S | 11 |
| Run status is color-only | Each sync run's status dot is `aria-hidden` with no adjacent text, so success/failure is conveyed by color alone | no | 3 | 5 | S | 11 |
| Low-contrast "faint" text token | `text-faint` (#71717a) renders at roughly 3.9-4.1:1 on the app's dark surfaces, short of the 4.5:1 AA minimum for body text, and it's used for hints, placeholders, and default-state footer links | no | 3 | 5 | S | 11 |
| Low-contrast brand text token | `text-brand` (#5e6ad2) renders at 4.26:1 on `bg` and 4.10:1 on `surface`, short of the 4.5:1 AA floor, and it is the colour of every auth-page link, the active nav item and the brand pill | no | 3 | 5 | S | 11 |
| No focus-visible styling on links/nav | Sidebar/mobile-tab `NavLink`s and inline text links across every page rely on the unstyled UA default outline, unlike `Button`/`Input` which do define a visible focus ring | partial | 3 | 4 | S | 10 |
| No skip-to-content link | The desktop layout has no bypass mechanism, so keyboard/AT users must tab through the sidebar nav on every page before reaching content | no | 2 | 5 | S | 9 |
| Modal has no real focus trap or focus return | The dialog moves focus in on open and closes on Escape, but Tab can still reach the backdrop/page behind it, and focus isn't restored to the trigger on close | partial | 3 | 3 | M | 8 |
| No per-route title or focus reset | The SPA never updates `document.title` or moves focus on route change, so tab identification and "landed on a new page" cues are missing for AT users | no | 2 | 4 | M | 7 |
| Small secondary tap targets | Footer contact links, "Use a code instead," "Dismiss," and "Run history" are bare `text-xs` links/buttons with no padding, likely under the 24x24 CSS px minimum | no | 2 | 4 | M | 7 |
| No i18n framework | Every string is hardcoded English JSX text with zero i18n library in the dependency tree | no | 2 | 2 | L | 4 |

### Notes

- No live region anywhere: `Login.tsx:37-51` (verified/reset banners), `ui.tsx:51-52` (`Field` error span, used by every form), `ForgotPassword.tsx:28-31`, `Settings.tsx:105-109` (password-changed confirmation), `Connections.tsx:68-86` (connected/error banners driven by redirect query params), `Connections.tsx:277-283` (`DeviceModal` starting/waiting/error text), `Syncs.tsx:209-238` (`OutcomeView` preview/run results). None of these wrap the changing text in `role="status"`/`role="alert"`/`aria-live`. Fix: wrap each in a small `Live` wrapper (`role="status" aria-live="polite"`, `role="alert"` for the error cases) — no markup restructuring needed.
- `Field` (`ui.tsx:36-58`) renders `<label>` wrapping `{children}` then a conditional error/hint span, but never assigns the input an `id` or points at the error with `aria-describedby`; `Input`/`Select` (`ui.tsx:60-76`) don't accept an `id` at all today (callers never pass one). A screen reader on an invalid password field currently announces only the label and value, not the error. Fix: generate an id in `Field` (e.g. `useId()`), clone/forward it to the child input, and set `aria-describedby`/`aria-invalid` when `error` is present.
- `Syncs.tsx:322-335` — the history/progress data-type buttons toggle a `border-brand`/`bg-brand` visual state via `onClick` but never set `aria-pressed`. Fix: `aria-pressed={types.includes(d.id)}`.
- `Syncs.tsx:241-244` — `RunStatus` is `<span className={...bg-success/bg-danger/bg-brand...} aria-hidden />` with no sibling text; the row around it (`Syncs.tsx:193-199`) reads timestamp + trigger only, so a successful vs. running run is indistinguishable to a screen reader. Fix: add a visually-hidden text node (`sr-only`) with the status word, or drop `aria-hidden` and give the dot an `aria-label`.
- Contrast: computed against the darkest surface in use (`bg-bg #08080a`, `tailwind.config.js:8`), `text-faint #71717a` (`tailwind.config.js:18`) comes out to ~4.14:1, and against `bg-surface #0e0e11` (`tailwind.config.js:9`) ~3.99:1 — both below the 4.5:1 AA floor for normal-size text. Used at `ui.tsx:54` (hint text), `ui.tsx:64` (placeholder), `Footer.tsx:44,50-75` (default-state contact links), `Syncs.tsx:159,191,197` (next-run time, "No runs yet," trigger). `text-muted #a1a1aa` (`tailwind.config.js:17`) is fine (~7.5:1+). Fix: lighten `faint` a few steps, e.g. toward `#86868f`, and re-check.
- Second contrast failure, on the accent rather than the neutral: `brand #5e6ad2` (`tailwind.config.js:13`) computes to 4.26:1 on `bg-bg` and 4.10:1 on `bg-surface`, also under the 4.5:1 floor for normal-size text. It is used as a text colour in eight places, all of them normal size: `Login.tsx:60,70`, `Register.tsx:38,64`, `ForgotPassword.tsx:32,54`, `ResetPassword.tsx:25`, `Connections.tsx:294`, the active sidebar/tab item at `Layout.tsx:84`, and the `brand` pill tone at `ui.tsx:83`. Every auth-page link is therefore below AA. Fix: lighten the token used for text (the existing `brand.hover #6b76dd` is still only ~4.7:1, so it clears the bar but with little margin), or keep `brand` for fills and introduce a separate lighter `brand.text` for foreground use. Note that `brand` on a fill (white text on `bg-brand`) is unaffected and fine.
- Focus-visible: `Button` (`ui.tsx:24`) and `Input`/`Select` (`ui.tsx:64,73`) define `focus-visible:ring-2 focus-visible:ring-brand`, but `Layout.tsx:36-48` (sidebar `NavLink`), `Layout.tsx:79-91` (mobile tab bar), and every inline `<Link>` (e.g. `Login.tsx:60-62,70-72`, `Footer.tsx:50-75`) have only `hover:` styling, no `focus-visible:` treatment — keyboard users tabbing through navigation get whatever the browser's default outline renders on a near-black background, unverified for contrast.
- `Layout.tsx:28-71` has no skip link before the sidebar `<nav>`; keyboard and screen-reader users hit the full nav on every page load.
- `Modal` (`ui.tsx:112-141`) sets `tabIndex={-1}` and focuses itself on mount, and closes on Escape — good start — but there's no loop trapping `Tab`/`Shift+Tab` inside the dialog and no `inert`/`aria-hidden` applied to the rest of the tree, so keyboard users can tab past the dialog into the page behind the overlay; focus also isn't returned to whatever button opened it once `onClose` fires.
- `App.tsx` has no route-change effect: `document.title` stays `Watchbridge` (`index.html:8`) forever, and nothing moves focus to the new page's heading after navigation (login success, sidebar clicks) — common SPA gaps, not present here.
- Small targets: `Footer.tsx:50-75` (logo credit + Ko-fi/Discord links, all `text-xs` with a `gap-1.5` icon and no padding), `Connections.tsx:125-130` (`text-xs` "Use a code instead"), `Connections.tsx:71-73,82-84` (`text-xs opacity-80` dismiss buttons), `Syncs.tsx:182-187` ("Run history" toggle) — none have explicit padding or a `min-h`/`min-w`, so their hit area is close to their glyph size, well under 24 CSS px.
- What the app already gets right: every form input has a real `<label>` via `Field` (`ui.tsx:48`), `autocomplete` values are consistently correct (`username`, `email`, `current-password`, `new-password` — e.g. `Login.tsx:54,57`, `Register.tsx:50,53,56`, `Settings.tsx:81,90,100`), icon-only actions like sync delete and disconnect carry `aria-label` (`Syncs.tsx:173`, `Connections.tsx:116`), `prefers-reduced-motion` is handled globally (`index.css:24-33`), the document has a correct static `lang="en"` (`index.html:2`), heading order is sound (one `<h1>` per page, `<h2>` for subsections in Settings), and timestamps use `toLocaleString()` (`Syncs.tsx:196`) so date/time formatting already follows the visitor's browser locale.

**Internationalisation.** There is no i18n framework in the dependency tree (`package.json` — just `react`, `react-dom`, `react-router-dom`) and every string in every page/component is inline English JSX text. For where this product sits today — a self-hosted sync tool for Trakt/Simkl/PMDB/MDBList, installed and run by a single technical operator, in an ecosystem (Jellyfin, the *arr family) whose admin/config surfaces are commonly English-only even when the *consumer-facing* UI is translated — that's a reasonable place to be, and English-only is not blocking adoption right now. It would start to matter if this grows a shared/family multi-user login surface aimed at non-technical relatives, since login/register/settings are exactly the screens people expect in their own language even in tools whose admin panel stays English. Retrofitting later is a real cost, not a config flip: there's no id/message-key convention anywhere, so adding `react-i18next` or `next-intl`-style tooling means touching every page and component in `src/pages/` and `src/components/`, extracting ~100+ inline strings (including string interpolation like `` `We sent a verification link to ${email}.` `` in `Register.tsx:32`), and building a translation-key file from scratch. Cheapest time to do this is before more pages/copy are added, not after.


## Gaps found by the completeness critic

Overall the audit is thorough on sync correctness, provider quirks, and observability (564 items is a lot of surface). But it missed the single most relevant direct competitor (CrossWatch), under-covers a few structural risk categories that don't show up in code review (GDPR/data-controller obligations, encryption-key loss, schema-migration safety, provider API deprecation policy), and — as flagged going in — accessibility and internationalisation got zero items despite being checkable against a real, current standard (WCAG 2.2) and a real comparable tool (Homarr). A handful of specific numeric claims about Trakt/Simkl 2026 changes check out but have a shaky date attached that's worth fixing before anyone cites it.

### Uncovered competitors

- **[CrossWatch](https://github.com/cenodude/CrossWatch)** — this is the biggest miss. 654 stars, actively updated (last commit today), and it already does almost everything Watchbridge does plus almost everything on Watchbridge's own gap list: Plex/Jellyfin/Emby/SIMKL/Trakt/PublicMetaDB/AniList/TMDb/MDBList in one engine, a session-polling "Watcher" that needs no Plex Pass (Watchbridge's backlog lists this as a future idea), backup/restore with a rollback tool ("Captures"), multi-user/household "Profiles", a "Playback Progress Manager", a stuck-item analyzer, and a live "currently watching" player card. It even documents [Trakt vs Simkl free-plan limits](https://wiki.crosswatch.app/related-information/trakt-vs-simkl-free-plans) and has its own [provider rate-limiting doc](https://wiki.crosswatch.app/crosswatch/provider-rate-limiting). Several "differentiator" and "gap" claims in the audit (multi-user as a structural advantage over PlexTraktSync, media-server support as the biggest open opportunity, backup/restore as an unmet need) need to be re-tested against CrossWatch specifically, not just PlexTraktSync/WatchState. Impact 5, feasibility n/a (this is a positioning correction, not a build item), effort S to redo the competitive comparison.
- **[PlexyTrack](https://github.com/Drakonis96/plexytrack)** — smaller (55 stars, MIT) but a direct Trakt↔Simkl↔Plex bridge with backup/restore of Trakt history, lists and ratings. Same territory as Watchbridge's core loop.
- **[Movary](https://github.com/leepeuker/movary)** (also mirrored on Docker Hub as `leepeuker/movary` / `tungbq/movary`) — a self-hosted personal movie-tracking web app, not a bridge, but overlaps on the exact use case of "own your watch history instead of trusting a SaaS": Plex/Jellyfin/Emby/Kodi scrobbling, Trakt/Letterboxd/Netflix import, per-user household sharing, no ad targeting. Worth a line in positioning since it's the answer people get when they search "self-hosted Trakt alternative" (see the [Lemmy thread](https://lemmy.world/post/25275389) title itself).
- **TV Time's actual shutdown** is a market-timing fact the audit's TV-Time items don't seem to reflect precisely (see re-verify section below) — TV Time [shut down July 15, 2026](https://www.techtimes.com/articles/319583/20260703/tv-time-closes-july-15-26-million-users-face-permanent-watch-history-deletion.htm), a week before this audit ran, and [TVmaze already shipped a dedicated importer](https://www.macrumors.com/2026/07/02/show-tracking-app-tv-time-shutting-down/) for TV Time's GDPR export CSV. The migration wave is a closing window, not an open one, and Watchbridge would be a late entrant against at least TVmaze, Trakt, Simkl and Serializd, all of whom already absorbed the wave.

### Uncovered concerns

- **GDPR/data-controller obligations, as distinct from "self-service account deletion."** The list has `[auth-multiuser-admin] No self-service account deletion or provider token revocation on account close`, which is a UX feature, not a legal framing. Nothing addresses Watchbridge's own posture as a data controller for any multi-user or household-shared instance: a documented retention policy, a right-to-erasure flow that also purges backups/snapshots (not just live rows), or a privacy-policy disclosure of what's stored (encrypted OAuth tokens, watch history, progress). Self-hosting reduces but doesn't eliminate this — a household or shared instance run by one admin for other people is still processing other people's data. Impact 4, feasibility 4, effort M.
- **Encryption-key loss / rotation has no item at all**, and it's the single most catastrophic failure mode in the actual codebase: `packages/core/src/crypto/secretBox.ts` encrypts every stored credential with `APP_ENCRYPTION_KEY` (env var, per `ENV VARS` in the repomap). Lose that key — rotate the env var without a migration, restore a DB backup onto a fresh instance without also restoring the matching key, or just misconfigure a redeploy — and every connection's stored Trakt/Simkl/PMDB/MDBList credentials become permanently undecryptable for every user on the instance, with no items covering detection, rotation, or recovery. Impact 5, feasibility 5, effort S (document + add a startup check that the key can decrypt a known-good stored value, fail loudly if not).
- **Database schema-migration/upgrade safety** isn't covered. The `import-export-migration` and `deployment-config` items are all about migrating *data between providers* or *backing up sync config* — none address the ordinary operational risk of a Watchbridge version bump running a Drizzle migration against a live production DB with no rollback path if the migration is bad. Impact 4, feasibility 4, effort M.
- **Provider API deprecation as a standing policy**, not just specific instances. The list has many concrete, already-verified 2026 Trakt/Simkl changes (pagination, 420 caps, rewatch sessions) but no item for a general practice of watching provider changelogs/discussions and running a canary check against response shape so a future breaking change is caught before it silently corrupts syncs. Impact 3, feasibility 4, effort S.
- **Legal/ToS review is one-sided.** *(Note 2026-07-24: attempted to verify Trakt/MDBList/PMDB terms
  automatically but trakt.tv/terms returns 403 to non-browser fetches and the API specs carry no terms
  text. This one needs a manual read or a browser session, and a human eye on the legal wording
  anyway — flagged rather than auto-resolved.)* Only Simkl's "not authorized alongside competing sync services" clause got an item. Trakt, MDBList and PMDB's own terms (rate-limit fair-use policies, any prohibition on commercial/third-party redistribution, attribution requirements) were apparently never checked. Impact 3, feasibility 5, effort S.
- **Accessibility — confirmed zero coverage, and it's checkable.** WCAG 2.2 (the current W3C recommendation, published Oct 2023) is the real bar: keyboard operability, visible focus, contrast, and form-error identification are Level A/AA criteria that apply directly to the React/Tailwind SPA (`packages/web/src/pages/*`, `components/ui.tsx`). No item in `ux-ui` or elsewhere addresses any of this. Impact 4, feasibility 4, effort M for a first pass (labeled inputs, focus rings, contrast on the dark theme, keyboard-reachable modals/tables).
- **Internationalisation — confirmed zero coverage.** For comparison, Homarr (a comparable self-hosted dashboard, github.com/homarr-labs/homarr) ships with 26 languages and takes community translation contributions; that's the norm for this class of self-hosted tool, not an edge case. Watchbridge's web package has no i18n scaffolding at all per the repomap. Impact 2, feasibility 3, effort L (needs a string-extraction pass across all `pages/`/`components/` first).

### Found by direct verification, not by the research

- **Runs that fail before reaching the engine are completely silent.** The sync engine does log a
  line per data type (`packages/core/src/sync/engine.ts:131`, at info), so a run that gets that far
  is visible. But `runner.ts` returns early when either provider is not connected, and that path
  writes a `sync_runs` row, updates `lastRunAt`, and logs nothing at all. `runner.ts` had exactly one
  logging call, `log.error(..., 'Sync run failed')`, covering only thrown exceptions. So the single
  most likely real-world failure, a broken or expired connection, produced no output whatsoever, and
  there was no run-level line tying a run's directions and data types together or recording its
  duration. Fixed: one structured line per completed run at info, warn on partial, error on failed,
  including the provider pair, trigger, duration and per-data-type counts. Impact 4, feasibility 5,
  effort S.
- **The live instance has logged no sync activity since it restarted.** With `LOG_LEVEL` unset in
  production (so info is enabled) and the engine logging at info on every run, the container has
  produced four lines in two days of uptime, all from boot, while reporting healthy. Given the engine
  would log if it were reached, this points at runs ending in the silent early-return path above
  rather than at an idle scheduler. Worth confirming now that runs log their own outcome.

### Claims to re-verify

- Simkl rewatch sessions — **the date has been dropped rather than defended.** The feature is real
  (`POST /sync/history?allow_rewatch=yes`, up to 50 sessions, Pro/VIP-gated). The "2026-05-22" date
  was never verified as the feature's launch and most likely belongs to the freeze of Simkl's Apiary
  docs. Do not cite a launch date for it without a source.
- ~~`before June 30 2026`~~ — **checked and corrected.** No such deadline exists. Discussion #681
  lists four milestones (mid-Feb, end-Feb, 15 April, 15 June 2026), all now past. Watchbridge is
  compliant. Corrected in the table and notes above.
- TV Time — **the window has closed; treat the importer items as low priority, not as an
  opportunity.** TV Time shut down on 15 July 2026, the only import path is its own GDPR export
  (`tracking-prod-records-v2.csv`), and TVmaze shipped a dedicated importer for that exact file on
  2 July 2026. Trakt, Simkl and Serializd absorbed the same wave. Anything built now is a late
  entrant serving people who exported months ago and have not yet migrated.
- `100-item third-party 'Physical Library' cap` and the `1000-item list cap` both check out against Trakt's 2026 fair-use-policy changes and forum threads — no issue, just noting these are solid.


## Shipped from this backlog

Items below have been built and tested since the audit was written. They stay in the
tables above for context; this list is the authoritative record of what is done.

| Item | Where |
|---|---|
| Trakt mandatory pagination on every pull path (#1, #2) | `packages/core/src/providers/trakt.ts` `pageAll` |
| Separate read and write pacing per provider (#12, #25) | `packages/core/src/providers/http.ts` `writeMinIntervalMs` |
| Progress planning honours timestamps instead of pushing backward (#24) | `planProgressSync` |
| Simkl history push reads `not_found` back (#21) | `refsRejectedBy` |
| Empty/partial source can never drive a removal (#6) | `planWatchlistSync` empty-source refusal |
| A failing data type no longer discards the rest of the run (#20) | `runSync` per-type isolation |
| Connection flagged for reconnection when credentials are rejected (#7, #14 partial) | `ConnectionService.watchCredentials` |
| Last-run outcome visible per sync (#26) | `LastRunPill` on the syncs page |
| One shared pace per upstream, not one per client (#11) | `packages/core/src/providers/rateGate.ts` |
| Preview goes through the concurrency gate and single-flight lock | `SyncScheduler.previewNow` |
| PMDB resume positions never become invented plays (#9 partial, #10) | `PmdbClient.pushProgress` |
| Provider failures explained in words, not status codes (#13, #29) | `packages/core/src/providers/errors.ts` |
| Credentials redacted out of stored and logged errors | `redactUrl` in `providers/http.ts` |
| Full account data export as JSON (#17) | `packages/server/src/routes/account.ts` |
| A cursor-skipped pull is distinguishable from a quiet one (#18 partial) | `lastPullSkipped` |
| WCAG AA contrast on every text token, checked by test | `packages/web/src/lib/contrast.test.ts` |
| Run status no longer carried by colour alone; live regions on async results | `Syncs.tsx`, error banners |
| Rate limiting on the remaining credential-guessing routes | `routes/auth.ts` |
| Cursors and delivery memory keyed to the resolved remote account | `ConnectionStore.forgetProviderState` |
| Field errors wired to their input (`aria-describedby`/`aria-invalid`) | `Field` context in `ui.tsx` |
| Visible focus on nav and inline links; skip-to-content; 24px tap targets | `Layout.tsx`, `Footer.tsx` |
| Modal traps Tab and returns focus to its opener | `Modal` in `ui.tsx` |
| Per-route `document.title` | `RouteAnnouncer` in `App.tsx` |
| Live regions on every async banner | auth, connections, settings, syncs |
| Failed provider reads no longer read as an empty library | Simkl pull paths |
| Provider deprecation canary: a whole batch with no usable id is called out | `shapeWarning` in `engine.ts` |
| Every write failure carries its reason, not just a count | Simkl, PMDB, MDBList push paths |
| Per-item run detail: which items could not be placed, and their ids (#8) | `ReportedItem` / `SkippedItems` |
| Each run logs which correctness guards were in effect | `guards` in `SyncRunner.logRun` |
| Stalled-sync indicator: flags a scheduled sync that stopped running on time | `isStalled` in `routes/syncs.ts` |
| Id-collision and delivery-memory-survives-full-read invariants pinned | `identity.test.ts`, `runner.logging.test.ts` |
| `LOG_LEVEL` documented in `.env.sample` (it already worked, just undiscoverable) | `.env.sample` |
| Weekly full reconciliation heals a silently-stuck delta cursor (#18) | `SyncRunner.dueForFullReconcile` |
| Email alert on a scheduled sync failing/recovering (transition-based) (#15 partial) | `SyncRunner.maybeAlert` |
| Leaked-credential scrub for historical error rows | migration `0011` |

The accessibility section of this audit is now fully addressed apart from i18n, which the
audit itself argues is not blocking. A Lighthouse navigation audit of the built sign-in page
scores 100 on accessibility, and 25 contrast assertions guard the palette on every build.
| Ratings sync (Trakt <-> Simkl) | `planRatingsSync`, provider `pull/pushRatings` |
| Watchlist sync (Trakt <-> Simkl) | `planWatchlistSync`, provider `pull/push/removeWatchlist` |
| Per-sync scope filters | `packages/core/src/sync/filters.ts` |
| Startup guard for an unusable encryption key | `packages/server/src/db/encryptionKey.ts` |
| Structured per-run logging | `SyncRunner.logRun` |

Two items were already fixed before the audit and are listed in it in error:

- **#19 / #23 Simkl episode non-convergence.** Fixed in v0.4.3 by the `deliveries` table.
  Simkl accepts writes for shows whose seasons it models as separate entries and then never
  echoes them back under the ids the sync reads by, so client-side delivery memory is what
  makes it converge. Verified end to end at the time: run 1 planned 133, run 2 planned 0.
- **#3 Re-run never inflates the target.** Covered by `regressions.test.ts`.

Still open and worth noting:

- **#18's other half: periodic full reconciliation.** A skipped pull is now visible in the run
  report, so a stuck cursor can be seen. Deciding how often to ignore the cursor and re-read
  everything anyway is a behaviour choice and has not been made.
- **Rows written to `sync_runs.error` before the redaction fix** may still contain an MDBList
  API key, because that provider authenticates by query parameter and the old error message
  embedded the full URL. New rows are safe; old ones have not been touched.

- **#9 `/scrobble/pause` on a cold item.** Trakt's contract documents `/scrobble/stop` as
  scrobbling a play above 80% and saving a resume position between 1% and 79%; `/scrobble/pause`
  is documented only as pausing an *active* scrobble. Whether a cold pause persists a position
  needs a live account to settle, so the current behaviour is unchanged.
- **Proactive notification of a dead connection.** The state is now detected and shown in the UI;
  emailing or webhooking it is a separate decision about unsolicited messaging.

## Method notes and raw data

- Scoring checked each finding against a generated map of the whole codebase (every source file,
  exported symbol, API route, database table, environment variable, web page and dependency) rather
  than each agent exploring the repository independently.
- Findings marked `unverified` in the raw data are ones the researching agent could not confirm from
  a primary source. They were kept because they are still worth checking, not because they are true.
- Raw research output (739 findings with their source URLs) and the 565 scored items live at
  `/home/ubuntu/watchbridge-audit-raw/` on the build host. They are not committed because they are
  large and mostly redundant once merged into the sections above.
- Coverage by topic is even. All sixteen research topics contributed scored items, ranging from 17
  (Simkl's own product, most of whose findings merged into other topics) to 51 (the list ecosystem,
  and the cross-cutting defect catalogue). Letterboxd appears in 15 items and IMDb in 14.
- Two real gaps, both since addressed in the sections above: accessibility had zero coverage in the
  first pass because no research topic asked for it, and internationalisation had none either.
