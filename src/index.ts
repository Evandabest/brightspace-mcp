#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { BrightspaceClient } from './client.js';
import { createServer } from './server.js';

try {
  const server = createServer(new BrightspaceClient(loadConfig()));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Brightspace MCP failed to start.');
  process.exitCode = 1;
}
