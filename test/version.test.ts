import { expect, test } from 'vitest';
import { VERSION } from '../src/version';

test('version is exported', () => {
  expect(VERSION).toBe('2.0.0');
});
