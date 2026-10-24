import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';

const cookie = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
  expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']) });
const sessionSchema = z.object({ baseUrl: z.string().url(), cookies: z.array(cookie).min(1),
  csrfToken: z.string().optional(), savedAt: z.string() });
export type Session = z.infer<typeof sessionSchema>;

export function sessionPath(baseUrl: string) {
  return join(homedir(), '.brightspace-mcp', 'sessions', `${createHash('sha256').update(baseUrl).digest('hex')}.json`);
}
export function validateSession(value: unknown, baseUrl: string): Session {
  const session = sessionSchema.parse(value);
  if (session.baseUrl !== baseUrl) throw new Error('Session belongs to a different Brightspace host.');
  const host = new URL(baseUrl).hostname;
  // Restrict stored cookies to this exact tenant, not parent domains or SSO providers.
  if (session.cookies.some(c => c.domain.replace(/^\./, '') !== host)) throw new Error('Unexpected session cookie domain.');
  return session;
}
export async function readSession(config: Config, path = sessionPath(config.baseUrl)) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
    return validateSession(JSON.parse(await readFile(path, 'utf8')), config.baseUrl);
  } catch { throw new Error('No usable private Brightspace session. Run npm run login in your terminal.'); }
}
export async function saveSession(session: Session, path = sessionPath(session.baseUrl)) {
  validateSession(session, session.baseUrl);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.session-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(session)); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function deleteSession(config: Config) {
  await rm(sessionPath(config.baseUrl), { force: true });
}
