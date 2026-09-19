import { expect, test } from 'vitest';
import { buildTags, parseTags } from '../src/tags';

test('buildTags emits one tag per known field', () => {
  expect(buildTags({ hebitsId: '12345', imdb: 'tt1234567' })).toEqual(['hebits:12345', 'imdb:tt1234567']);
});

test('buildTags omits missing fields', () => {
  expect(buildTags({ hebitsId: '12345' })).toEqual(['hebits:12345']);
  expect(buildTags({ imdb: 'tt1' })).toEqual(['imdb:tt1']);
  expect(buildTags({})).toEqual([]);
});

// qBittorrent returns tags joined with a comma AND a space.
test('parseTags reads qBittorrent formatting', () => {
  expect(parseTags('hebits:99999, imdb:tt9999999')).toEqual({ hebitsId: '99999', imdb: 'tt9999999' });
});

test('parseTags tolerates absent, partial and foreign tags', () => {
  expect(parseTags('')).toEqual({});
  expect(parseTags(undefined)).toEqual({});
  expect(parseTags('hebits:1')).toEqual({ hebitsId: '1' });
  expect(parseTags('someone-elses-tag, imdb:tt7')).toEqual({ imdb: 'tt7' });
  expect(parseTags('malformed,,  , hebits:2')).toEqual({ hebitsId: '2' });
});

test('parseTags keeps the last value when a key repeats', () => {
  expect(parseTags('imdb:tt1, imdb:tt2')).toEqual({ imdb: 'tt2' });
});
