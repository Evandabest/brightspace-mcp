import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrightspaceClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { safeFilename, saveDownload } from '../src/downloads.js';
import { sessionDownloadFetch } from '../src/browser-auth.js';

const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_ACCESS_TOKEN: 'secret' });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const pdf = () => new Response('%PDF-1.7 synthetic', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../../assignment.pdf"' } });

test('file names are decoded and stripped of traversal and platform-special names', () => {
  assert.equal(safeFilename('attachment; filename="../../assignment.pdf"', 'file.bin'), 'assignment.pdf');
  assert.equal(safeFilename("attachment; filename*=UTF-8''lecture%20slides.pdf", 'file.bin'), 'lecture slides.pdf');
  assert.equal(safeFilename('attachment; filename="C:\\secret\\lecture.pdf"', 'file.bin'), 'lecture.pdf');
  assert.equal(safeFilename('attachment; filename="CON"', 'file.bin'), 'file.bin');
});

test('downloads save exact binary bytes privately with metadata and never overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brightspace-docs-'));
  try {
    const client = new BrightspaceClient(config, async () => { throw new Error('JSON transport must not read files'); }, async (url, init) => {
      assert.equal(String(url), 'https://school.example/d2l/api/le/1.82/123/content/topics/456/file');
      assert.equal(init?.redirect, 'error'); return pdf();
    });
    const a = await client.downloadDocument('content_topic', '123', { topic_id: '456' }, dir);
    const b = await client.downloadDocument('content_topic', '123', { topic_id: '456' }, dir);
    assert.notEqual(a.path, b.path);
    assert.equal(await readFile(a.path, 'utf8'), '%PDF-1.7 synthetic');
    assert.equal(a.mimeType, 'application/pdf');
    assert.equal(a.bytes, Buffer.byteLength('%PDF-1.7 synthetic'));
    assert.equal(a.sha256.length, 64);
    assert.equal((await stat(a.path)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized, interrupted and empty streams leave no partial files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brightspace-docs-'));
  try {
    await assert.rejects(saveDownload(new Response('large', { headers: { 'content-length': '999' } }), dir, 'x', 3), /limit/);
    await assert.rejects(saveDownload(new Response('too large'), dir, 'x', 3), /limit/);
    await assert.rejects(saveDownload(new Response(''), dir, 'x'), /empty/);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, pull(controller) { controller.error(new Error('private-details')); } });
    await assert.rejects(saveDownload(new Response(stream), dir, 'x'), /partial file removed/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('login redirects and HTML login stubs are rejected while HTML lecture files work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brightspace-docs-'));
  try {
    for (const response of [new Response(null, { status: 302 }), new Response('<script>location="/d2l/login?sessionExpired=1"</script>', { headers: { 'content-type': 'text/html' } })]) {
      const client = new BrightspaceClient(config, async () => response);
      await assert.rejects(client.downloadDocument('content_topic', '123', { topic_id: '1' }, dir), /redirect|login page/i);
    }
    const client = new BrightspaceClient(config, async () => new Response('<h1>Lecture</h1>', { headers: { 'content-type': 'text/html' } }));
    const result = await client.downloadDocument('content_topic', '123', { topic_id: '1' }, dir);
    assert.equal(await readFile(result.path, 'utf8'), '<h1>Lecture</h1>');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('document discovery walks nested modules and reports file versus external-link topics', async () => {
  const client = new BrightspaceClient(config, async () => json({ Modules: [{ Title: 'Week 1', Topics: [{ TopicId: 1, Title: 'Slides', TopicType: 1 }], Modules: [
    { Title: 'More', Topics: [{ TopicId: 2, Title: 'Reading', TopicType: 3, Url: 'https://external.example/book.pdf' }] },
  ] }] }));
  const result = await client.listCourseDocuments('123');
  assert.equal(result.documents.length, 2);
  assert.deepEqual(result.documents[1].modulePath, ['Week 1', 'More']);
  assert.equal(result.documents[0].downloadable, true);
  assert.equal(result.documents[1].downloadable, false);
});

test('direct course URLs reject other hosts, other courses, encoded traversal and userinfo before any network call', async () => {
  let calls = 0;
  const dir = await mkdtemp(join(tmpdir(), 'brightspace-docs-'));
  const client = new BrightspaceClient(config, async () => { calls++; return pdf(); });
  try {
    for (const url of ['https://external.example/x.pdf', '/content/enforced/124-course/x.pdf', '/content/enforced/123-course/%2fsecret', 'https://user:secret@school.example/content/enforced/123-course/x.pdf', '/d2l/api/le/1.82/other']) {
      await assert.rejects(client.downloadDocument('course_file', '123', { url }, dir));
    }
    assert.equal(calls, 0);
    await client.downloadDocument('course_file', '123', { url: '/content/enforced/123-course/lecture.pdf' }, dir);
    assert.equal(calls, 1);
    await assert.rejects(client.downloadDocument('content_topic', '123', {}, dir), /requires a numeric topic_id/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('submitted files must appear in the signed-in student’s own submission listing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brightspace-docs-'));
  let bytesFetched = false;
  const client = new BrightspaceClient(config, async () => json([{ Submissions: [{ Id: 1, Files: [{ FileId: 2 }] }] }]), async () => { bytesFetched = true; return pdf(); });
  try {
    await assert.rejects(client.downloadDocument('submission_file', '123', { assignment_id: '3', submission_id: '999', file_id: '2' }, dir), /own submissions/);
    assert.equal(bytesFetched, false);
    await client.downloadDocument('submission_file', '123', { assignment_id: '3', submission_id: '1', file_id: '2' }, dir);
    assert.equal(bytesFetched, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser downloads stream with tenant-scoped live cookies and never follow redirects', async () => {
  const session = { baseUrl: config.baseUrl, savedAt: new Date().toISOString(), cookies: [
    { name: 'd2lSessionVal', value: 'private', domain: 'school.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
    { name: 'expired', value: 'no', domain: 'school.example', path: '/', expires: 1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
    { name: 'other-path', value: 'no', domain: 'school.example', path: '/other', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
  ] };
  let calls = 0;
  const fetcher = sessionDownloadFetch(config, async () => session, async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).Cookie, 'd2lSessionVal=private');
    return pdf();
  });
  const response = await fetcher('https://school.example/content/enforced/123-course/x.pdf', { method: 'GET' });
  assert.match(await response.text(), /PDF/);
  await assert.rejects(fetcher('https://external.example/content/enforced/123/x.pdf', { method: 'GET' }));
  assert.equal(calls, 1);
});

test('CUNY TOC activity types identify documents without TopicType and detect course-file links', async () => {
  const client = new BrightspaceClient(config, async () => json({ Modules: [{ Title: 'Module', Modules: [], Topics: [
    { TopicId: 1, Title: 'Slides', ActivityType: 1, Url: '/content/enforced/123-course/slides.pdf' },
    { TopicId: 2, Title: 'Linked file', ActivityType: 2, Url: '/content/enforced/123-course/handout.docx' },
    { TopicId: 3, Title: 'Quiz', ActivityType: 4, Url: '/d2l/lms/quizzing/quiz.d2l' },
  ] }] }));
  const { documents } = await client.listCourseDocuments('123');
  assert.deepEqual(documents.map(doc => doc.downloadable), [true, true, false]);
  assert.deepEqual(documents.map(doc => doc.downloadSource), ['content_topic', 'course_file', null]);
});
