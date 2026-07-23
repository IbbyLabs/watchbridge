import { describe, expect, it } from 'vitest';
import { includedByFilters } from './filters.js';
import type { MediaRef } from '../providers/types.js';

const movie = (tmdb = 550): MediaRef => ({ kind: 'movie', ids: { tmdb } });
const episode = (season: number, number = 1, tmdb = 1399): MediaRef => ({
  kind: 'episode',
  ids: { tmdb },
  season,
  number,
});
const show = (tmdb = 1399): MediaRef => ({ kind: 'show', ids: { tmdb } });

describe('includedByFilters', () => {
  it('includes everything when no filters are set', () => {
    expect(includedByFilters(movie(), undefined)).toBe(true);
    expect(includedByFilters(episode(0), undefined)).toBe(true);
    expect(includedByFilters(show(), {})).toBe(true);
  });

  it('drops movies when movies are turned off', () => {
    expect(includedByFilters(movie(), { movies: false })).toBe(false);
    expect(includedByFilters(episode(1), { movies: false })).toBe(true);
  });

  it('drops episodes and show markers when shows are turned off', () => {
    expect(includedByFilters(episode(1), { shows: false })).toBe(false);
    expect(includedByFilters(show(), { shows: false })).toBe(false);
    expect(includedByFilters(movie(), { shows: false })).toBe(true);
  });

  it('drops season-0 specials only when asked to', () => {
    expect(includedByFilters(episode(0), { excludeSpecials: true })).toBe(false);
    expect(includedByFilters(episode(1), { excludeSpecials: true })).toBe(true);
    // A regular season is never treated as a special.
    expect(includedByFilters(episode(0), {})).toBe(true);
  });

  it('excludes a title that shares any id with an exclude entry', () => {
    const filters = { exclude: [{ tmdb: 78173 }] };
    expect(includedByFilters({ kind: 'episode', ids: { tmdb: 78173 }, season: 1, number: 1 }, filters)).toBe(false);
    expect(includedByFilters({ kind: 'show', ids: { tmdb: 78173 } }, filters)).toBe(false);
    expect(includedByFilters(movie(550), filters)).toBe(true);
  });

  it('matches an exclude entry across different id types', () => {
    const filters = { exclude: [{ imdb: 'tt0903747' }] };
    expect(includedByFilters({ kind: 'movie', ids: { imdb: 'tt0903747', tmdb: 1396 } }, filters)).toBe(false);
  });

  it('combines rules: an excluded special is dropped for either reason', () => {
    const filters = { excludeSpecials: true, exclude: [{ tmdb: 78173 }] };
    expect(includedByFilters(episode(0, 1, 78173), filters)).toBe(false);
  });
});
