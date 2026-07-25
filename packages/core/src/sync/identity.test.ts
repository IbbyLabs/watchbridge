import { describe, expect, it } from 'vitest';
import { hasIdentity, idStrings, itemKey, MatchIndex } from './identity.js';
import type { MediaRef } from '../providers/types.js';

const ep = (extra: Partial<MediaRef> = {}): MediaRef => ({
  kind: 'episode',
  ids: { tmdb: 1399 },
  ...extra,
});

describe('episode identity requires a season and an episode number', () => {
  it('gives an episode with no season or number no identity at all', () => {
    expect(idStrings(ep())).toEqual([]);
    expect(itemKey(ep())).toBeNull();
    expect(hasIdentity(ep())).toBe(false);
  });

  it('gives no identity when only one of the two is present', () => {
    expect(hasIdentity(ep({ season: 1 }))).toBe(false);
    expect(hasIdentity(ep({ number: 3 }))).toBe(false);
  });

  it('does not let two different episodes of one show collide on a wildcard key', () => {
    const a = ep({ title: 'Something' });
    const b = ep({ title: 'Something else' });

    // Neither is identifiable, so neither may be mistaken for the other.
    expect(MatchIndex.from([a]).has(b)).toBe(false);
  });

  it('still identifies specials, where season 0 is a real value', () => {
    const special = ep({ season: 0, number: 1 });

    expect(hasIdentity(special)).toBe(true);
    expect(itemKey(special)).toBe('episode:tmdb:1399:s0:e1');
  });

  it('treats episode number 0 as a real value too', () => {
    expect(itemKey(ep({ season: 1, number: 0 }))).toBe('episode:tmdb:1399:s1:e0');
  });

  it('keeps distinct episodes distinct', () => {
    expect(MatchIndex.from([ep({ season: 1, number: 1 })]).has(ep({ season: 1, number: 2 }))).toBe(
      false,
    );
    expect(MatchIndex.from([ep({ season: 1, number: 1 })]).has(ep({ season: 1, number: 1 }))).toBe(
      true,
    );
  });

  it('leaves movies and whole-show markers unaffected', () => {
    expect(itemKey({ kind: 'movie', ids: { tmdb: 550 } })).toBe('movie:tmdb:550');
    expect(itemKey({ kind: 'show', ids: { tmdb: 1399 } })).toBe('show:tmdb:1399');
  });

  it('counts an unplaceable episode as present when the whole show is marked watched', () => {
    // The series being complete on the target makes this genuinely true, and there
    // is no season/number to push anyway, so this is a skip rather than a guess.
    const index = MatchIndex.from([{ kind: 'show', ids: { tmdb: 1399 } }]);

    expect(index.has(ep())).toBe(true);
  });

  it('does not count an unplaceable episode as present from a sibling episode', () => {
    // Another episode of the same show says nothing about this one.
    const index = MatchIndex.from([ep({ season: 4, number: 2 })]);

    expect(index.has(ep())).toBe(false);
  });
});


describe('an item with no usable id never collides with another', () => {
  const idless = (kind: MediaRef['kind'], extra: Partial<MediaRef> = {}): MediaRef => ({
    kind,
    ids: {},
    ...extra,
  });

  it('gives an id-less movie no identity and no key', () => {
    const movie = idless('movie', { title: 'Some Film' });
    expect(hasIdentity(movie)).toBe(false);
    expect(itemKey(movie)).toBeNull();
    expect(idStrings(movie)).toEqual([]);
  });

  it('does not match two distinct id-less movies to each other', () => {
    const a = idless('movie', { title: 'Film A', year: 1999 });
    const b = idless('movie', { title: 'Film B', year: 2001 });
    expect(MatchIndex.from([a]).has(b)).toBe(false);
    // Not even against itself, because it carries nothing to match on.
    expect(MatchIndex.from([a]).has(a)).toBe(false);
  });

  it('does not match id-less items across kinds', () => {
    const movie = idless('movie', { title: 'X' });
    const show = idless('show', { title: 'X' });
    const episode = idless('episode', { title: 'X', season: 1, number: 1 });
    expect(MatchIndex.from([movie]).has(show)).toBe(false);
    expect(MatchIndex.from([show]).has(episode)).toBe(false);
    expect(MatchIndex.from([episode]).has(movie)).toBe(false);
  });

  it('keys different kinds that share a raw id value distinctly', () => {
    // A movie and a show that happen to reuse tmdb 550 must not be confused.
    expect(itemKey({ kind: 'movie', ids: { tmdb: 550 } })).not.toBe(
      itemKey({ kind: 'show', ids: { tmdb: 550 } }),
    );
    expect(MatchIndex.from([{ kind: 'movie', ids: { tmdb: 550 } }]).has({ kind: 'show', ids: { tmdb: 550 } })).toBe(
      false,
    );
  });

  it('does not treat a blank string or zero id as a usable id', () => {
    expect(hasIdentity({ kind: 'movie', ids: { imdb: '', slug: '' } })).toBe(false);
    expect(MatchIndex.from([{ kind: 'movie', ids: { imdb: '' } }]).has({ kind: 'movie', ids: { imdb: '' } })).toBe(
      false,
    );
  });
});
