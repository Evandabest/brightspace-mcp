import { request, chromium, type APIRequestContext, type Browser, type BrowserContext } from 'playwright';
import { confirm } from '@inquirer/prompts';
import type { Config } from './config.js';
import { BrightspaceClient, BrightspaceError } from './client.js';
import { readSession, saveSession, SessionError, type Session } from './session.js';

/** Adapter for the shared GET-only client. Only token renewal uses POST. */
export function sessionFetch(
  config: Config, load: () => Promise<Session> = () => readSession(config),
  createContext: typeof request.newContext = options => request.newContext(options),
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== config.baseUrl || !url.pathname.startsWith('/d2l/api/') || init?.method !== 'GET') {
      throw new BrightspaceError('Session requests must be GETs to the configured Brightspace API.');
    }
    let session: Session;
    try { session = await load(); }
    catch (error) { throw new BrightspaceError(error instanceof SessionError ? error.message : 'No saved browser session. Run npm run login in your terminal.'); }
    const context = await createContext({ storageState: { cookies: session.cookies, origins: [] } });
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (session.csrfToken) headers['x-csrf-token'] = session.csrfToken;
      const get = () => context.get(url.href, { headers, maxRedirects: 0, timeout: 30_000 });
      let response = await get();
      // Some tenants require the same bearer token used by Brightspace's web frontend.
      // This is an internal session endpoint, not institutional OAuth app registration.
      if ([401, 403].includes(response.status()) && session.csrfToken) {
        const token = await mintToken(context, config, session.csrfToken);
        if (token) {
          headers.Authorization = `Bearer ${token}`;
          await response.dispose();
          response = await get();
        }
      }
      const type = response.headers()['content-type'] ?? '';
      if ((response.status() >= 300 && response.status() < 400) || response.status() === 401 ||
          (response.ok() && !type.includes('application/json'))) {
        throw new BrightspaceError('Browser session expired or sign-in is required. Run npm run login in your terminal.');
      }
      return new Response(new Uint8Array(await response.body()), { status: response.status(), headers: { 'content-type': type } });
    } catch (error) {
      if (error instanceof BrightspaceError) throw error;
      throw new BrightspaceError('Browser session request failed or timed out. Check your connection and try npm run login.');
    } finally { await context.dispose(); }
  };
}

async function mintToken(context: APIRequestContext, config: Config, csrfToken: string): Promise<string | undefined> {
  const response = await context.post(`${config.baseUrl}/d2l/lp/auth/oauth2/token`, {
    headers: { 'x-csrf-token': csrfToken }, form: { scope: '*:*:*' }, maxRedirects: 0, timeout: 30_000,
  });
  try {
    if (!response.ok() || !response.headers()['content-type']?.includes('application/json')) return;
    const value = await response.json();
    if (typeof value?.access_token === 'string' && value.access_token.length > 0) return value.access_token;
  } catch { return; }
  finally { await response.dispose(); }
}

export async function runLogin(config: Config) {
  if (config.authMode !== 'browser') throw new Error('Login is for browser authentication. Run npm run setup and choose browser login.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run npm run login in your own interactive terminal.');
  if (config.sessionStorage === 'passphrase') {
    const { promptSessionPassphrase } = await import('./unlock.js');
    await promptSessionPassphrase(true);
  }
  let browser: Browser;
  try { browser = await chromium.launch({ headless: false }); }
  catch { throw new Error('Could not open Chromium. Run npm run browser:install, then npm run login.'); }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${config.baseUrl}/d2l/home`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    console.log('Complete your school login and MFA in the browser. Navigate to your Brightspace homepage. Your password and MFA are never requested by this command.');
    if (!await confirm({ message: 'Have you finished signing in to Brightspace?', default: true })) return;
    const session = await captureSession(context, config);
    // Validate actual enrollment access before replacing a previously working session.
    const courses = await new BrightspaceClient(config, sessionFetch(config, async () => session)).getCourses();
    await saveSession(session, undefined, { storage: config.sessionStorage });
    console.log(`Signed in. Enrollment access verified (${courses.length} courses). Session saved privately on this computer. You can now use the MCP tools.`);
  } finally { await browser.close(); }
}

export async function captureSession(context: BrowserContext, config: Config): Promise<Session> {
    const home = context.pages().find(p => {
      try { const url = new URL(p.url()); return url.origin === config.baseUrl && /^\/d2l\/home(?:\/|$)/.test(url.pathname); }
      catch { return false; }
    });
    if (!home) throw new Error('No signed-in Brightspace home page found. Run npm run login and finish signing in.');
    const csrfToken = await home.evaluate(() => {
      // Brightspace frontend locations; best effort because tenant versions differ.
      const d2l = (globalThis as unknown as { D2L?: { LP?: { Web?: { Authentication?: { Xsrf?: { GetXsrfToken?: () => string } } } } } }).D2L;
      try {
        const value = d2l?.LP?.Web?.Authentication?.Xsrf?.GetXsrfToken?.();
        if (typeof value === 'string' && value) return value;
      } catch { /* Fall back to the frontend's meta tag. */ }
      return document.querySelector('meta[name="d2l-xsrf-token"]')?.getAttribute('content') ?? undefined;
    });
    const cookies = (await context.cookies(config.baseUrl)).filter(c =>
      c.domain.replace(/^\./, '') === new URL(config.baseUrl).hostname);
    if (!cookies.some(c => c.name === 'd2lSessionVal' && c.value)) throw new Error('No Brightspace session found. Finish signing in and run npm run login again.');
    return { baseUrl: config.baseUrl, cookies, csrfToken, savedAt: new Date().toISOString() };
}

/** Native streaming file requests; never forward cookies or tokens off the configured tenant. */
export function sessionDownloadFetch(
  config: Config, load: () => Promise<Session> = () => readSession(config),
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== config.baseUrl || init?.method !== 'GET' ||
        (!url.pathname.startsWith('/d2l/api/') && !url.pathname.startsWith('/content/enforced/'))) {
      throw new BrightspaceError('Download requests must be GETs to this Brightspace tenant.');
    }
    let session: Session;
    try { session = await load(); }
    catch (error) { throw new BrightspaceError(error instanceof SessionError ? error.message : 'Run npm run login before downloading course files.'); }
    const cookies = session.cookies.filter(cookie => cookie.domain.replace(/^\./, '') === url.hostname &&
      (cookie.expires < 0 || cookie.expires > Date.now() / 1000) &&
      (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)));
    const headers: Record<string, string> = { Accept: '*/*', Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') };
    if (session.csrfToken) headers['x-csrf-token'] = session.csrfToken;
    const get = () => fetcher(url, { method: 'GET', headers, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(60_000) });
    let response = await get();
    if ([401, 403].includes(response.status) && session.csrfToken) {
      const context = await request.newContext({ storageState: { cookies: session.cookies, origins: [] } });
      try {
        const token = await mintToken(context, config, session.csrfToken);
        if (token) {
          await response.body?.cancel();
          headers.Authorization = `Bearer ${token}`;
          response = await get();
        }
      } finally { await context.dispose(); }
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new BrightspaceError('Browser session expired. Run npm run login before downloading files.');
    }
    return response;
  };
}
