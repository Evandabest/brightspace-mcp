#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { BrightspaceClient } from './client.js';
import { createServer } from './server.js';

try {
  if (process.argv[2] === 'setup') {
    const { runSetup } = await import('./setup.js');
    await runSetup();
  } else if (['login', 'logout'].includes(process.argv[2])) {
    const config = loadConfig();
    if (process.argv[2] === 'login') {
      const { runLogin } = await import('./browser-auth.js');
      await runLogin(config);
    } else {
      const { deleteSession } = await import('./session.js');
      await deleteSession(config);
      console.log('Local browser session removed. This does not revoke sessions on other devices.');
    }
  } else {
    let client: BrightspaceClient | undefined;
    try {
      const config = loadConfig();
      const fetcher = config.authMode === 'browser' ? (await import('./browser-auth.js')).sessionFetch(config) : fetch;
      client = new BrightspaceClient(config, fetcher);
    }
    catch (error) { console.error(`${error instanceof Error ? error.message : 'Configuration unavailable'} Run npm run setup in your terminal, or call the setup MCP tool for instructions.`); }
    const server = createServer(client);
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Brightspace MCP failed to start.');
  process.exitCode = 1;
}
