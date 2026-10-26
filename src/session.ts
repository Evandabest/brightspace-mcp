import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { withSessionLock } from './session-lock.js';

const cookie = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
  expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']) });
const sessionSchema = z.object({ baseUrl: z.string().url(), cookies: z.array(cookie).min(1),
  csrfToken: z.string().optional(), savedAt: z.string() });
export type Session = z.infer<typeof sessionSchema>;
const envelopeSchema = z.object({ v: z.literal(1), iv: z.string(), tag: z.string(), ct: z.string() });

/** Minimal OS keychain surface, injectable so tests never touch the real keychain. */
export interface Keyring {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}
const keyringService = 'brightspace-mcp';
// Loaded lazily so a missing native binding fails closed like any other unavailable keychain.
const entry = async (account: string) => new (await import('@napi-rs/keyring')).AsyncEntry(keyringService, account);
export const osKeyring: Keyring = {
  get: async account => (await entry(account)).getPassword(),
  set: async (account, secret) => (await entry(account)).setPassword(secret),
  delete: async account => { await (await entry(account)).deleteCredential(); },
};

/** Session errors carry only fixed, secret-free messages and are safe to show to users. */
export class SessionError extends Error {}
const noSession = 'No usable private Brightspace session. Run npm run login in your terminal.';
const keychainUnavailable = 'The OS keychain is unavailable, so the Brightspace session cannot be encrypted or decrypted. ' +
  'Unlock or enable your keychain, then run npm run login in your terminal. To store the session unencrypted instead, set BRIGHTSPACE_INSECURE_PLAINTEXT_SESSION=1.';
const undecryptable = 'The saved Brightspace session could not be decrypted (wrong key or modified file). Run npm run login in your terminal.';

function hostHash(baseUrl: string) {
  return createHash('sha256').update(baseUrl).digest('hex');
}
export function sessionPath(baseUrl: string) {
  return join(homedir(), '.brightspace-mcp', 'sessions', `${hostHash(baseUrl)}.json`);
}
export function validateSession(value: unknown, baseUrl: string): Session {
  const session = sessionSchema.parse(value);
  if (session.baseUrl !== baseUrl) throw new Error('Session belongs to a different Brightspace host.');
  const host = new URL(baseUrl).hostname;
  // Restrict stored cookies to this exact tenant, not parent domains or SSO providers.
  if (session.cookies.some(c => c.domain.replace(/^\./, '') !== host)) throw new Error('Unexpected session cookie domain.');
  return session;
}

async function keychain<T>(action: () => Promise<T>) {
  try { return await action(); } catch { throw new SessionError(keychainUnavailable); }
}
async function loadKey(baseUrl: string, keyring: Keyring) {
  const stored = await keychain(() => keyring.get(hostHash(baseUrl)));
  const key = stored === null ? undefined : Buffer.from(stored, 'base64');
  return key?.length === 32 ? key : undefined;
}
async function encrypt(session: Session, keyring: Keyring) {
  let key = await loadKey(session.baseUrl, keyring);
  if (!key) {
    const created = randomBytes(32);
    await keychain(() => keyring.set(hostHash(session.baseUrl), created.toString('base64')));
    key = created;
  }
  const iv = randomBytes(12);
  // The base URL is associated data, so a session file cannot be moved to another host.
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(session.baseUrl));
  const ct = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
async function decrypt(envelope: z.infer<typeof envelopeSchema>, baseUrl: string, keyring: Keyring) {
  const key = await loadKey(baseUrl, keyring);
  try {
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (!key || iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 }).setAAD(Buffer.from(baseUrl)).setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
    return validateSession(JSON.parse(plaintext), baseUrl);
  } catch { throw new SessionError(undecryptable); }
}

export async function readSession(config: Config, path = sessionPath(config.baseUrl), keyring = osKeyring): Promise<Session> {
  return withSessionLock(path, () => readUnlocked(config, path, keyring));
}
async function readUnlocked(config: Config, path: string, keyring: Keyring) {
  let stored: unknown;
  try {
    const info = await lstat(path);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
    stored = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new SessionError(noSession); }
  const envelope = envelopeSchema.safeParse(stored);
  if (envelope.success) return decrypt(envelope.data, config.baseUrl, keyring);
  let session: Session;
  try { session = validateSession(stored, config.baseUrl); } catch { throw new SessionError(noSession); }
  // Legacy plaintext session: migrate it to encrypted storage now unless plaintext was explicitly requested.
  if (!config.insecurePlaintextSession) await writeUnlocked(session, path, { keyring });
  return session;
}
export async function saveSession(session: Session, path = sessionPath(session.baseUrl),
  options: { keyring?: Keyring; plaintext?: boolean } = {}) {
  return withSessionLock(path, () => writeUnlocked(session, path, options));
}
async function writeUnlocked(session: Session, path: string,
  { keyring = osKeyring, plaintext = false }: { keyring?: Keyring; plaintext?: boolean } = {}) {
  validateSession(session, session.baseUrl);
  const contents = JSON.stringify(plaintext ? session : await encrypt(session, keyring));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.session-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function deleteSession(config: Config, path = sessionPath(config.baseUrl), keyring = osKeyring) {
  return withSessionLock(path, () => deleteUnlocked(config, path, keyring));
}
async function deleteUnlocked(config: Config, path: string, keyring: Keyring) {
  await rm(path, { force: true });
  try { await keyring.delete(hostHash(config.baseUrl)); }
  catch {
    // A plaintext-mode machine may have no keychain at all; otherwise a leftover key must be reported.
    if (!config.insecurePlaintextSession) {
      throw new SessionError('The session file was removed, but its key could not be removed from the OS keychain. Unlock your keychain and run npm run logout again.');
    }
  }
}
