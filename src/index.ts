#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { BrightspaceClient } from './client.js';
import { createServer } from './server.js';

try {
  if (process.argv[2] === 'setup') {
    const { runSetup } = await import('./setup.js');
    await runSetup();
  } else {
    let client: BrightspaceClient | undefined;
    try { client = new BrightspaceClient(loadConfig()); }
    catch (error) { console.error(`${error instanceof Error ? error.message : 'Configuration unavailable'} Run npm run setup in your terminal, or call the setup MCP tool for instructions.`); }
    const server = createServer(client);
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Brightspace MCP failed to start.');
  process.exitCode = 1;
}
