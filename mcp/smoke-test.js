#!/usr/bin/env node

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
    SITEFINDER_URL: process.env.SITEFINDER_URL || 'https://gsd-sitefinder.onrender.com',
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'sitefinder-smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const status = await client.callTool({ name: 'sitefinder_status', arguments: {} });
  const search = await client.callTool({
    name: 'search_projects',
    arguments: { query: '22 Hill Street', limit: 5 },
  });
  const detail = await client.callTool({
    name: 'get_project',
    arguments: { site_id: '518253' },
  });
  const contractors = await client.callTool({
    name: 'list_contractors',
    arguments: { query: 'Overbury', limit: 5 },
  });
  const locations = await client.callTool({
    name: 'list_locations',
    arguments: { query: 'City of London', limit: 5 },
  });

  const statusData = JSON.parse(status.content[0].text);
  const searchData = JSON.parse(search.content[0].text);
  const detailData = JSON.parse(detail.content[0].text);
  const contractorData = JSON.parse(contractors.content[0].text);
  const locationData = JSON.parse(locations.content[0].text);
  const expectedTools = ['get_project', 'list_contractors', 'list_locations', 'search_projects', 'sitefinder_status'];
  const actualTools = tools.tools.map(tool => tool.name).sort();

  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected tools: ${actualTools.join(', ')}`);
  }
  if (!statusData.ok || statusData.active_projects < 1) {
    throw new Error('SiteFinder status did not report active projects');
  }
  if (!searchData.projects.some(project => project.site_id === '518253')) {
    throw new Error('Project search did not return CCS 518253');
  }
  if (detailData.site_id !== '518253' || !detailData.source_url) {
    throw new Error('Project detail did not return the verified CCS source');
  }
  if (!contractorData.contractors.some(item => item.contractor === 'Overbury plc')) {
    throw new Error('Contractor listing did not return Overbury plc');
  }
  if (!locationData.locations.some(item => item.location === 'City of London')) {
    throw new Error('Location listing did not return City of London');
  }

  console.log(JSON.stringify({
    ok: true,
    tools: actualTools,
    active_projects: statusData.active_projects,
    search_matches: searchData.total_matches,
    verified_project: detailData.project_name,
  }, null, 2));
} finally {
  await client.close();
}
