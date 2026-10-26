import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from '../src/session-lock.js';

test('session lock is exclusive and released even after a failing action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-lock-'));
  const path = join(directory, 'session.json');
  let active = 0, max = 0;
  try {
    await Promise.all([1, 2, 3].map(() => withSessionLock(path, async () => {
      active++; max = Math.max(active, max);
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
    })));
    assert.equal(max, 1);
    await assert.rejects(withSessionLock(path, async () => { throw new Error('test'); }), /test/);
    await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
    await mkdir(`${path}.lock`);
    await assert.rejects(withSessionLock(path, async () => {}, 0), /interrupted/);
    await stat(`${path}.lock`); // A timed-out waiter must not steal the owner's lock.
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent MCP processes serialize first-time migration and keep the saved key consistent', async () => {
  const { spawn } = await import('node:child_process');
  const { writeFile, readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'session-process-lock-'));
  const path = join(directory, 'session.json');
  const keyPath = join(directory, 'synthetic-key');
  const logPath = join(directory, 'created.log');
  const baseUrl = 'https://process-test.example';
  const session = { baseUrl, savedAt: new Date().toISOString(), cookies: [{ name: 'd2lSessionVal', value: 'synthetic', domain: 'process-test.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }] };
  const code = `
    import {readFile,writeFile,appendFile} from 'node:fs/promises';
    import {readSession} from ${JSON.stringify(new URL('../src/session.ts', import.meta.url).href)};
    import {loadConfig} from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
    const keyring={get:async()=>{let key=null;try{key=await readFile(${JSON.stringify(keyPath)},'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,50));return key;},
      set:async(_,key)=>{await writeFile(${JSON.stringify(keyPath)},key,{mode:0o600});await appendFile(${JSON.stringify(logPath)},'created\\n');},delete:async()=>{}};
    await readSession(loadConfig({BRIGHTSPACE_BASE_URL:${JSON.stringify(baseUrl)},BRIGHTSPACE_AUTH_MODE:'browser'}),${JSON.stringify(path)},keyring);
  `;
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Migration child failed (${code})`)));
  });
  try {
    await writeFile(path, JSON.stringify(session), { mode: 0o600 });
    await Promise.all([run(), run()]);
    assert.equal(await readFile(logPath, 'utf8'), 'created\n');
    await run(); // A third process can still decrypt the winning envelope.
  } finally { await rm(directory, { recursive: true, force: true }); }
});
