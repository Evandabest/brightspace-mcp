import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrightspaceClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_ACCESS_TOKEN: 'secret' });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('configuration rejects insecure hosts and never exposes tokens', () => {
  for (const host of ['http://school.example', 'https://user:secret@school.example', 'https://school.example/path']) {
    assert.throws(() => loadConfig({ BRIGHTSPACE_BASE_URL: host, BRIGHTSPACE_ACCESS_TOKEN: 'secret' }), e => e instanceof Error && !e.message.includes('secret'));
  }
});

test('enrollments follow bookmarks and send bearer auth only to configured origin', async () => {
  let count = 0;
  const client = new BrightspaceClient(config, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.baseUrl);
    assert.equal(url.pathname, '/d2l/api/lp/1.49/enrollments/myenrollments/');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret');
    count++;
    assert.equal(url.searchParams.get('bookmark'), count === 1 ? null : 'next');
    return json({ Items: [count], PagingInfo: { HasMoreItems: count === 1, Bookmark: 'next' } });
  });
  assert.deepEqual(await client.getCourses(), [1, 2]);
});

test('broken pagination fails instead of returning incomplete results', async () => {
  const client = new BrightspaceClient(config, async () => json({ Items: [], PagingInfo: { HasMoreItems: true, Bookmark: 'same' } }));
  await assert.rejects(client.getCourses(), /pagination/);
});

test('HTTP failures redact upstream bodies and network errors', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const client = new BrightspaceClient(config, async () => json({ token: 'secret' }, status));
    await assert.rejects(client.getGrades('123'), e => e instanceof Error && e.message.includes(String(status)) && !e.message.includes('secret'));
  }
  await assert.rejects(new BrightspaceClient(config, async () => { throw new Error('secret'); }).getCourses(), /request failed/);
});

test('IDs cannot inject URL paths and HTML login pages are rejected', async () => {
  const client = new BrightspaceClient(config, async () => new Response('<html>login</html>'));
  assert.throws(() => client.getGrades('../users'), /numeric/);
  await assert.rejects(client.getGrades('123'), /Expected JSON/);
});

test('deadlines sort, omit missing/out-of-range dates, and report inaccessible courses', async () => {
  const client = new BrightspaceClient(config, async input => String(input).includes('/2/') ? json({}, 403) : json([
    { Id: 1, Name: 'Later', DueDate: '2026-10-27T12:00:00Z' },
    { Id: 2, Name: 'Soon', DueDate: '2026-10-25T12:00:00Z' },
    { Id: 3, Name: 'No due date', DueDate: null },
    { Id: 4, Name: 'Old', DueDate: '2020-01-01T00:00:00Z' },
  ]));
  const result = await client.getUpcomingDeadlines(['1', '2'], 14, new Date('2026-10-24T00:00:00Z'));
  assert.deepEqual(result.deadlines.map(d => d.assignmentId), [2, 1]);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].courseId, '2');
});
