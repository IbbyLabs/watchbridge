import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { Card } from './ui.tsx';

/**
 * Points somebody at the watch-date repair, which otherwise waits on Settings
 * for a person who has no reason to look there.
 *
 * The condition is deliberately necessary rather than sufficient: it asks
 * whether we have ever delivered history to a provider that took the wrong
 * date, which costs one indexed row. Counting what is actually wrong pulls both
 * accounts in full from the providers, which is far too much for a page load.
 * So this offers the check rather than answering it, and somebody with nothing
 * to fix presses once and never sees it again.
 */

const DISMISSED = 'watchbridge.watch-dates-notice.dismissed';

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED) === 'yes';
  } catch {
    // A browser refusing storage should still see the notice, not crash.
    return false;
  }
}

export function WatchDatesNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (wasDismissed()) return;
    void api
      .get<{ relevant: boolean }>('/api/repair/watch-dates/relevant')
      .then((r) => setShow(r.relevant))
      // An older server has no such route, and a notice is not worth an error.
      .catch(() => setShow(false));
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try {
      window.localStorage.setItem(DISMISSED, 'yes');
    } catch {
      // Then it comes back next visit, which is the harmless direction.
    }
  };

  return (
    <Card className="mb-6 p-4 text-sm">
      <p className="text-ink">
        History we sent to Simkl or MDBList before August may carry the date it was sent rather
        than the date you watched it.
      </p>
      <p className="mt-1 text-muted">
        Syncing again will not put it right — Simkl treats a repeat as nothing to do. There is a
        one-off repair that can.
      </p>
      <div className="mt-3 flex gap-4">
        <Link className="font-medium text-brand-ink hover:underline" to="/settings">
          Check my watch dates
        </Link>
        <button className="text-muted hover:underline" type="button" onClick={dismiss}>
          Not now
        </button>
      </div>
    </Card>
  );
}
