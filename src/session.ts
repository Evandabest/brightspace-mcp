import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { withSessionLock, SessionLockError } from './session-lock.js';

const cookie = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
  expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']) });
const sessionSchema = z.object({ baseUrl: z.string().url(), cookies: z.array(cookie).min(1),
  csrfToken: z.string().optional(), savedAt: z.string() });
export type Session = z.infer<typeof sessionSchema>;
const envelopeSchema = z.object({ v: z.literal(1), iv: z.string(), tag: z.string(), ct: z.string() });
const passphraseEnvelopeSchema = z.object({ v: z.literal(2), storage: z.literal('passphrase'), kdf: z.literal('scrypt'), salt: z.string(), iv: z.string(), tag: z.string(), ct: z.string() });
type Storage = Config['sessionStorage'];
type SaveOptions = { keyring?: Keyring; storage?: Storage; passphrase?: string };

/** Minimal OS keychain surface, injectable so tests never touch the real keychain. */
export interface Keyring {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}
const keyringService = 'brightspace-mcp';
// Loaded lazily so a missing native binding fails closed like any other unavailable keychain.
const entry = async (account: string) => new (await import('@napi-rs/keyring')).AsyncEntry(keyringService, account, { linux: { store: 'secret-service' } });
export const osKeyring: Keyring = {
  get: async account => (await entry(account)).getPassword(),
  set: async (account, secret) => (await entry(account)).setPassword(secret),
  delete: async account => { await (await entry(account)).deleteCredential(); },
};

/** Session errors carry only fixed, secret-free messages and are safe to show to users. */
export class SessionError extends Error {}
const noSession = 'No usable private Brightspace session. Run npm run login in your terminal.';
const keychainUnavailable = 'The OS keychain is unavailable, so the Brightspace session cannot be encrypted or decrypted. ' +
  'Unlock or enable your keychain, or choose passphrase storage in npm run setup. Plaintext session storage is not supported.';
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

