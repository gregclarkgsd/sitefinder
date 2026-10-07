import { deploymentVersion } from '../deployment-version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

const DEFAULT_BASE_URL = 'https://gsd-sitefinder.onrender.com';
const REQUEST_TIMEOUT_MS = 20_000;

const textResult = data => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const errorResult = error => ({
  content: [{
    type: 'text',
    text: JSON.stringify({ error: error instanceof Error ? error.message : String(error), code: error.code || 'project_read_failed', status: error.status || null }),
  }],
  isError: true,
});

const dates = feed => ({
  retrieved_at: feed.retrievedAt || null,
  marker_retrieved_at: feed.markerRetrievedAt || feed.updatedAt || null,
  last_successful_sync_at: feed.lastSuccessfulSyncAt || null,
  sync_status: feed.syncStatus || 'unavailable',
  source_publication_date: feed.sourcePublicationDate || null,
  source_last_modified_at: feed.sourceLastModifiedAt || null,
  stale: Boolean(feed.stale),
});

const clean = value => String(value || '').trim();
const lower = value => clean(value).toLowerCase();
const siteNumber = value => clean(value).replace(/^site/i, '');
export const inDateRange = (value, from, to) => {
  if (!from && !to) return true;
  if (!value) return false;
  const date = String(value).slice(0, 10);
  return (!from || date >= from) && (!to || date <= to);
};

function publicProject(project) {
  return {
    site_id: siteNumber(project.Id),
    project_name: clean(project.Name),
    main_contractor_id: clean(project.MainContractorId),
    main_contractor: clean(project.MainContractor),
    client_id: clean(project.ClientId),
    client: clean(project.Client),
    local_authority: clean(project.LaId),
    start_date: project.SiteStartDate || null,
    completion_date: project.SiteEndDate || null,
    site_closed: project.SiteClosed ?? null,
    latitude: Number.isFinite(Number(project.Latitude)) ? Number(project.Latitude) : null,
    longitude: Number.isFinite(Number(project.Longitude)) ? Number(project.Longitude) : null,
  };
}

