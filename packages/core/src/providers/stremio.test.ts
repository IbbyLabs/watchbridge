import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StremioClient,
  StremioLinkPending,
  StremioSessionInvalid,
  WatchedBitfieldError,
  decodeWatchedField,
  orderVideos,
} from './stremio.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Encode like stremio-watched-bitfield's `serialize`: anchor on the last watched video. */
function encode(bits: boolean[], videoIds: string[]): string {
  const values = Buffer.alloc(Math.ceil(videoIds.length / 8));
  bits.forEach((on, i) => {
    if (on) values[i >> 3]! |= 1 << (i & 7);
  });
  const last = Math.max(0, bits.lastIndexOf(true));
  return `${videoIds[last]}:${last + 1}:${deflateSync(values).toString('base64')}`;
}

const ids = (n: number, show = 'tt0001'): string[] =>
  Array.from({ length: n }, (_, i) => `${show}:1:${i + 1}`);

const bitsOf = (set: Set<number>, n: number): boolean[] =>
  Array.from({ length: n }, (_, i) => set.has(i));

describe('decodeWatchedField', () => {
  // From stremio-core's own test `parse_and_modify`
  // (stremio-watched-bitfield/src/watched_bitfield.rs): the first five of nine videos.
  it('reads the fixture from stremio-core', () => {
    const videos = Array.from({ length: 9 }, (_, i) => `tt2934286:1:${i + 1}`);
    const watched = decodeWatchedField('tt2934286:1:5:5:eJyTZwAAAEAAIA==', videos);
    expect([...watched]).toEqual([0, 1, 2, 3, 4]);
  });

  it('round-trips an arbitrary pattern', () => {
    const videos = ids(40);
    const bits = videos.map((_, i) => i % 3 === 0 || i === 39);
    expect(bitsOf(decodeWatchedField(encode(bits, videos), videos), 40)).toEqual(bits);
  });

  it('numbers bits from the least significant bit of each byte', () => {
    const videos = ids(8);
    // 0b00000101 marks videos 1 and 3 (indexes 0 and 2); anchor is index 2.
    const field = `${videos[2]}:3:${deflateSync(Buffer.from([0b00000101])).toString('base64')}`;
    expect([...decodeWatchedField(field, videos)]).toEqual([0, 2]);
  });

  it('keeps indexes when the list grows after the anchor', () => {
    const before = ids(10);
    const bits = before.map((_, i) => i < 4);
    const after = ids(14);
    expect([...decodeWatchedField(encode(bits, before), after)]).toEqual([0, 1, 2, 3]);
  });

  it('realigns when episodes are inserted before the anchor', () => {
    const before = ids(6);
    const bits = [true, false, true, false, true, false];
    // Three new videos appear in front: the anchor moves from index 4 to index 7.
    const after = ['x:1', 'y:1', 'z:1', ...before];
    expect([...decodeWatchedField(encode(bits, before), after)]).toEqual([3, 5, 7]);
  });

  it('realigns when episodes are removed before the anchor', () => {
    const before = ids(6);
    const bits = [true, true, false, true, false, true];
    const after = before.slice(2);
    expect([...decodeWatchedField(encode(bits, before), after)]).toEqual([1, 3]);
  });

  it('rejects an anchor that is not in the list', () => {
    const field = encode([true, true], ids(2));
    expect(() => decodeWatchedField(field, ids(2, 'tt9999'))).toThrow(WatchedBitfieldError);
    try {
      decodeWatchedField(field, ids(2, 'tt9999'));
    } catch (err) {
      expect((err as WatchedBitfieldError).reason).toBe('anchor_not_found');
    }
  });

  it('rejects an empty video list, which stremio-core serialises with an undefined anchor', () => {
    expect(() => decodeWatchedField('undefined:1:eJwDAAAAAAE=', [])).toThrow(/anchor_not_found/);
  });

  it('rejects a field with too few parts', () => {
    expect(() => decodeWatchedField('tt1:5', ids(3))).toThrow(/malformed/);
  });

  it('rejects a non-numeric anchor length', () => {
    expect(() => decodeWatchedField('tt0001:1:x:abc', ids(3))).toThrow(/malformed/);
  });

  it('rejects a payload that is not zlib data', () => {
    const videos = ids(3);
    expect(() => decodeWatchedField(`${videos[0]}:1:bm90LXpsaWI=`, videos)).toThrow(/undecodable/);
  });
});

