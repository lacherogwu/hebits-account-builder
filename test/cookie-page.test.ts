import { LoginExpiredError } from 'hebits-client';
import { expect, test } from 'vitest';
import { handleCookiePage } from '../src/cookie-page';
import type { CookiePageDeps, CookiePageReq, CookiePageRes } from '../src/cookie-page';
import type { Health } from '../src/jobs';

// A POST whose body is a single `cookie` field, streamed the way http.IncomingMessage
// streams a real request body (an async iterable of chunks).
function reqWith(cookie: string): CookiePageReq {
  const chunk = `cookie=${encodeURIComponent(cookie)}`;
  return {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield chunk;
    },
  };
}

function res(): CookiePageRes & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

// Fakes only - nothing here touches the network or the filesystem. `checkLogin` and
// `writeCookie` are the two collaborators the tests care about; everything else is a
// harmless default so the dependency list stays complete without every test restating it.
function deps(
  over: {
    checkLogin?: (cookie: string) => Promise<void>;
    writeCookie?: (cookie: string) => void;
  } = {},
): CookiePageDeps {
  const health: Health = { hebitsLogin: 'unknown', checkedAt: null, error: null };
  const checkLogin = over.checkLogin ?? (async () => {});
  return {
    health,
    farmLog: () => {},
    log: () => {},
    hebits: (_cookie: string) => ({ checkLogin: () => checkLogin(_cookie) }),
    writeCookie: over.writeCookie ?? (() => {}),
  };
}

test('a valid cookie is verified then written', async () => {
  const writes: string[] = [];
  await handleCookiePage(
    reqWith('session=good'),
    res(),
    deps({
      checkLogin: async () => {},
      writeCookie: (c: string) => writes.push(c),
    }),
  );
  expect(writes).toEqual(['session=good']);
});

test('a dead cookie is rejected and nothing is written', async () => {
  const writes: string[] = [];
  const out = res();
  await handleCookiePage(
    reqWith('session=dead'),
    out,
    deps({
      checkLogin: async () => {
        throw new LoginExpiredError('not logged in');
      },
      writeCookie: (c: string) => writes.push(c),
    }),
  );
  expect(writes).toEqual([]);
  expect(out.body).not.toContain('session=dead');
});
