import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { createSiteFinderApp } from './server.js';
import { createProjectReader } from './project-reader.js';
import { parseToolResult, checkProjectTools } from './mcp/smoke-checks.js';

const project = { Id: 'site123', Name: 'Test project', LaId: 'City of London', MainContractor: 'Test contractor', MainContractorId: '1', ClientId: '2', SiteStartDate: '2026-01-01', SiteEndDate: '2028-01-01' };
async function fixture(t, overrides = {}) {
  const tokens = [];
  const sourceRequests = [];
  const reader = createProjectReader({ fetchImpl: async url => {
    sourceRequests.push(url);
    return Response.json(url.endsWith('sitemarkers.json') ? [project] : { ...project, SiteName: project.Name },
      { headers: { 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT' } });
  }});
  const { app } = createSiteFinderApp({ env: { NODE_ENV: 'production', SITEFINDER_MCP_TOKEN_SHA256: createHash('sha256').update('test-static').digest('hex') },
    authClient: { auth: { getUser: async token => {
      tokens.push(token);
      if (token === 'unavailable') throw new Error('service failure');
      return token === 'valid' || token === 'refreshed'
        ? { data: { user: { id: 'user-1', email: 'test@gsdecorating.com' } }, error: null }
        : { data: { user: { id: 'other', email: 'other@example.com' } }, error: null };
    }}}, reader, ...overrides });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, tokens, sourceRequests, reader };
}
async function connect(t, origin, token) {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}
test('production rejects absent, expired and non-GSD credentials before any project read', async t => {
  const { origin, sourceRequests } = await fixture(t);
  for (const path of ['/api/projects', '/api/projects/123', '/mcp']) {
    for (const token of ['', 'expired', 'non-gsd']) {
      const response = await fetch(`${origin}${path}`, { method: path === '/mcp' ? 'POST' : 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
      assert.match((await response.json()).error, /OAuth|GSD|gsdecorating/);
    }
  }
  assert.equal(sourceRequests.length, 0);
});
test('OAuth MCP tools read projects directly and validate the bearer once per HTTP request', async t => {
  const { origin, tokens, sourceRequests } = await fixture(t);
  const client = await connect(t, origin, 'valid');
  await client.listTools(); // Drain the SDK's initialization notification before counting.
  const before = tokens.length;
  const result = parseToolResult(await client.callTool({ name: 'search_projects', arguments: { limit: 5 } }));
  assert.equal(tokens.length - before, 1, 'must not reauthenticate through an internal API request');
  assert.equal(result.projects[0].site_id, '123');
  assert.equal(result.source_publication_date, null);
  assert.ok(result.retrieved_at && result.marker_retrieved_at);
  const summary = await checkProjectTools(client);
  assert.equal(summary.verified_site_id, '123');
  assert.ok(summary.deployment.version);
  assert.ok(sourceRequests.every(url => url.startsWith('https://')));
  const api = await fetch(`${origin}/api/projects`, { headers: { Authorization: 'Bearer valid' } });
  assert.deepEqual((await api.json()).projects[0], project);
});
test('static credential remains read-only and cannot perform signed-in research actions', async t => {
  const { origin, tokens } = await fixture(t);
  const client = await connect(t, origin, 'test-static');
  assert.equal(parseToolResult(await client.callTool({ name: 'search_projects', arguments: {} })).projects.length, 1);
  assert.equal(tokens.length, 0);
  const response = await fetch(`${origin}/api/research/runs`, { method: 'POST', headers: { Authorization: 'Bearer test-static', 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok([403, 503].includes(response.status));
});
test('OAuth refresh exchanges the refresh token and the new access token works while the expired one fails', async t => {
  const { origin } = await fixture(t);
  const tokens = await refreshAuthorization(new URL('https://auth.example.com'), {
    metadata: { issuer: 'https://auth.example.com', token_endpoint: 'https://auth.example.com/token', token_endpoint_auth_methods_supported: ['none'] },
    clientInformation: { client_id: 'test-client', token_endpoint_auth_method: 'none' },
    refreshToken: 'test-refresh', resource: new URL(`${origin}/mcp`),
    fetchFn: async (url, options) => {
      assert.equal(String(url), 'https://auth.example.com/token');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'test-refresh');
      return Response.json({ access_token: 'refreshed', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
    },
  });
  assert.equal(tokens.refresh_token, 'rotated-refresh');
  const expired = await fetch(`${origin}/api/projects`, { headers: { Authorization: 'Bearer expired' } });
  assert.equal(expired.status, 401);
  const client = await connect(t, origin, tokens.access_token);
  assert.equal(parseToolResult(await client.callTool({ name: 'sitefinder_status', arguments: {} })).ok, true);
});
test('authentication outage returns a distinct 503; forbidden browser origins remain rejected', async t => {
  const { origin } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/projects`, { headers: { Authorization: 'Bearer unavailable' } })).status, 503);
  assert.equal((await fetch(`${origin}/mcp`, { method: 'POST', headers: { Origin: 'https://untrusted.example', Authorization: 'Bearer valid' } })).status, 403);
});
test('SDK reconnects automatically after a 401 by refreshing and rotating OAuth tokens', async t => {
  const { origin, tokens: validated } = await fixture(t);
  let saved = { access_token: 'expired', refresh_token: 'test-refresh', token_type: 'Bearer' };
  let refreshes = 0;
  const authProvider = {
    redirectUrl: 'http://localhost/callback',
    clientMetadata: { redirect_uris: ['http://localhost/callback'], scope: 'openid email profile offline_access' },
    clientInformation: () => ({ client_id: 'test-client', token_endpoint_auth_method: 'none' }),
    tokens: () => saved,
    saveTokens: next => { saved = next; },
    discoveryState: () => ({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: { issuer: 'https://auth.example.com', token_endpoint: 'https://auth.example.com/token', token_endpoint_auth_methods_supported: ['none'] },
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: ['https://auth.example.com'] },
    }),
    redirectToAuthorization: () => assert.fail('Valid refresh token should not require interactive sign-in'),
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    authProvider,
    fetch: async (url, options) => {
      if (String(url) === 'https://auth.example.com/token') {
        refreshes++;
        assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'test-refresh');
        return Response.json({ access_token: 'refreshed', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      return fetch(url, options);
    },
  });
  const client = new Client({ name: 'refresh-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(parseToolResult(await client.callTool({ name: 'search_projects', arguments: {} })).projects.length, 1);
  assert.equal(refreshes, 1);
  assert.equal(saved.refresh_token, 'rotated-refresh');
  assert.ok(validated.includes('expired') && validated.includes('refreshed'));
});
test('OAuth discovery advertises the live issuer and offline access for refresh-capable clients', async t => {
  const { origin } = await fixture(t, { env: { NODE_ENV: 'production', VITE_SUPABASE_URL: 'https://project.supabase.co' } });
  const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(metadata.authorization_servers, ['https://project.supabase.co/auth/v1']);
  assert.ok(metadata.scopes_supported.includes('offline_access'));
});
