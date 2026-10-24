import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { normalizeHost, saveConfig, serializeConfig } from '../src/setup.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_ACCESS_TOKEN: 'token#with=characters$' });

test('setup accepts a Brightspace page URL and rejects insecure URLs or embedded credentials', () => {
  assert.equal(normalizeHost(' https://school.example/d2l/home/123?x=y '), 'https://school.example');
  for (const host of ['http://school.example', 'https://user:pass@school.example', 'invalid']) assert.throws(() => normalizeHost(host));
});

test('saved configuration round-trips with Node dotenv parsing', () => {
  assert.deepEqual(loadConfig(parseEnv(serializeConfig(config))), config);
  assert.throws(() => serializeConfig({ ...config, accessToken: 'token\nINJECTED=value' }), /unsupported/);
});

test('setup writes private config, protects existing files, and safely replaces on consent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-setup-'));
  const path = join(directory, '.env');
  try {
    await saveConfig(path, config);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(loadConfig(parseEnv(await readFile(path, 'utf8'))), config);
    await assert.rejects(saveConfig(path, { ...config, accessToken: 'replacement' }), { code: 'EEXIST' });
    assert.deepEqual(loadConfig(parseEnv(await readFile(path, 'utf8'))), config);
    await saveConfig(path, { ...config, accessToken: 'replacement' }, true);
    assert.equal(loadConfig(parseEnv(await readFile(path, 'utf8'))).accessToken, 'replacement');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const target = join(directory, 'target');
    await writeFile(target, 'untouched');
    await rm(path);
    await symlink(target, path);
    await assert.rejects(saveConfig(path, config, true), /non-regular/);
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
