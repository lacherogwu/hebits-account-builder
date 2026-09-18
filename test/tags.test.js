import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTags, parseTags } from '../lib/tags.js';

test('buildTags emits one tag per known field', () => {
  assert.deepEqual(buildTags({ hebitsId: '12345', imdb: 'tt1234567' }), ['hebits:12345', 'imdb:tt1234567']);
});

test('buildTags omits missing fields', () => {
  assert.deepEqual(buildTags({ hebitsId: '12345' }), ['hebits:12345']);
  assert.deepEqual(buildTags({ imdb: 'tt1' }), ['imdb:tt1']);
  assert.deepEqual(buildTags({}), []);
});

// qBittorrent returns tags joined with a comma AND a space.
test('parseTags reads qBittorrent formatting', () => {
  assert.deepEqual(parseTags('hebits:99999, imdb:tt9999999'), { hebitsId: '99999', imdb: 'tt9999999' });
});

test('parseTags tolerates absent, partial and foreign tags', () => {
  assert.deepEqual(parseTags(''), {});
  assert.deepEqual(parseTags(undefined), {});
  assert.deepEqual(parseTags('hebits:1'), { hebitsId: '1' });
  assert.deepEqual(parseTags('someone-elses-tag, imdb:tt7'), { imdb: 'tt7' });
  assert.deepEqual(parseTags('malformed,,  , hebits:2'), { hebitsId: '2' });
});

test('parseTags keeps the last value when a key repeats', () => {
  assert.deepEqual(parseTags('imdb:tt1, imdb:tt2'), { imdb: 'tt2' });
});
