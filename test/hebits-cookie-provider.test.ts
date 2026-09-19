// Proves the fix for the "pasted cookie never reaches the running client" bug: the real
// `Hebits` client, constructed exactly the way src/server.ts constructs it (a provider
// function, not a bound string), must send whatever the provider currently returns on
// EVERY request - not just the value that was current at construction time.
//
// This does not touch the network: `fetch` is stubbed so hebits-client's ky transport
// resolves against a fake front page instead of hebits.net. Nothing here fakes
// checkLogin() itself or asserts on plumbing (that a provider function exists, that some
// setter was called) - it asserts on the one thing that matters: the Cookie header an
// actual outgoing request carries.

import { Hebits } from 'hebits-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let sentCookies: string[];

// A page containing the logout link hebits-client's isLoggedIn() looks for, so
// checkLogin() resolves instead of throwing LoginExpiredError - this test cares about
// which cookie a request carried, not about login-failure handling.
const LOGGED_IN_PAGE = '<a href="logout.php?auth=abc123">logout</a>';

beforeEach(() => {
  sentCookies = [];
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const req = new Request(...args);
    sentCookies.push(req.headers.get('cookie') ?? '');
    return new Response(LOGGED_IN_PAGE, { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a cookie rotated after construction is carried on the next request, with no reconstruction', async () => {
  let currentCookie = 'session=old';
  // Mirrors src/server.ts:27 exactly: `cookie` is a closure over a mutable source, not a
  // string captured once. In production the mutable source is readCookie() re-reading the
  // cookie file; here it is a variable this test flips directly, which is the same shape.
  const hebits = new Hebits({ cookie: () => currentCookie, cacheTtlMs: 0 });

  await hebits.checkLogin();
  currentCookie = 'session=new';
  await hebits.checkLogin();

  expect(sentCookies).toEqual(['session=old', 'session=new']);
});
