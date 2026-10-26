import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, chmod, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionPath, saveSession, readSession, deleteSession, validateSession, type Keyring, type Session } from '../src/session.js';
import { loadConfig } from '../src/config.js';
import { serializeConfig } from '../src/setup.js';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';

export const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_AUTH_MODE: 'browser' });
export const session: Session = { baseUrl: config.baseUrl, savedAt: new Date().toISOString(), csrfToken: 'csrf-secret',
  cookies: [{ name: 'd2lSessionVal', value: 'cookie-secret', domain: 'school.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }] };

/** In-memory keychain so tests never touch the real OS keychain. */
function fakeKeyring(entries = new Map<string, string>()): Keyring & { entries: Map<string, string> } {
  return { entries, get: async account => entries.get(account) ?? null, set: async (account, secret) => { entries.set(account, secret); },
    delete: async account => { entries.delete(account); } };
}
const unavailableKeyring: Keyring = { get: async () => { throw new Error('no secret service'); },
  set: async () => { throw new Error('no secret service'); }, delete: async () => { throw new Error('no secret service'); } };
const hostKey = (baseUrl: string) => createHash('sha256').update(baseUrl).digest('hex');
async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-session-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

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
  const keyring = fakeKeyring();
  try {
    await saveSession(session, path, { keyring });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
    assert.deepEqual(await readSession(config, path, keyring), session);
    await saveSession({ ...session, csrfToken: 'new' }, path, { keyring });
    assert.equal((await readSession(config, path, keyring)).csrfToken, 'new');
    assert.ok(!(await readFile(path, 'utf8')).includes('csrf-secret'));
    await chmod(path, 0o644);
    await assert.rejects(readSession(config, path, keyring), /npm run login/);
    await assert.rejects(readSession(config, join(directory, 'missing'), keyring), /npm run login/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sessions round-trip encrypted with a per-host keychain key and a fresh IV per write', () => withDirectory(async directory => {
  const path = join(directory, 'session.json');
  const keyring = fakeKeyring();
  await saveSession(session, path, { keyring });
  const first = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(first).sort(), ['ct', 'iv', 'tag', 'v']);
  assert.equal(first.v, 1);
  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  assert.deepEqual([...keyring.entries.keys()], [hostKey(config.baseUrl)]);
  assert.equal(Buffer.from(keyring.entries.get(hostKey(config.baseUrl))!, 'base64').length, 32);
  const contents = await readFile(path, 'utf8');
  for (const secret of ['cookie-secret', 'csrf-secret', 'd2lSessionVal', keyring.entries.get(hostKey(config.baseUrl))!]) assert.ok(!contents.includes(secret));
  assert.deepEqual(await readSession(config, path, keyring), session);
  await saveSession(session, path, { keyring });
  assert.notEqual(JSON.parse(await readFile(path, 'utf8')).iv, first.iv);
  assert.equal(keyring.entries.size, 1);
}));

test('tampered ciphertext, tag, or IV is rejected without exposing session contents', () => withDirectory(async directory => {
  const path = join(directory, 'session.json');
  const keyring = fakeKeyring();
  await saveSession(session, path, { keyring });
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const flip = (value: string) => { const bytes = Buffer.from(value, 'base64'); bytes[0] ^= 1; return bytes.toString('base64'); };
  for (const field of ['ct', 'tag', 'iv']) {
    await writeFile(path, JSON.stringify({ ...envelope, [field]: flip(envelope[field]) }), { mode: 0o600 });
    await assert.rejects(readSession(config, path, keyring), (error: Error) =>
      /could not be decrypted/.test(error.message) && /npm run login/.test(error.message) && !error.message.includes('secret'));
  }
  keyring.entries.set(hostKey(config.baseUrl), Buffer.alloc(32, 7).toString('base64'));
  await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
  await assert.rejects(readSession(config, path, keyring), /could not be decrypted/);
}));

test('a session file copied to another host is rejected even with the same key', () => withDirectory(async directory => {
  const other = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://other.example', BRIGHTSPACE_AUTH_MODE: 'browser' });
  const path = join(directory, 'session.json');
  const keyring = fakeKeyring();
  await saveSession(session, path, { keyring });
  await assert.rejects(readSession(other, path, keyring), /could not be decrypted/);
  // Associated data binds the ciphertext to its host, not just the per-host key.
  keyring.entries.set(hostKey(other.baseUrl), keyring.entries.get(hostKey(config.baseUrl))!);
  await assert.rejects(readSession(other, path, keyring), /could not be decrypted/);
}));

test('an unavailable keychain fails closed without writing plaintext', () => withDirectory(async directory => {
  const path = join(directory, 'session.json');
  await assert.rejects(saveSession(session, path, { keyring: unavailableKeyring }), (error: Error) =>
    /keychain is unavailable/.test(error.message) && /npm run login/.test(error.message) && !error.message.includes('no secret service'));
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await saveSession(session, path, { keyring: fakeKeyring() });
  await assert.rejects(readSession(config, path, unavailableKeyring), /keychain is unavailable.*npm run login/);
  await assert.rejects(deleteSession(config, path, unavailableKeyring), /keychain/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
}));

test('plaintext storage requires the explicit, validated opt-in', () => withDirectory(async directory => {
  const insecure = loadConfig({ BRIGHTSPACE_BASE_URL: config.baseUrl, BRIGHTSPACE_AUTH_MODE: 'browser', BRIGHTSPACE_INSECURE_PLAINTEXT_SESSION: '1' });
  assert.equal(config.insecurePlaintextSession, false);
  assert.equal(insecure.insecurePlaintextSession, true);
  for (const value of ['true', 'yes', '']) {
    assert.throws(() => loadConfig({ BRIGHTSPACE_BASE_URL: config.baseUrl, BRIGHTSPACE_AUTH_MODE: 'browser', BRIGHTSPACE_INSECURE_PLAINTEXT_SESSION: value }),
      /BRIGHTSPACE_INSECURE_PLAINTEXT_SESSION/);
  }
  const path = join(directory, 'session.json');
  await saveSession(session, path, { keyring: unavailableKeyring, plaintext: true });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), session);
  assert.deepEqual(await readSession(insecure, path, unavailableKeyring), session);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), session);
  await deleteSession(insecure, path, unavailableKeyring);
  await assert.rejects(stat(path), { code: 'ENOENT' });
}));

