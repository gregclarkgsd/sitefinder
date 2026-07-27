#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSiteFinderMcpServer } from './sitefinder-mcp.js';

const server = createSiteFinderMcpServer();
const transport = new StdioServerTransport();

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

try {
  await server.connect(transport);
} catch (error) {
  console.error('GSD SiteFinder MCP failed to start:', error);
  process.exit(1);
}
