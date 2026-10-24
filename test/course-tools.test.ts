import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrightspaceClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
const config = loadConfig({ BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_ACCESS_TOKEN: 'secret' });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('announcement and discussion reads use the documented scoped GET routes', async () => {
  const paths: string[] = [];
  const client = new BrightspaceClient(config, async (input, init) => {
    assert.equal(init?.method, 'GET'); paths.push(new URL(String(input)).pathname); return json([]);
  });
  await client.getAnnouncements('1'); await client.getAnnouncement('1', '2');
  await client.getDiscussionForums('1'); await client.getDiscussionTopics('1', '3'); await client.getDiscussionPost('1', '3', '4', '5');
  assert.deepEqual(paths, ['/d2l/api/le/1.82/1/news/', '/d2l/api/le/1.82/1/news/2', '/d2l/api/le/1.82/1/discussions/forums/', '/d2l/api/le/1.82/1/discussions/forums/3/topics/', '/d2l/api/le/1.82/1/discussions/forums/3/topics/4/posts/5']);
});

test('object pages follow same-route Next URLs with preserved filters', async () => {
  let count = 0;
  const client = new BrightspaceClient(config, async input => {
    count++;
    const url = new URL(String(input));
    assert.equal(url.pathname, '/d2l/api/le/1.82/1/classlist/paged/');
    assert.equal(url.searchParams.get('bookmark'), count === 1 ? null : 'next');
    return json({ Objects: [{ id: count }], Next: count === 1 ? '?bookmark=next' : null });
  });
  assert.deepEqual(await client.getClasslist('1'), [{ id: 1 }, { id: 2 }]);
});

test('pagination rejects hostile hosts, changed routes and loops without sending a second request', async () => {
  for (const next of ['https://attacker.example/steal', '/d2l/api/le/1.82/999/classlist/paged/', 'https://user:secret@school.example/d2l/api/le/1.82/1/classlist/paged/', '/d2l/api/le/1.82/1/classlist/paged/']) {
    let calls = 0;
    const client = new BrightspaceClient(config, async () => { calls++; return json({ Objects: [], Next: next }); });
    await assert.rejects(client.getClasslist('1'), /pagination/);
    assert.equal(calls, 1);
  }
});

test('discussion pages report continuation and thread filters without claiming full results', async () => {
  const client = new BrightspaceClient(config, async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('pageNumber'), '2');
    assert.equal(url.searchParams.get('pageSize'), '1');
    assert.equal(url.searchParams.get('threadId'), '5');
    return json([{ PostId: 7, Message: { Html: '<p>Discussion</p>' } }]);
  });
  const result = await client.getDiscussionPosts('1', '3', '4', 2, 1, '5');
  assert.equal(result.nextPage, 3);
  assert.equal(result.posts.length, 1);
});

test('legacy group membership filters to the authenticated user and reports hidden categories', async () => {
  const client = new BrightspaceClient(config, async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/users/whoami')) return json({ Identifier: '42' });
    if (path.endsWith('/groupcategories/')) return json([{ GroupCategoryId: 2, Name: 'Projects' }, { GroupCategoryId: 3, Name: 'Hidden' }]);
    if (path.includes('/groupcategories/3/')) return json({}, 403);
    return json([{ GroupId: 8, Name: 'Mine', Enrollments: [42, 43] }, { GroupId: 9, Name: 'Other', Enrollments: [99] }]);
  });
  const result = await client.getGroupMembership('1');
  assert.equal(result.groups.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.errors.length, 1);
});

test('newer LP versions use the paged own-groups route directly', async () => {
  const client = new BrightspaceClient({ ...config, lpVersion: '1.64' }, async input => {
    assert.equal(new URL(String(input)).pathname, '/d2l/api/lp/1.64/1/groups/');
    return json({ Objects: [{ GroupId: 8, Name: 'Mine' }], Next: null });
  });
  assert.equal((await client.getGroupMembership('1')).groups.length, 1);
});

test('quiz contents respect permission failures and never start attempts', async () => {
  const methods: string[] = [];
  const client = new BrightspaceClient(config, async (input, init) => {
    methods.push(init!.method!);
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/questions/')) return json({ private: 'secret' }, 403);
    if (path.endsWith('/quizzes/')) return json({ Objects: [{ QuizId: 2 }], Next: null });
    return json({ QuizId: 2, Instructions: { Text: { Html: '<p>Instructions</p>' } } });
  });
  assert.equal((await client.getQuizzes('1')).length, 1);
  await client.getQuizDetails('1', '2');
  await assert.rejects(client.getQuizQuestions('1', '2'), /403/);
  assert.deepEqual(methods, ['GET', 'GET', 'GET']);
});

test('calendar uses ISO date window filters and rejects invalid or excessively long windows', async () => {
  let count = 0;
  const client = new BrightspaceClient(config, async input => {
    count++;
    const url = new URL(String(input));
    assert.equal(url.pathname, '/d2l/api/le/1.82/1/calendar/events/myEvents/');
    assert.equal(url.searchParams.get('startDateTime'), '2026-10-01T00:00:00.000Z');
    assert.equal(url.searchParams.get('endDateTime'), '2026-10-15T00:00:00.000Z');
    return json({ Objects: [{ CalendarEventId: 8 }], Next: null });
  });
  assert.equal((await client.getCalendarEvents('1', '2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z')).length, 1);
  assert.throws(() => client.getCalendarEvents('1', '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z'), /end_time/);
  assert.throws(() => client.getCalendarEvents('1', '2026-10-01T00:00:00Z', '2028-10-01T00:00:00Z'), /366/);
  assert.equal(count, 1);
});

test('submission status is scoped to own history and distinguishes no online submission from completion', async () => {
  const client = new BrightspaceClient(config, async input => {
    const path = new URL(String(input)).pathname;
    assert.match(path, /submissions\/mysubmissions\/$/);
    if (path.includes('/folders/2/')) return json([{ Submissions: [], CompletionDate: '2026-10-01T00:00:00Z' }]);
    return json([{ Submissions: [{ Id: 1, SubmissionDate: '2026-09-30T00:00:00Z' }, { Id: 2, SubmissionDate: '2026-10-01T00:00:00Z' }], Feedback: { IsGraded: true } }]);
  });
  const result = await client.getSubmissionStatus('1', '1');
  assert.equal(result.submitted, true); assert.equal(result.submissionCount, 2);
  assert.equal(result.latestSubmissionDate, '2026-10-01T00:00:00Z');
  const paper = await client.getSubmissionStatus('1', '2');
  assert.equal(paper.submitted, false); assert.ok(paper.completionDate);
});
