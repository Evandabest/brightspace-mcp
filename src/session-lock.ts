import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Atomic mkdir works across MCP processes, unlike an in-memory promise queue. */
export async function withSessionLock<T>(path: string, action: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        // Do not steal a lock on a timer: the owner may still be writing a key.
        throw new Error('Another Brightspace session operation is running or was interrupted. Close other Brightspace MCP processes and retry. If the lock is stale, remove the matching .json.lock directory under ~/.brightspace-mcp/sessions only after those processes have stopped.');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