describe('orderVideos', () => {
  it('sorts by season, then episode, with specials first and a stable tie-break', () => {
    const v = (id: string, season?: number, episode?: number, released?: string) => ({
      id,
      season,
      episode,
      released,
    });
    const sorted = orderVideos([
      v('s2e1', 2, 1),
      v('s1e2', 1, 2),
      v('s0e1', 0, 1),
      v('s1e1b', 1, 1, '2020-02-01T00:00:00.000Z'),
      v('s1e1a', 1, 1, '2020-01-01T00:00:00.000Z'),
      v('bare'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['bare', 's0e1', 's1e1a', 's1e1b', 's1e2', 's2e1']);
  });
});

/** A library entry as api.strem.io returns one. */
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'tt0133093',
    name: 'The Matrix',
    type: 'movie',
    removed: false,
    temp: false,
    state: { timesWatched: 1, lastWatched: '2026-01-02T03:04:05.000Z' },
    ...over,
  };
}

interface Video {
  id: string;
  season: number;
  episode: number;
  released?: string | null;
}

const video = (imdb: string, season: number, episode: number, released?: string | null): Video => ({
  id: `${imdb}:${season}:${episode}`,
  season,
  episode,
  released,
});

/** A series entry whose watched episodes are the given indexes of `videos`. */
function series(
  imdb: string,
  videos: Video[],
  watched: number[],
  lastWatched: string | null,
  over = {},
) {
  const sorted = orderVideos(videos);
  const bits = sorted.map((_, i) => watched.includes(i));
  return item({
    _id: imdb,
    name: `Show ${imdb}`,
    type: 'series',
    state: {
      timesWatched: 0,
      lastWatched,
      watched: encode(
        bits,
        sorted.map((s) => s.id!),
      ),
    },
    ...over,
  });
}

interface Calls {
  urls: string[];
  bodies: unknown[];
}

function stubStremio(
  libraryItems: Array<Record<string, unknown>>,
  metas: Record<string, Video[] | number> = {},
): Calls {
  const calls: Calls = { urls: [], bodies: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.urls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.body) calls.bodies.push(JSON.parse(init.body as string));
      if (url.includes('api.strem.io')) return json({ result: libraryItems });
      const imdb = /series\/(tt\d+)\.json/.exec(url)?.[1] ?? '';
      const meta = metas[imdb];
      if (typeof meta === 'number') return json({}, meta);
      return json({ meta: { videos: meta ?? [] } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('StremioClient pairing', () => {
  it('asks Stremio for a link code and reports where to approve it', async () => {
    const fetchMock = vi.fn(async () =>
      json({ result: { code: 'O6MN', link: 'https://link.stremio.com/O6MN', qrcode: 'x' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const code = await StremioClient.startLink();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('link.stremio.com/api/v2/create');
    expect(code.userCode).toBe('O6MN');
    expect(code.verificationUrl).toBe('https://link.stremio.com/O6MN');
  });

  it('returns the session key once the code is approved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ result: { authKey: 'sess-123' } })),
    );
    expect(await StremioClient.completeLink('O6MN')).toBe('sess-123');
  });

  it('reports an unapproved code as pending rather than failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 101, message: 'Invalid or expired token' } })),
    );
    await expect(StremioClient.completeLink('O6MN')).rejects.toBeInstanceOf(StremioLinkPending);
  });

  it('never sends a password or email', async () => {
    const fetchMock = vi.fn(async () => json({ result: { authKey: 'sess-123' } }));
    vi.stubGlobal('fetch', fetchMock);
    await StremioClient.startLink().catch(() => undefined);
    await StremioClient.completeLink('O6MN');
    const sent = JSON.stringify(fetchMock.mock.calls);
    expect(sent).not.toContain('password');
    expect(sent).not.toContain('email');
  });
});

describe('StremioClient session', () => {
  it('raises StremioSessionInvalid when Stremio rejects the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 1, message: 'Session does not exist' } })),
    );
    await expect(new StremioClient('bad').pullHistory()).rejects.toBeInstanceOf(
      StremioSessionInvalid,
    );
  });

  it('validate is false for a dead session and true for a live one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 1, message: 'Session does not exist' } })),
    );
    expect(await new StremioClient('bad').validate()).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ result: [] })),
    );
    expect(await new StremioClient('good').validate()).toBe(true);
  });

  it('does not call another error a dead session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 7, message: 'Try later' } })),
    );
    const err = await new StremioClient('k').pullHistory().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StremioSessionInvalid);
  });

  it('is read-only: it advertises history only', () => {
    const caps = new StremioClient('k').capabilities();
    expect(caps).toEqual({
      history: true,
      progress: false,
      ratings: false,
      watchlist: false,
      datedHistory: false,
    });
    expect('pushHistory' in new StremioClient('k')).toBe(false);
  });
});

