import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { serializeConfig } from '../src/setup.js';
import { saveSession, readSession, deleteSession, type Keyring, consumeSessionPassphrase } from '../src/session.js';
import { launchUnlocked } from '../src/unlock.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const passphrase = 'synthetic review passphrase only';
const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://passphrase.example', BRIGHTSPACE_AUTH_MODE: 'browser', BRIGHTSPACE_SESSION_STORAGE: 'passphrase' });
const session = { baseUrl: config.baseUrl, savedAt: new Date().toISOString(), cookies: [{ name: 'd2lSessionVal', value: 'synthetic-cookie-secret', domain: 'passphrase.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }] };
const unavailable: Keyring = { get: async () => { throw new Error('keychain must not be called'); }, set: async () => { throw new Error('keychain must not be called'); }, delete: async () => { throw new Error('keychain must not be called'); } };
async function temporary(action: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'passphrase-session-'));
  try { await action(join(directory, 'session.json')); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('passphrase storage encrypts without any keychain and keeps secrets out of disk/config', () => temporary(async path => {
  await saveSession(session, path, { storage: 'passphrase', passphrase, keyring: unavailable });
  const contents = await readFile(path, 'utf8');
  const first = JSON.parse(contents);
  assert.equal(first.v, 2); assert.equal(first.storage, 'passphrase');
  assert.equal(first.kdf, 'scrypt'); assert.equal(Buffer.from(first.salt, 'base64').length, 16);
  assert.ok(!contents.includes(passphrase)); assert.ok(!contents.includes('synthetic-cookie-secret'));
  assert.ok(!serializeConfig(config).includes(passphrase));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readSession(config, path, unavailable, passphrase), session);
  await saveSession(session, path, { storage: 'passphrase', passphrase, keyring: unavailable });
  const second = JSON.parse(await readFile(path, 'utf8'));
  assert.notEqual(first.iv, second.iv); assert.notEqual(first.salt, second.salt);
  await deleteSession(config, path, unavailable);
  await assert.rejects(stat(path), { code: 'ENOENT' });
}));

test('wrong or missing passphrases, modified ciphertext and swapped hosts fail closed', () => temporary(async path => {
  await assert.rejects(saveSession(session, path, { storage: 'passphrase', keyring: unavailable }), /locked/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await saveSession(session, path, { storage: 'passphrase', passphrase });
  const contents = await readFile(path, 'utf8');
  await assert.rejects(readSession(config, path, unavailable), /locked/);
  await assert.rejects(readSession(config, path, unavailable, 'a different long passphrase'), /incorrect/);
  await assert.rejects(readSession({ ...config, baseUrl: 'https://other.example' }, path, unavailable, passphrase), /incorrect/);
  const envelope = JSON.parse(contents);
  for (const field of ['ct', 'tag', 'iv', 'salt']) {
    const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1;
    await writeFile(path, JSON.stringify({ ...envelope, [field]: bytes.toString('base64') }));
    await assert.rejects(readSession(config, path, unavailable, passphrase), /incorrect/);
  }
  await writeFile(path, contents);
  await assert.rejects(readSession({ ...config, sessionStorage: 'keychain' }, path, unavailable), /uses a passphrase/);
}));

test('legacy plaintext migrates to passphrase encryption and is untouched if locked', () => temporary(async path => {
  const contents = JSON.stringify(session);
  await writeFile(path, contents, { mode: 0o600 });
  await assert.rejects(readSession(config, path, unavailable), /locked/);
  assert.equal(await readFile(path, 'utf8'), contents);
  assert.deepEqual(await readSession(config, path, unavailable, passphrase), session);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).v, 2);
}));

test('unlock wrapper forwards the passphrase through environment without modifying files or command arguments', async () => {
  const code = 'if(process.env.BRIGHTSPACE_SESSION_PASSPHRASE!=="synthetic review passphrase only")process.exit(7);';
  assert.equal(await launchUnlocked(process.execPath, ['-e', code], passphrase), 0);
  assert.equal(await launchUnlocked(process.execPath, ['-e', 'process.exit(9)'], passphrase), 9);
});

test('server consumes forwarded passphrase without placing it in configuration or keeping it in process.env', () => {
  process.env.BRIGHTSPACE_SESSION_PASSPHRASE = passphrase;
  consumeSessionPassphrase();
  assert.equal(process.env.BRIGHTSPACE_SESSION_PASSPHRASE, undefined);
  assert.ok(!JSON.stringify(config).includes(passphrase));
});

test('a fresh MCP process unlocks a passphrase session and can list courses and download a PDF', () => temporary(async path => {
  const { dirname } = await import('node:path');
  const directory = dirname(path);
  const launcher = join(directory, 'mcp-launcher.mjs');
  await saveSession(session, path, { storage: 'passphrase', passphrase, keyring: unavailable });
  const source = (name: string) => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href);
  await writeFile(launcher, `
    import assert from 'node:assert/strict';
    import {StdioServerTransport} from ${JSON.stringify(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js', import.meta.url).href)};
    import {loadConfig} from ${source('config')};
    import {consumeSessionPassphrase,readSession} from ${source('session')};
    import {BrightspaceClient} from ${source('client')};
    import {createServer} from ${source('server')};
    import {sessionFetch,sessionDownloadFetch} from ${source('browser-auth')};
    consumeSessionPassphrase();assert.equal(process.env.BRIGHTSPACE_SESSION_PASSPHRASE,undefined);
    const config=loadConfig();
    const unavailable={get:async()=>{throw new Error('unexpected keychain call')},set:async()=>{throw new Error('unexpected keychain call')},delete:async()=>{}};
    const load=()=>readSession(config,${JSON.stringify(path)},unavailable);
    const fetcher=sessionFetch(config,load,async options=>{
      assert.equal(options.storageState.cookies[0].value,'synthetic-cookie-secret');
      return {get:async()=>({status:()=>200,ok:()=>true,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify({Items:[{OrgUnit:{Id:1}}],PagingInfo:{HasMoreItems:false}}))}),dispose:async()=>{}};
    });
    const files=sessionDownloadFetch(config,load,async(_,init)=>{
      assert.equal(init.headers.Cookie,'d2lSessionVal=synthetic-cookie-secret');
      return new Response('%PDF-1.7 synthetic',{headers:{'content-type':'application/pdf'}});
    });
    await createServer(new BrightspaceClient(config,fetcher,files)).connect(new StdioServerTransport());
  `);
  const client = new Client({ name: 'passphrase-protocol-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', launcher],
      env: { PATH: process.env.PATH ?? '', BRIGHTSPACE_BASE_URL: config.baseUrl, BRIGHTSPACE_AUTH_MODE: 'browser', BRIGHTSPACE_SESSION_STORAGE: 'passphrase', BRIGHTSPACE_SESSION_PASSPHRASE: passphrase }, stderr: 'pipe' }));
    const courses = await client.callTool({ name: 'get_courses', arguments: {} });
    assert.notEqual(courses.isError, true);
    assert.equal(JSON.parse((courses.content as { text: string }[])[0].text).length, 1);
    const download = await client.callTool({ name: 'download_document', arguments: { source: 'content_topic', course_id: '1', topic_id: '2', destination_dir: directory, pdf_only: true } });
    assert.notEqual(download.isError, true);
    const file = JSON.parse((download.content as { text: string }[])[0].text);
    assert.equal(await readFile(file.path, 'utf8'), '%PDF-1.7 synthetic');
  } finally { await client.close(); }
}));
