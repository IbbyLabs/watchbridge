import { describe, expect, it } from 'vitest';
import { HttpError, redactUrl } from './http.js';
import { describeProviderError, isRetryable } from './errors.js';

describe('redactUrl', () => {
  it('replaces a credential passed as a query parameter', () => {
    const out = redactUrl('https://api.mdblist.com/sync/watched?apikey=super-secret&page=2');
    expect(out).not.toContain('super-secret');
    expect(out).toContain('apikey=redacted');
    expect(out).toContain('page=2');
  });

  it('covers the other names credentials travel under', () => {
    for (const name of ['api_key', 'token', 'access_token', 'client_secret', 'password']) {
      expect(redactUrl(`https://x/y?${name}=leakme`)).not.toContain('leakme');
    }
  });

  it('is case-insensitive about the parameter name', () => {
    expect(redactUrl('https://x/y?ApiKey=leakme')).not.toContain('leakme');
  });

  it('drops the whole query when the URL cannot be parsed', () => {
    expect(redactUrl('not a url?apikey=leakme')).toBe('not a url?redacted');
  });

  it('leaves an innocent URL alone', () => {
    const url = 'https://api.trakt.tv/sync/history/movies?page=1&limit=100';
    expect(redactUrl(url)).toBe(url);
  });
});

describe('HttpError never carries a credential', () => {
  it('keeps the key out of the message and the url', () => {
    const err = new HttpError(401, '', 'https://api.mdblist.com/sync/watched?apikey=super-secret');
    expect(err.message).not.toContain('super-secret');
    expect(err.url).not.toContain('super-secret');
  });
});

describe('describeProviderError', () => {
  const at = (status: number) => new HttpError(status, '', 'https://api.trakt.tv/sync/history');

  it('explains a locked account instead of printing 423', () => {
    const msg = describeProviderError('trakt', at(423));
    expect(msg).not.toMatch(/423/);
    expect(msg).toMatch(/locked/i);
    expect(msg).toMatch(/Trakt/);
  });

  it('explains an account limit', () => {
    expect(describeProviderError('trakt', at(420))).toMatch(/limit/i);
  });

  it('tells the user to reconnect on 401', () => {
    expect(describeProviderError('simkl', at(401))).toMatch(/Connect the account again/);
  });

  it('names the provider the user knows', () => {
    expect(describeProviderError('pmdb', at(404))).toMatch(/PublicMetaDB/);
    expect(describeProviderError('mdblist', at(404))).toMatch(/MDBList/);
  });

  it('describes a server-side problem as temporary', () => {
    expect(describeProviderError('trakt', at(503))).toMatch(/their end/);
  });

  it('handles a plain network failure', () => {
    expect(describeProviderError('trakt', new Error('fetch failed'))).toMatch(/could not be reached/);
  });

  it('does not leak a credential through the fallback path', () => {
    const err = new HttpError(418, '', 'https://api.mdblist.com/x?apikey=super-secret');
    expect(describeProviderError('mdblist', err)).not.toContain('super-secret');
  });
});

describe('isRetryable', () => {
  it('retries rate limits and server errors', () => {
    expect(isRetryable(new HttpError(429, '', 'https://x'))).toBe(true);
    expect(isRetryable(new HttpError(503, '', 'https://x'))).toBe(true);
  });

  it('does not retry a permanent rejection', () => {
    for (const status of [400, 401, 403, 420, 422, 423]) {
      expect(isRetryable(new HttpError(status, '', 'https://x'))).toBe(false);
    }
  });

  it('retries a network failure', () => {
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
  });
});
