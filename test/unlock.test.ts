import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSession, type Session } from '../src/session.js';

const passphrase = 'synthetic unlock passphrase only';
const baseUrl = 'https://unlock.example';
const session: Session = { baseUrl, savedAt: new Date().toISOString(), cookies: [
  { name: 'd2lSessionVal', value: 'synthetic-cookie', domain: 'unlock.example', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' },
] };

async function temporary(action: (home: string, path: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'brightspace-unlock-'));
  const path = join(home, '.brightspace-mcp', 'sessions', `${createHash('sha256').update(baseUrl).digest('hex')}.json`);
  try { await action(home, path); } finally { await rm(home, { recursive: true, force: true }); }
}

async function unlock(home: string, secret = passphrase, env: NodeJS.ProcessEnv = {}, exitCode = 0) {
  const marker = join(home, 'agent-started.json');
  const argument = 'literal argument; $(not-a-shell-command)';
  const agent = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({
    passphrase: process.env.BRIGHTSPACE_SESSION_PASSPHRASE, args: process.argv.slice(2)
  })); process.exit(${exitCode});`;
  // Pipes emulate terminal input for the real CLI and masked password prompt.
  const entry = new URL('../src/index.ts', import.meta.url).href;
  const code = `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.argv = [process.execPath, 'brightspace-mcp', 'unlock', process.execPath, '-e', ${JSON.stringify(agent)}, ${JSON.stringify(marker)}, ${JSON.stringify(argument)}];
    await import(${JSON.stringify(entry)});
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      BRIGHTSPACE_BASE_URL: baseUrl, BRIGHTSPACE_AUTH_MODE: 'browser', BRIGHTSPACE_SESSION_STORAGE: 'passphrase', ...env },
    stdio: 'pipe', timeout: 10_000,
  });
  let output = '', sent = false;
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    if (!sent && output.includes('Session passphrase (not saved):')) {
      sent = true;
      child.stdin.write(`${secret}\n`);
    }
  });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.signal, null, output);
  assert.ok(!output.includes(secret), 'the passphrase must remain masked');
  return { ...result, output, marker, argument };
}

test('unlock rejects an incorrect passphrase before starting the agent', () => temporary(async (home, path) => {
  await saveSession(session, path, { storage: 'passphrase', passphrase });
  const contents = await readFile(path, 'utf8');
  const result = await unlock(home, 'incorrect synthetic passphrase');
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /passphrase is incorrect or the encrypted session was modified/);
  assert.doesNotMatch(result.output, /Starting your agent/);
  await assert.rejects(stat(result.marker), { code: 'ENOENT' });
  assert.equal(await readFile(path, 'utf8'), contents);
}));

test('unlock validates locally, forwards the secret and literal arguments, and preserves agent exit status', () => temporary(async (home, path) => {
  await saveSession(session, path, { storage: 'passphrase', passphrase });
  const contents = await readFile(path, 'utf8');
  const result = await unlock(home, passphrase, {}, 9);
  assert.equal(result.code, 9, result.output);
  assert.match(result.output, /Starting your agent/);
  assert.deepEqual(JSON.parse(await readFile(result.marker, 'utf8')), { passphrase, args: [result.argument] });
  assert.equal(await readFile(path, 'utf8'), contents);
}));

test('unlock refuses a missing saved session', () => temporary(async home => {
  const result = await unlock(home);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /npm run login/);
  await assert.rejects(stat(result.marker), { code: 'ENOENT' });
}));

test('unlock refuses damaged sessions and leaves the saved file untouched', () => temporary(async (home, path) => {
  await saveSession(session, path, { storage: 'passphrase', passphrase });
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const tag = Buffer.from(envelope.tag, 'base64'); tag[0] ^= 1;
  for (const contents of [JSON.stringify({ ...envelope, tag: tag.toString('base64') }), '{invalid json']) {
    await writeFile(path, contents);
    const result = await unlock(home);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /npm run (unlock|login)/);
    await assert.rejects(stat(result.marker), { code: 'ENOENT' });
    assert.equal(await readFile(path, 'utf8'), contents);
  }
}));

test('unlock refuses legacy plaintext rather than accepting any passphrase and migrating it', () => temporary(async (home, path) => {
  await saveSession(session, path, { storage: 'passphrase', passphrase });
  const contents = JSON.stringify(session);
  await writeFile(path, contents);
  const result = await unlock(home);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /npm run login/);
  await assert.rejects(stat(result.marker), { code: 'ENOENT' });
  assert.equal(await readFile(path, 'utf8'), contents);
}));

for (const [mode, env] of [
  ['OAuth', { BRIGHTSPACE_AUTH_MODE: 'oauth', BRIGHTSPACE_ACCESS_TOKEN: 'synthetic-token' }],
  ['keychain', { BRIGHTSPACE_SESSION_STORAGE: 'keychain' }],
] as const) {
  test(`unlock gives direct-launch guidance without prompting in ${mode} mode`, () => temporary(async home => {
    const result = await unlock(home, passphrase, env);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /launch your agent directly/i);
    assert.doesNotMatch(result.output, /Session passphrase|Starting your agent/);
    await assert.rejects(stat(result.marker), { code: 'ENOENT' });
  }));
}

test('unlock checks configuration before prompting', () => temporary(async home => {
  const result = await unlock(home, passphrase, { BRIGHTSPACE_BASE_URL: undefined });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Invalid configuration/);
  assert.doesNotMatch(result.output, /Session passphrase|Starting your agent/);
  await assert.rejects(stat(result.marker), { code: 'ENOENT' });
}));
