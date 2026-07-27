#!/usr/bin/env node

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
  const tools = await client.listTools();
  const search = await client.callTool({
    name: 'search_projects',
    arguments: { query: '22 Hill Street', limit: 5 },
  });
  const data = JSON.parse(search.content[0].text);
  const expectedTools = ['get_project', 'list_contractors', 'list_locations', 'search_projects', 'sitefinder_status'];
  const actualTools = tools.tools.map(tool => tool.name).sort();

  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected tools: ${actualTools.join(', ')}`);
  }
  const project = data.projects.find(item => item.site_id === '518253');
  if (!project) {
    throw new Error('HTTP MCP project search did not return CCS 518253');
  }
  if (project.main_contractor_id !== '500002' || !project.client_id) {
    throw new Error('HTTP MCP project search did not return stable CCS join keys');
  }

  console.log(JSON.stringify({
    ok: true,
    transport: 'streamable-http',
    endpoint: url,
    tools: actualTools,
    search_matches: data.total_matches,
  }, null, 2));
} finally {
  await client.close();
}