async function sessionLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  try { return await withSessionLock(path, action); }
  catch (error) { if (error instanceof SessionLockError) throw new SessionError(error.message); throw error; }
}
async function keychain<T>(action: () => Promise<T>) {
  try { return await action(); } catch { throw new SessionError(keychainUnavailable); }
}
async function loadKey(baseUrl: string, keyring: Keyring) {
  const stored = await keychain(() => keyring.get(hostHash(baseUrl)));
  const key = stored === null ? undefined : Buffer.from(stored, 'base64');
  return key?.length === 32 ? key : undefined;
}
let unlockedPassphrase: string | undefined;
export function setSessionPassphrase(value: string) {
  if (value.length < 12 || value.length > 1024 || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new SessionError('Use a passphrase of 12–1024 characters without line breaks. It will not be saved.');
  }
  unlockedPassphrase = value;
}
export function consumeSessionPassphrase() {
  const value = process.env.BRIGHTSPACE_SESSION_PASSPHRASE;
  delete process.env.BRIGHTSPACE_SESSION_PASSPHRASE;
  if (value !== undefined) setSessionPassphrase(value);
}
function requirePassphrase(value = unlockedPassphrase) {
  if (!value) throw new SessionError('The passphrase session is locked. Launch your coding agent with npm run unlock -- <agent command>, forward BRIGHTSPACE_SESSION_PASSPHRASE to this MCP, or run npm run login in your terminal. Never put the passphrase in .env or chat.');
  if (value.length < 12 || value.length > 1024 || !value.trim() || /[\r\n\0]/.test(value)) throw new SessionError('The session passphrase is invalid.');
  return value;
}
function associatedData(baseUrl: string, passphrase: boolean) {
  return Buffer.from(passphrase ? `brightspace-mcp:v2:passphrase:scrypt:${baseUrl}` : baseUrl);
}
async function passphraseKey(passphrase: string, salt: Buffer) {
  // Fixed parameters prevent untrusted envelope metadata from requesting arbitrary KDF work.
  return await new Promise<Buffer>((resolve, reject) => scrypt(passphrase, salt, 32,
    { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
async function encrypt(session: Session, options: SaveOptions) {
  const { keyring = osKeyring, storage = 'keychain' } = options;
  let key: Buffer;
  let salt: Buffer | undefined;
  if (storage === 'passphrase') {
    const passphrase = requirePassphrase(options.passphrase);
    salt = randomBytes(16);
    key = await passphraseKey(passphrase, salt);
  } else {
    const existing = await loadKey(session.baseUrl, keyring);
    if (existing) key = existing;
    else {
      key = randomBytes(32);
      await keychain(() => keyring.set(hostHash(session.baseUrl), key.toString('base64')));
    }
  }
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(associatedData(session.baseUrl, storage === 'passphrase'));
    const ct = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    const encrypted = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
    return salt ? { v: 2, storage: 'passphrase', kdf: 'scrypt', salt: salt.toString('base64'), ...encrypted } : { v: 1, ...encrypted };
  } finally { key.fill(0); }
}
async function decrypt(envelope: z.infer<typeof envelopeSchema> | z.infer<typeof passphraseEnvelopeSchema>, baseUrl: string, keyring: Keyring, passphrase?: string) {
  let key: Buffer | undefined;
  if (envelope.v === 2) {
    const secret = requirePassphrase(passphrase);
    const salt = Buffer.from(envelope.salt, 'base64');
    if (salt.length !== 16) throw new SessionError(undecryptable);
    key = await passphraseKey(secret, salt);
  } else key = await loadKey(baseUrl, keyring);
  try {
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (!key || iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 }).setAAD(associatedData(baseUrl, envelope.v === 2)).setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
    return validateSession(JSON.parse(plaintext), baseUrl);
  } catch { throw new SessionError(envelope.v === 2 ? 'The passphrase is incorrect or the encrypted session was modified. Run npm run unlock or npm run login in your terminal.' : undecryptable); }
  finally { key?.fill(0); }
}

export async function readSession(config: Config, path = sessionPath(config.baseUrl), keyring = osKeyring, passphrase?: string): Promise<Session> {
  return sessionLock(path, () => readUnlocked(config, path, keyring, passphrase));
}
async function readUnlocked(config: Config, path: string, keyring: Keyring, passphrase?: string) {
  let stored: unknown;
  try {
    const info = await lstat(path);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
    stored = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new SessionError(noSession); }
  const envelope = envelopeSchema.safeParse(stored);
  if (envelope.success) {
    if (config.sessionStorage !== 'keychain') throw new SessionError('This session uses the OS keychain. Run npm run login to save a new passphrase-protected session.');
    return decrypt(envelope.data, config.baseUrl, keyring);
  }
  const protectedSession = passphraseEnvelopeSchema.safeParse(stored);
  if (protectedSession.success) {
    if (config.sessionStorage !== 'passphrase') throw new SessionError('This session uses a passphrase. Set BRIGHTSPACE_SESSION_STORAGE=passphrase and launch your agent with npm run unlock.');
    return decrypt(protectedSession.data, config.baseUrl, keyring, passphrase);
  }
  let session: Session;
  try { session = validateSession(stored, config.baseUrl); } catch { throw new SessionError(noSession); }
  // Legacy plaintext is always migrated; failure leaves the original untouched.
  await writeUnlocked(session, path, { keyring, storage: config.sessionStorage, passphrase });
  return session;
}
export async function saveSession(session: Session, path = sessionPath(session.baseUrl),
  options: SaveOptions = {}) {
  return sessionLock(path, () => writeUnlocked(session, path, options));
}
async function writeUnlocked(session: Session, path: string, options: SaveOptions = {}) {
  validateSession(session, session.baseUrl);
  const contents = JSON.stringify(await encrypt(session, options));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.session-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function deleteSession(config: Config, path = sessionPath(config.baseUrl), keyring = osKeyring) {
  return sessionLock(path, () => deleteUnlocked(config, path, keyring));
}
async function deleteUnlocked(config: Config, path: string, keyring: Keyring) {
  await rm(path, { force: true });
  if (config.sessionStorage === 'passphrase') return;
  try { await keyring.delete(hostHash(config.baseUrl)); }
  catch {
    throw new SessionError('The session file was removed, but its key could not be removed from the OS keychain. Unlock your keychain and run npm run logout again.');
  }
}
