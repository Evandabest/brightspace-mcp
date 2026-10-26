import { z } from 'zod';

const schema = z.object({
  BRIGHTSPACE_BASE_URL: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  }, 'Must be an HTTPS origin without credentials, path, query, or fragment'),
  BRIGHTSPACE_AUTH_MODE: z.enum(['oauth', 'browser']).default('oauth'),
  BRIGHTSPACE_ACCESS_TOKEN: z.string().trim().min(1).refine(v => !/[\r\n]/.test(v)).optional(),
  BRIGHTSPACE_LP_VERSION: z.string().regex(/^\d+\.\d+$/).default('1.49'),
  BRIGHTSPACE_LE_VERSION: z.string().regex(/^\d+\.\d+$/).default('1.82'),
  BRIGHTSPACE_SESSION_STORAGE: z.enum(['keychain', 'passphrase']).default('keychain'),
  // Reject the obsolete plaintext opt-out rather than silently weakening storage.
  BRIGHTSPACE_INSECURE_PLAINTEXT_SESSION: z.literal('0').optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.refine(value => value.BRIGHTSPACE_AUTH_MODE === 'browser' || !!value.BRIGHTSPACE_ACCESS_TOKEN, { path: ['BRIGHTSPACE_ACCESS_TOKEN'] }).safeParse(env);
  if (!result.success) {
    // Never include supplied values (especially tokens) in startup errors.
    throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  }
  return {
    baseUrl: new URL(result.data.BRIGHTSPACE_BASE_URL).origin,
    accessToken: result.data.BRIGHTSPACE_AUTH_MODE === 'oauth' ? result.data.BRIGHTSPACE_ACCESS_TOKEN : undefined,
    authMode: result.data.BRIGHTSPACE_AUTH_MODE,
    lpVersion: result.data.BRIGHTSPACE_LP_VERSION,
    leVersion: result.data.BRIGHTSPACE_LE_VERSION,
    sessionStorage: result.data.BRIGHTSPACE_SESSION_STORAGE,
  };
}
export type Config = ReturnType<typeof loadConfig>;
