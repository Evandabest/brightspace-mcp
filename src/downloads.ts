import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BrightspaceError } from './client.js';

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export function safeFilename(disposition: string | null, fallback: string) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = disposition?.match(/filename="([^"]*)"|filename=([^;]+)/i)?.slice(1).find(Boolean) ?? fallback;
  if (encoded) { try { name = decodeURIComponent(encoded); } catch { /* Use fallback filename. */ } }
  name = basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').trim();
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = fallback;
  return name.slice(0, 180);
}

/** Stream to an exclusive private file; remove partial files on every failure. */
export async function saveDownload(response: Response, directory: string, fallback: string, maxBytes = MAX_DOWNLOAD_BYTES) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new BrightspaceError(`Download failed (HTTP ${response.status}). Check file access and sign in again if needed.`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new BrightspaceError(`Document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB download limit.`);
  }
  if (!response.body) throw new BrightspaceError('The download returned no file data.');
  const name = safeFilename(response.headers.get('content-disposition'), fallback);
  const targetDirectory = resolve(directory);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const path = join(targetDirectory, `${randomUUID()}-${name}`);
  const file = await open(path, 'wx', 0o600);
  const reader = response.body.getReader();
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BrightspaceError('Document exceeds the download size limit.');
      hash.update(value);
      await file.writeFile(value);
    }
    if (bytes === 0) throw new BrightspaceError('The download returned an empty file.');
    return { path, filename: name, bytes, mimeType: response.headers.get('content-type') ?? 'application/octet-stream', sha256: hash.digest('hex') };
  } catch (error) {
    await reader.cancel().catch(() => {});
    await file.close();
    await unlink(path).catch(() => {});
    if (error instanceof BrightspaceError) throw error;
    throw new BrightspaceError('Download interrupted; partial file removed. Try again.');
  } finally { reader.releaseLock(); await file.close(); }
}