describe('StremioClient.pullHistory movies', () => {
  it('emits one dated event per watched movie and ignores the rest', async () => {
    stubStremio([
      item({ _id: 'tt1' }),
      item({ _id: 'tt2', state: { timesWatched: 0, lastWatched: '2026-01-01T00:00:00.000Z' } }),
      item({ _id: 'tt3', removed: true, state: { timesWatched: 1, lastWatched: '2026-02-01T00:00:00.000Z' } }),
      item({ _id: 'tt4', type: 'other' }),
      item({ _id: 'kitsu:1', type: 'movie' }),
      item({ _id: 'tt5', state: { timesWatched: 1 } }),
      item({ _id: 'tt6', type: 'tv' }),
    ]);
    const events = await new StremioClient('k').pullHistory();
    expect(events).toEqual([
      {
        ref: { kind: 'movie', ids: { imdb: 'tt1' }, title: 'The Matrix' },
        watchedAt: '2026-01-02T03:04:05.000Z',
      },
      // Played without being saved: Stremio stores it as removed.
      {
        ref: { kind: 'movie', ids: { imdb: 'tt3' }, title: 'The Matrix' },
        watchedAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('sends the key only in the body of the library request', async () => {
    const calls = stubStremio([]);
    await new StremioClient('secret-key').pullHistory();
    expect(calls.urls).toEqual(['POST https://api.strem.io/api/datastoreGet']);
    expect(JSON.stringify(calls.urls)).not.toContain('secret-key');
    expect(calls.bodies[0]).toMatchObject({ authKey: 'secret-key', collection: 'libraryItem' });
  });
});

describe('StremioClient.pullHistory series', () => {
  const imdb = 'tt0903747';
  const eps = [
    video(imdb, 1, 1, '2008-01-20T00:00:00.000Z'),
    video(imdb, 1, 2, '2008-01-27T00:00:00.000Z'),
    video(imdb, 1, 3, '2008-02-10T00:00:00.000Z'),
    video(imdb, 2, 1, '2009-03-08T00:00:00.000Z'),
  ];

  it('emits one episode per watched bit, never a whole show', async () => {
    stubStremio([series(imdb, eps, [0, 1, 3], '2026-05-01T00:00:00.000Z')], { [imdb]: eps });
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => [e.ref.kind, e.ref.season, e.ref.number])).toEqual([
      ['episode', 1, 1],
      ['episode', 1, 2],
      ['episode', 2, 1],
    ]);
    expect(events.every((e) => e.ref.ids.imdb === imdb)).toBe(true);
  });

  it('dates each episode by its release', async () => {
    stubStremio([series(imdb, eps, [0, 2], '2026-05-01T00:00:00.000Z')], { [imdb]: eps });
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => e.watchedAt)).toEqual([
      '2008-01-20T00:00:00.000Z',
      '2008-02-10T00:00:00.000Z',
    ]);
  });

  it('clamps a release date that is later than the last watch', async () => {
    stubStremio([series(imdb, eps, [0, 3], '2008-06-01T00:00:00.000Z')], { [imdb]: eps });
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => e.watchedAt)).toEqual([
      '2008-01-20T00:00:00.000Z',
      '2008-06-01T00:00:00.000Z',
    ]);
  });

  it('falls back to the last watch when the release is missing or unparseable', async () => {
    const odd = [
      video(imdb, 1, 1, null),
      video(imdb, 1, 2, 'soon'),
      video(imdb, 1, 3, '2008-02-10T00:00:00.000Z'),
    ];
    stubStremio([series(imdb, odd, [0, 1, 2], '2026-05-01T00:00:00.000Z')], { [imdb]: odd });
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => e.watchedAt)).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2008-02-10T00:00:00.000Z',
    ]);
  });

  it('uses the release date when the last watch is missing, and skips when both are', async () => {
    const odd = [video(imdb, 1, 1, '2008-01-20T00:00:00.000Z'), video(imdb, 1, 2, null)];
    stubStremio([series(imdb, odd, [0, 1], null)], { [imdb]: odd });
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => [e.ref.number, e.watchedAt])).toEqual([
      [1, '2008-01-20T00:00:00.000Z'],
    ]);
  });

  it('never emits an undated episode', async () => {
    stubStremio([series(imdb, eps, [0, 1, 2, 3], '2026-05-01T00:00:00.000Z')], { [imdb]: eps });
    const events = await new StremioClient('k').pullHistory();
    expect(events.every((e) => typeof e.watchedAt === 'string')).toBe(true);
  });

  it('skips a series without a watched field', async () => {
    stubStremio(
      [
        item({
          _id: imdb,
          type: 'series',
          state: {
            timesWatched: 3,
            lastWatched: '2026-05-01T00:00:00.000Z',
            video_id: 'tt0903747:5:1',
          },
        }),
      ],
      { [imdb]: eps },
    );
    expect(await new StremioClient('k').pullHistory()).toEqual([]);
  });

  it('skips a series whose bitfield cannot be decoded', async () => {
    stubStremio(
      [
        item({
          _id: imdb,
          type: 'series',
          state: { lastWatched: '2026-05-01T00:00:00.000Z', watched: 'garbage' },
        }),
      ],
      { [imdb]: eps },
    );
    expect(await new StremioClient('k').pullHistory()).toEqual([]);
  });

  it('skips a series whose anchor is not in Cinemeta', async () => {
    const other = [video(imdb, 1, 1), video(imdb, 1, 2)];
    const stale = series(imdb, eps, [3], '2026-05-01T00:00:00.000Z');
    stubStremio([stale], { [imdb]: other });
    expect(await new StremioClient('k').pullHistory()).toEqual([]);
  });

  it('keeps going when Cinemeta fails for one series', async () => {
    const good = 'tt0111161';
    const goodEps = [video(good, 1, 1, '2001-01-01T00:00:00.000Z')];
    stubStremio(
      [
        series(imdb, eps, [0], '2026-05-01T00:00:00.000Z'),
        series(good, goodEps, [0], '2026-05-01T00:00:00.000Z'),
      ],
      { [imdb]: 404, [good]: goodEps },
    );
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => e.ref.ids.imdb)).toEqual([good]);
  });

  it('asks Cinemeta once per series and never writes anywhere', async () => {
    const calls = stubStremio([series(imdb, eps, [0, 1], '2026-05-01T00:00:00.000Z')], {
      [imdb]: eps,
    });
    await new StremioClient('k').pullHistory();
    const cinemeta = calls.urls.filter((u) => u.includes('cinemeta'));
    expect(cinemeta).toEqual([`GET https://v3-cinemeta.strem.io/meta/series/${imdb}.json`]);
    expect(calls.urls.filter((u) => u.startsWith('POST') && !u.includes('datastoreGet'))).toEqual(
      [],
    );
  });

  it('includes season 0 specials only when the bitfield says they were watched', async () => {
    const withSpecial = [video(imdb, 0, 1, '2007-01-01T00:00:00.000Z'), ...eps];
    stubStremio([series(imdb, withSpecial, [0, 1], '2026-05-01T00:00:00.000Z')], {
      [imdb]: withSpecial,
    });
    const events = await new StremioClient('k').pullHistory();
    expect(events.map((e) => [e.ref.season, e.ref.number])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
});
