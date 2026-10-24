import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIRequestContext, APIResponse, APIRequest } from 'playwright';
import { sessionFetch } from '../src/browser-auth.js';
import { BrightspaceClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import type { Session } from '../src/session.js';

const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_AUTH_MODE: 'browser' });
const session: Session = { baseUrl: config.baseUrl, savedAt: new Date().toISOString(), csrfToken: 'csrf-secret',
  cookies: [{ name: 'd2lSessionVal', value: 'cookie-secret', domain: 'school.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }] };
function response(status: number, value: unknown, type = 'application/json') {
  return { status: () => status, ok: () => status >= 200 && status < 300,
    headers: () => ({ 'content-type': type }), body: async () => Buffer.from(JSON.stringify(value)),
    json: async () => value, dispose: async () => {} } as unknown as APIResponse;
}
const factory = (context: Partial<APIRequestContext>) => (async () => context as APIRequestContext) as APIRequest['newContext'];

test('browser adapter shares cookies, sends only API GETs, and disposes request contexts', async () => {
  let disposed = false;
  const fetcher = sessionFetch(config, async () => session, async options => {
    assert.deepEqual(options?.storageState, { cookies: session.cookies, origins: [] });
    return { get: async (url, options) => {
      assert.equal(new URL(url).origin, config.baseUrl);
      assert.equal(options?.maxRedirects, 0);
      assert.equal(options?.headers?.['x-csrf-token'], 'csrf-secret');
      return response(200, { Items: [], PagingInfo: { HasMoreItems: false } });
    }, dispose: async () => { disposed = true; } } as APIRequestContext;
  });
  assert.deepEqual(await new BrightspaceClient(config, fetcher).getCourses(), []);
  assert.equal(disposed, true);
  for (const url of ['https://attacker.example/d2l/api/le/1.82/grades', 'https://school.example/d2l/login']) {
    await assert.rejects(fetcher(url, { method: 'GET' }), /configured Brightspace API/);
  }
  await assert.rejects(fetcher('https://school.example/d2l/api/test', { method: 'POST' }), /GETs/);
});

test('session bearer fallback retries once and only POSTs to the tenant authentication endpoint', async () => {
  let gets = 0, posts = 0;
  const fetcher = sessionFetch(config, async () => session, factory({
    get: async (_url, options) => {
      gets++;
      if (gets === 1) return response(403, {});
      assert.equal(options?.headers?.Authorization, 'Bearer minted-secret');
      return response(200, []);
    },
    post: async (url, options) => {
      posts++;
      assert.equal(url, `${config.baseUrl}/d2l/lp/auth/oauth2/token`);
      assert.equal(options?.maxRedirects, 0);
      assert.deepEqual(options?.form, { scope: '*:*:*' });
      return response(200, { access_token: 'minted-secret' });
    }, dispose: async () => {},
  }));
  await new BrightspaceClient(config, fetcher).getGrades('123');
  assert.equal(gets, 2); assert.equal(posts, 1);
});

test('expired, redirected, or HTML sessions give login instructions without leaking upstream content', async () => {
  for (const upstream of [response(401, 'cookie-secret'), response(302, 'cookie-secret'), response(200, 'cookie-secret', 'text/html')]) {
    const fetcher = sessionFetch(config, async () => ({ ...session, csrfToken: undefined }), factory({ get: async () => upstream, dispose: async () => {} }));
    await assert.rejects(new BrightspaceClient(config, fetcher).getCourses(), error =>
      error instanceof Error && error.message.includes('npm run login') && !error.message.includes('cookie-secret'));
  }
  await assert.rejects(new BrightspaceClient(config, sessionFetch(config, async () => { throw new Error('cookie-secret'); })).getCourses(), /No saved browser session/);
});

test('network failures dispose context and redact details; authorization failure remains explicit', async () => {
  let disposed = false;
  const fetcher = sessionFetch(config, async () => session, factory({
    get: async () => { throw new Error('cookie-secret'); }, dispose: async () => { disposed = true; },
  }));
  await assert.rejects(new BrightspaceClient(config, fetcher).getCourses(), /request failed or timed out/);
  assert.equal(disposed, true);
  const denied = sessionFetch(config, async () => session, factory({ get: async () => response(403, {}), post: async () => response(403, {}), dispose: async () => {} }));
  await assert.rejects(new BrightspaceClient(config, denied).getCourses(), /HTTP 403/);
});