export function createSiteFinderClient(
  baseUrl = process.env.SITEFINDER_URL || DEFAULT_BASE_URL,
  authToken = process.env.SITEFINDER_MCP_TOKEN,
) {
  const origin = String(baseUrl).replace(/\/+$/, '');

  async function request(pathname) {
    const headers = { Accept: 'application/json', 'User-Agent': 'GSD-SiteFinder-MCP/1.1' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(`${origin}${pathname}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const message = response.status === 401 ? 'SiteFinder authentication failed. Refresh your OAuth access token or reconnect with a GSD account; static-token connections require the configured bearer credential.' : response.status === 403 ? 'SiteFinder access denied. Use an authorised GSD account.' : `SiteFinder source request failed (${pathname}, HTTP ${response.status}). Retry later.`;
      throw Object.assign(new Error(message), { code: response.status === 401 ? 'authentication_required' : 'connection_failed', status: response.status });
    }
    return response.json();
  }

  return {
    origin,
    listProjects: () => request('/api/projects'),
    getProject: id => request(`/api/projects/${encodeURIComponent(siteNumber(id))}`),
    health: () => request('/health'),
  };
}

export function createSiteFinderMcpServer(options = {}) {
  const client = options.client || createSiteFinderClient(options.baseUrl);
  const server = new McpServer({
    name: 'gsd-sitefinder',
    version: deploymentVersion.mcpVersion,
  }, {
    instructions: 'Use these read-only tools to find and verify active CCS construction leads for GSD Decorating. Treat CCS contact data as business contact information and return the source URL when presenting a lead. Distinguish retrieved_at (this read), marker_retrieved_at (feed cache retrieval), last_successful_sync_at (successful database sync), source_publication_date (only when explicitly supplied by CCS), source_last_modified_at (HTTP metadata), and start_date/completion_date (project programme). Null dates are unknown; never substitute retrieval time for publication or sync time.',
  });

  server.registerTool('search_projects', {
    title: 'Search SiteFinder projects',
    description: 'Search active CCS construction projects by project, contractor, client or location. Results come from GSD SiteFinder and are read-only.',
    inputSchema: {
      query: z.string().trim().max(200).optional().describe('Free-text search across project, contractor, client, local authority and CCS site ID'),
      contractor: z.string().trim().max(200).optional().describe('Exact or partial main-contractor name'),
      client: z.string().trim().max(200).optional().describe('Exact or partial client name'),
      location: z.string().trim().max(200).optional().describe('Exact or partial local-authority/location name'),
      start_from: z.string().date().optional().describe('Only projects starting on or after this ISO date (YYYY-MM-DD)'),
      start_to: z.string().date().optional().describe('Only projects starting on or before this ISO date (YYYY-MM-DD)'),
      completion_from: z.string().date().optional().describe('Only projects completing on or after this ISO date (YYYY-MM-DD)'),
      completion_to: z.string().date().optional().describe('Only projects completing on or before this ISO date (YYYY-MM-DD)'),
      limit: z.number().int().min(1).max(100).default(25).describe('Maximum projects to return'),
      offset: z.number().int().min(0).max(10_000).default(0).describe('Number of matching projects to skip'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({
    query,
    contractor,
    client: clientFilter,
    location,
    start_from: startFrom,
    start_to: startTo,
    completion_from: completionFrom,
    completion_to: completionTo,
    limit,
    offset,
  }) => {
    try {
      const feed = await client.listProjects();
      const matches = (feed.projects || []).filter(project => {
        const haystack = lower([project.Name, project.MainContractor, project.Client, project.LaId, project.Id].join(' '));
        return (!query || haystack.includes(lower(query)))
          && (!contractor || lower(project.MainContractor).includes(lower(contractor)))
          && (!clientFilter || lower(project.Client).includes(lower(clientFilter)))
          && (!location || lower(project.LaId).includes(lower(location)))
          && inDateRange(project.SiteStartDate, startFrom, startTo)
          && inDateRange(project.SiteEndDate, completionFrom, completionTo);
      });
      return textResult({
        source: feed.source,
        ...dates(feed),
        total_matches: matches.length,
        offset,
        returned: Math.min(limit, Math.max(0, matches.length - offset)),
        projects: matches.slice(offset, offset + limit).map(publicProject),
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('get_project', {
    title: 'Get verified CCS project',
    description: 'Retrieve the complete public CCS detail record for one SiteFinder project, including published contact, address and dates.',
    inputSchema: {
      site_id: z.string().trim().regex(/^(?:site)?\d+$/i).describe('CCS site ID, with or without the "site" prefix'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ site_id }) => {
    try {
      const detail = await client.getProject(site_id);
      return textResult({
        site_id: siteNumber(site_id),
        project_name: clean(detail.Name || detail.SiteName),
        address: clean(detail.Address),
        local_authority: clean(detail.LocalAuthority || detail.LaId),
        main_contractor: clean(detail.MainContractor),
        client: clean(detail.Client),
        site_manager: clean([detail.SiteManagerFirstName, detail.SiteManagerLastName].filter(Boolean).join(' ')),
        site_manager_job_title: clean(detail.SiteManagerJobTitle),
        telephone: clean(detail.SiteManagerPhone),
        email: clean(detail.MarkerEmail),
        start_date: detail.SiteStartDate || null,
        completion_date: detail.SiteEndDate || null,
        summary: clean(detail.Summary || detail.ContractorText),
        latitude: Number.isFinite(Number(detail.Latitude)) ? Number(detail.Latitude) : null,
        longitude: Number.isFinite(Number(detail.Longitude)) ? Number(detail.Longitude) : null,
        source_url: detail.SourceUrl,
        retrieved_at: detail.retrievedAt || null,
        source_publication_date: detail.sourcePublicationDate || null,
        source_record_date: detail.sourceRecordDate || null,
        first_registered_at: detail.DateFirstRegistered || null,
        source_last_modified_at: detail.sourceLastModifiedAt || null,
        ccs_record: detail,
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('list_contractors', {
    title: 'List active contractors',
    description: 'Rank main contractors by their number of active SiteFinder projects.',
    inputSchema: {
      query: z.string().trim().max(200).optional().describe('Optional contractor-name search'),
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ query, limit }) => {
    try {
      const feed = await client.listProjects();
      const grouped = new Map();
      for (const project of feed.projects || []) {
        const name = clean(project.MainContractor) || 'Not published';
        if (query && !lower(name).includes(lower(query))) continue;
        const current = grouped.get(name) || { contractor: name, active_projects: 0, locations: new Set() };
        current.active_projects += 1;
        if (project.LaId) current.locations.add(project.LaId);
        grouped.set(name, current);
      }
      const contractors = [...grouped.values()]
        .map(item => ({ ...item, locations: [...item.locations].sort() }))
        .sort((a, b) => b.active_projects - a.active_projects || a.contractor.localeCompare(b.contractor))
        .slice(0, limit);
      return textResult({ ...dates(feed), returned: contractors.length, contractors });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('list_locations', {
    title: 'List active project locations',
    description: 'Rank local authorities/locations by their number of active SiteFinder projects.',
    inputSchema: {
      query: z.string().trim().max(200).optional().describe('Optional location-name search'),
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ query, limit }) => {
    try {
      const feed = await client.listProjects();
      const grouped = new Map();
      for (const project of feed.projects || []) {
        const location = clean(project.LaId) || 'Not published';
        if (query && !lower(location).includes(lower(query))) continue;
        grouped.set(location, (grouped.get(location) || 0) + 1);
      }
      const locations = [...grouped.entries()]
        .map(([location, active_projects]) => ({ location, active_projects }))
        .sort((a, b) => b.active_projects - a.active_projects || a.location.localeCompare(b.location))
        .slice(0, limit);
      return textResult({ ...dates(feed), returned: locations.length, locations });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('sitefinder_status', {
    title: 'Check SiteFinder status',
    description: 'Check whether SiteFinder is reachable and report the current active-project total and retrieval time, last successful database sync, source publication date if available, and deployed version. Retrieval times are not source publication or project programme dates.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async () => {
    try {
      const feed = await client.listProjects();
      const health = await client.health();
      return textResult({
        ok: Boolean(health.ok),
        sitefinder_url: client.origin,
        active_projects: Number(feed.total || 0),
        ...dates(feed),
        deployment: health.deployment || null,
        marker_cache_at: health.markerCacheAt || null,
        source: feed.source,
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}
