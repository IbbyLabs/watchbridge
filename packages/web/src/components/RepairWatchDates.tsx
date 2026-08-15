import { useState } from 'react';
import { api } from '../lib/api.ts';
import { Button, Card } from './ui.tsx';

/**
 * The one-time repair for history we sent with the wrong watch date.
 *
 * It removes entries from the person's history before putting them back, so it
 * shows what it would do before doing anything, and nothing happens until they
 * press the second button.
 */

interface Plan {
  syncId: string;
  name: string;
  target: string;
  unidentifiable: boolean;
  counts: {
    delivered: number;
    examined: number;
    candidates: number;
    repaired: number;
    skipped: number;
    failed: number;
    remaining: number;
    stoppedBecause?: string;
  };
}

interface Answer {
  plans?: Plan[];
  results?: Plan[];
  /** Corrections the last call did not reach. Zero means it is finished. */
  remaining?: number;
  explanation: string[];
}

export function RepairWatchDates() {
  const [checked, setChecked] = useState<Answer | null>(null);
  const [done, setDone] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const plans = checked?.plans ?? [];
  const toFix = plans.reduce((n, p) => n + p.counts.candidates, 0);
  const anyUnidentifiable = plans.some((p) => p.unidentifiable);

  const check = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setChecked(await api.get<Answer>('/api/repair/watch-dates'));
    } catch {
      setError('Could not check your history. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Each call corrects a bounded number and says what is left, because the whole
   * repair cannot fit inside one request — Simkl accepts about one write a
   * second, and a large history would outlast any proxy between here and the
   * server. So this asks repeatedly until nothing is left.
   */
  const run = async () => {
    setBusy(true);
    setError(null);
    let corrected = 0;
    try {
      for (;;) {
        const answer = await api.post<Answer>('/api/repair/watch-dates');
        corrected += (answer.results ?? []).reduce((n, r) => n + r.counts.repaired, 0);
        setProgress(corrected);
        setDone(answer);
        setChecked(null);
        const stopped = (answer.results ?? []).some((r) => r.counts.stoppedBecause);
        if (stopped || !answer.remaining) break;

        // A chunk that corrected nothing, reported no reason, and still claims
        // work remains would loop forever. Nothing in the server does that
        // today; this stops the case neither of us has thought of, because the
        // loop writes to somebody's history.
        const movedThisChunk = (answer.results ?? []).reduce((n, r) => n + r.counts.repaired, 0);
        if (movedThisChunk === 0) {
          setError(
            `Stopped after correcting ${corrected}. The last attempt changed nothing and did not say why — ` +
              `nothing further was tried.`,
          );
          break;
        }
      }
    } catch {
      setError(
        corrected > 0
          ? `Stopped after correcting ${corrected}. The rest are untouched — press it again to carry on.`
          : 'Could not start. Nothing was changed — try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-ink">Watch dates</h2>
      <Card className="p-5">
        <p className="text-sm text-muted">
          History sent to Simkl and MDBList used to arrive dated the day it was imported rather than
          the day you watched it. That is fixed for anything sent from now on. This corrects what was
          already sent, using our record of what we sent you and when — anything dated outside that
          is left alone, because it is a watch you really had.
        </p>

        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}

        {checked && (
          <div className="mt-4 text-sm text-ink">
            {checked.explanation.map((line) => (
              <p key={line} className="mt-2 text-muted">
                {line}
              </p>
            ))}
            {toFix > 0 && (
              <p className="mt-3">
                {toFix} {toFix === 1 ? 'date needs' : 'dates need'} correcting. On Simkl this means
                removing each one and adding it back, because Simkl will not change a date in place.
              </p>
            )}
          </div>
        )}

        {busy && progress > 0 && (
          <p className="mt-4 text-sm text-muted">{progress} corrected so far…</p>
        )}

        {done && (
          <div className="mt-4 text-sm">
            {done.explanation.map((line) => (
              <p key={line} className="mt-2 text-muted">
                {line}
              </p>
            ))}
          </div>
        )}

        <div className="mt-4 flex gap-3">
          <Button variant="secondary" loading={busy} onClick={check}>
            Check my history
          </Button>
          {toFix > 0 && !anyUnidentifiable && (
            <Button loading={busy} onClick={run}>
              Correct {toFix} {toFix === 1 ? 'date' : 'dates'}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}
