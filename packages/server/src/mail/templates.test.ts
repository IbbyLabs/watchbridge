import { describe, expect, it } from 'vitest';
import { syncFailureEmail, syncRecoveryEmail } from './templates.js';

describe('sync alert emails', () => {
  it('names the sync and carries the reason', () => {
    const email = syncFailureEmail('Watchbridge', {
      syncName: 'Trakt to Simkl',
      reason: 'Simkl no longer accepts this sign-in. Connect the account again.',
      syncsUrl: 'https://wb.example/syncs',
    });
    expect(email.subject).toContain('Trakt to Simkl');
    expect(email.html).toContain('Connect the account again');
    expect(email.text).toContain('Connect the account again');
    expect(email.html).toContain('https://wb.example/syncs');
  });

  it('escapes a sync name so it cannot inject markup into the email', () => {
    const email = syncFailureEmail('Watchbridge', {
      syncName: '<img src=x onerror=alert(1)>',
      reason: 'boom',
      syncsUrl: 'https://wb.example/syncs',
    });
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img src=x');
  });

  it('recovery email is short and points at the syncs page', () => {
    const email = syncRecoveryEmail('Watchbridge', {
      syncName: 'Trakt to Simkl',
      syncsUrl: 'https://wb.example/syncs',
    });
    expect(email.subject).toMatch(/working again/);
    expect(email.text).toContain('https://wb.example/syncs');
  });
});
