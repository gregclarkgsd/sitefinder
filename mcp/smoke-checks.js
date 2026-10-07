import assert from 'node:assert/strict';
export function parseToolResult(result) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (result.isError) throw new Error(`MCP tool failed: ${text || 'No error details'}`);
  return JSON.parse(text);
}
export async function checkProjectTools(client) {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(),
    ['get_project', 'list_contractors', 'list_locations', 'search_projects', 'sitefinder_status']);
  const call = async (name, args = {}) => parseToolResult(await client.callTool({ name, arguments: args }));
  const status = await call('sitefinder_status');
  assert.equal(status.ok, true, 'SiteFinder source health must be ready');
  assert.ok(status.deployment?.version && status.deployment?.mcpVersion, 'Server must report its deployed version');
  assert.ok(status.retrieved_at && status.marker_retrieved_at, 'Retrieval dates must be reported');
  const search = await call('search_projects', { limit: 5 });
  assert.ok(search.projects.length > 0, 'Live feed must contain projects');
  const project = search.projects[0];
  const exact = await call('search_projects', { query: project.site_id, limit: 100 });
  assert.ok(exact.projects.some(item => item.site_id === project.site_id));
  const detail = await call('get_project', { site_id: project.site_id });
  assert.equal(detail.site_id, project.site_id);
  assert.ok(detail.source_url);
  assert.ok(detail.project_name, 'CCS detail must contain a project name');
  const completionFrom = new Date().toISOString().slice(0, 10);
  const window = await call('search_projects', { completion_from: completionFrom, limit: 5 });
  assert.ok(window.projects.every(item => item.completion_date && item.completion_date.slice(0, 10) >= completionFrom));
  const contractors = await call('list_contractors', { limit: 5 });
  const locations = await call('list_locations', { limit: 5 });
  assert.ok(contractors.contractors.length && locations.locations.length);
  return { ok: true, tools: tools.tools.map(tool => tool.name), active_projects: status.active_projects,
    verified_site_id: project.site_id, deployment: status.deployment };
}
