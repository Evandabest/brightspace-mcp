import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionPath, saveSession, readSession, validateSession, type Session } from '../src/session.js';
import { loadConfig } from '../src/config.js';
import { serializeConfig } from '../src/setup.js';
import { parseEnv } from 'node:util';

export const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_AUTH_MODE: 'browser' });
export const session: Session = { baseUrl: config.baseUrl, savedAt: new Date().toISOString(), csrfToken: 'csrf-secret',
  cookies: [{ name: 'd2lSessionVal', value: 'cookie-secret', domain: 'school.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }] };

test('browser configuration needs no token and round-trips without saving OAuth secrets', () => {
  assert.equal(config.authMode, 'browser');
  assert.equal(config.accessToken, undefined);
  assert.deepEqual(loadConfig(parseEnv(serializeConfig(config))), config);
  assert.ok(!serializeConfig(config).includes('BRIGHTSPACE_ACCESS_TOKEN'));
  assert.throws(() => loadConfig({ BRIGHTSPACE_BASE_URL: config.baseUrl, BRIGHTSPACE_AUTH_MODE: 'oauth' }), /ACCESS_TOKEN/);
  assert.notEqual(sessionPath(config.baseUrl), sessionPath('https://other.example'));
});

test('sessions bind to exact tenant and reject SSO and parent-domain cookies', () => {
  assert.throws(() => validateSession(session, 'https://other.example'));
  for (const domain of ['example', 'sso.example', 'other.school.example']) {
    assert.throws(() => validateSession({ ...session, cookies: [{ ...session.cookies[0], domain }] }, config.baseUrl));
  }
});

test('sessions save privately, load, replace, and reject readable or corrupt state without exposing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-session-'));
  const path = join(directory, 'private', 'session.json');
  try {
    await saveSession(session, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
    assert.deepEqual(await readSession(config, path), session);
    await saveSession({ ...session, csrfToken: 'new' }, path);
    assert.equal((await readSession(config, path)).csrfToken, 'new');
    assert.ok(!(await readFile(path, 'utf8')).includes('csrf-secret'));
    await chmod(path, 0o644);
    await assert.rejects(readSession(config, path), /npm run login/);
    await assert.rejects(readSession(config, join(directory, 'missing')), /npm run login/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