test('legacy plaintext sessions are migrated to encrypted storage on first read', () => withDirectory(async directory => {
  const path = join(directory, 'private', 'session.json');
  await mkdir(join(directory, 'private'), { mode: 0o700 });
  await writeFile(path, JSON.stringify(session), { mode: 0o600 });
  await assert.rejects(readSession(config, path, unavailableKeyring), /keychain is unavailable/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), session);
  const keyring = fakeKeyring();
  assert.deepEqual(await readSession(config, path, keyring), session);
  const contents = await readFile(path, 'utf8');
  assert.equal(JSON.parse(contents).v, 1);
  assert.ok(!contents.includes('cookie-secret'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readSession(config, path, keyring), session);
  await writeFile(path, JSON.stringify({ ...session, baseUrl: 'https://other.example' }), { mode: 0o600 });
  await assert.rejects(readSession(config, path, keyring), /No usable private Brightspace session/);
}));

test('logout removes both the session file and its keychain entry', () => withDirectory(async directory => {
  const path = join(directory, 'session.json');
  const keyring = fakeKeyring(new Map([['unrelated', 'keep']]));
  await saveSession(session, path, { keyring });
  assert.ok(keyring.entries.has(hostKey(config.baseUrl)));
  await deleteSession(config, path, keyring);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual([...keyring.entries.keys()], ['unrelated']);
  await deleteSession(config, path, keyring);
}));
