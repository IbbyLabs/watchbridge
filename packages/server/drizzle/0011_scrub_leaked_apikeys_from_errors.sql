-- One-time data scrub. Before credentials were redacted from HTTP error messages,
-- a failed MDBList write (MDBList authenticates with an `?apikey=` query parameter)
-- could store the full URL, and therefore the key, in `sync_runs.error`. New rows
-- are already safe; this clears the reason on any historical row that carries the
-- pattern. Idempotent: a second run matches nothing.
UPDATE "sync_runs"
SET "error" = 'A write failed. The original message was cleared because it contained a credential.'
WHERE "error" LIKE '%apikey=%';
