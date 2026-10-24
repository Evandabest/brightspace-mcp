import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';
import { BrightspaceClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

const env = { BRIGHTSPACE_BASE_URL: 'https://school.example', BRIGHTSPACE_ACCESS_TOKEN: 'secret' };

test('MCP handshake, tool discovery, tool calls, validation, and error responses', async () => {
  const calls: string[] = [];
  const api = new BrightspaceClient(loadConfig(env), async input => {
    calls.push(String(input));
    return new Response(JSON.stringify({ private: 'secret' }), { status: 403, headers: { 'content-type': 'application/json' } });
  });
  const server = createServer(api);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 23);
    assert.ok(tools.filter(tool => tool.name !== 'download_document').every(tool => tool.annotations?.readOnlyHint));
    const result = await client.callTool({ name: 'get_grades', arguments: { course_id: '123' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /403/);
    assert.ok(!JSON.stringify(result.content).includes('secret'));
    const invalid = await client.callTool({ name: 'get_grades', arguments: { course_id: '../users' } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 1);
  } finally { await client.close(); await server.close(); }
});

test('actual stdio entrypoint initializes without polluting protocol stdout', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...env, PATH: process.env.PATH ?? '' }, stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.equal(result.tools.length, 23);
  } finally { await client.close(); }
});

test('unconfigured stdio server offers setup and actionable errors without needing credentials', async () => {
  const client = new Client({ name: 'setup-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'setup'));
    const setup = await client.callTool({ name: 'setup', arguments: {} });
    assert.notEqual(setup.isError, true);
    assert.match(JSON.stringify(setup.content), /npm run setup/);
    assert.match(JSON.stringify(setup.content), /configured\\": false/);
    const courses = await client.callTool({ name: 'get_courses', arguments: {} });
    assert.equal(courses.isError, true);
    assert.match(JSON.stringify(courses.content), /not configured/);
  } finally { await client.close(); }
});

test('browser-mode stdio starts without an OAuth token and explains missing login', async () => {
  const client = new Client({ name: 'browser-mode-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { PATH: process.env.PATH ?? '', BRIGHTSPACE_BASE_URL: 'https://no-session-mcp-integration.invalid', BRIGHTSPACE_AUTH_MODE: 'browser' }, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const setup = await client.callTool({ name: 'setup', arguments: {} });
    assert.match(JSON.stringify(setup.content), /Browser login/);
    const courses = await client.callTool({ name: 'get_courses', arguments: {} });
    assert.equal(courses.isError, true);
    assert.match(JSON.stringify(courses.content), /npm run login/);
    assert.ok(!JSON.stringify(courses.content).includes('ACCESS_TOKEN'));
  } finally { await client.close(); }
});

test('MCP document workflow discovers a file, downloads it, and returns a usable local path', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'brightspace-mcp-download-'));
  const api = new BrightspaceClient(loadConfig(env), async input => {
    if (String(input).endsWith('/file')) return new Response('%PDF-1.7 synthetic', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="slides.pdf"' } });
    return new Response(JSON.stringify({ Modules: [{ Title: 'Lecture', Topics: [{ TopicId: 2, Title: 'Slides', ActivityType: 1 }] }] }), { headers: { 'content-type': 'application/json' } });
  });
  const server = createServer(api), client = new Client({ name: 'download-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.find(tool => tool.name === 'download_document')?.annotations?.readOnlyHint, false);
    const list = await client.callTool({ name: 'list_course_documents', arguments: { course_id: '1' } });
    assert.notEqual(list.isError, true);
    const result = await client.callTool({ name: 'download_document', arguments: { course_id: '1', source: 'content_topic', topic_id: '2', destination_dir: directory } });
    assert.notEqual(result.isError, true);
    const item = (result.content as { type: string; text: string }[])[0];
    const metadata = JSON.parse(item.text);
    assert.equal(await readFile(metadata.path, 'utf8'), '%PDF-1.7 synthetic');
    const invalid = await client.callTool({ name: 'download_document', arguments: { course_id: '1', source: 'content_topic', destination_dir: directory } });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.content), /topic_id/);
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
