#!/usr/bin/env node
import { checkProjectTools } from './smoke-checks.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.SITEFINDER_MCP_URL || 'http://127.0.0.1:8787/mcp';
const token = process.env.SITEFINDER_MCP_TOKEN;
const requestInit = token
  ? { headers: { Authorization: `Bearer ${token}` } }
  : undefined;
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
const client = new Client({ name: 'sitefinder-http-smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log(JSON.stringify(await checkProjectTools(client), null, 2));
} finally {
  await client.close();
}
