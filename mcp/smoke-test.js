#!/usr/bin/env node
import { checkProjectTools } from './smoke-checks.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'mcp', 'stdio.js')],
  cwd: root,
  env: {
    ...process.env,
    SITEFINDER_URL: process.env.SITEFINDER_URL || 'http://127.0.0.1:8787',
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'sitefinder-smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log(JSON.stringify(await checkProjectTools(client), null, 2));
} finally {
  await client.close();
}
