import express from 'express';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createClient } from '@supabase/supabase-js';
import { createSiteFinderClient, createSiteFinderMcpServer } from './mcp/sitefinder-mcp.js';
import { applyResearchIngestMessage } from './research-agent-ingest.js';

const app = express();
const PORT = process.env.PORT || 8787;
const MARKERS = 'https://ccsfilestore.blob.core.windows.net/constructionmap/live/json/sitemarkers.json';
const DETAILS = 'https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails';
const CACHE_TTL_MS = 30 * 60_000;
const SCHEDULE_CACHE_TTL_MS = 15 * 60_000;
let markerCache = { at: 0, data: [], lastAttemptAt: 0, lastError: null };
let markerRefresh = null;
let scheduleCache = { at: 0, data: new Map(), lastAttemptAt: 0, lastError: null };
let scheduleRefresh = null;
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const researchIngestToken = process.env.RESEARCH_AGENT_INGEST_TOKEN;
const researchActorId = process.env.RESEARCH_AGENT_ACTOR_ID;
const siteFinderOrigin = String(process.env.SITEFINDER_URL || 'https://gsd-sitefinder.onrender.com').replace(/\/+$/, '');
const oauthIssuer = supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/auth/v1` : null;
const authClient = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  : null;
const researchAdminClient = supabaseUrl && supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  : null;

const targetAuthority = /London Borough|City of London|Westminster|Royal Borough of (Greenwich|Kensington and Chelsea)|Essex|Kent|Surrey|Hertfordshire|Berkshire|Buckinghamshire|Hampshire|Sussex|Oxfordshire|Bedfordshire|Harlow|Canterbury|Sevenoaks|Elmbridge|Wealden|Arun|Winchester|Oxford City|Luton|Dacorum|Watford|St Albans|Three Rivers|Welwyn|Stevenage|Broxbourne|Basildon|Braintree|Brentwood|Castle Point|Chelmsford|Colchester|Epping Forest|Maldon|Rochford|Southend|Thurrock|Ashford|Dartford|Dover|Folkestone|Gravesham|Maidstone|Medway|Swale|Thanet|Tonbridge|Tunbridge|Epsom|Guildford|Mole Valley|Reigate|Runnymede|Spelthorne|Tandridge|Waverley|Woking|Bracknell|Reading|Slough|Windsor|Wokingham|Milton Keynes|Basingstoke|Eastleigh|Fareham|Gosport|Hart District|Havant|New Forest|Portsmouth|Rushmoor|Southampton|Test Valley|Brighton|Chichester|Crawley|Horsham|Lewes|Mid Sussex|Rother|Worthing|Adur|Cherwell|West Oxfordshire|Vale of White Horse|Bedford Borough|Central Bedfordshire/i;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function bearerToken(req) {
  const header = String(req.get('authorization') || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function secretsMatch(left, right) {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function requireResearchIngestAuth(req, res, next) {
  if (!researchAdminClient || !researchIngestToken || !researchActorId) {
    return res.status(503).json({ error: 'Research ingestion is not configured' });
  }
  if (!secretsMatch(bearerToken(req), researchIngestToken)) {
    return res.status(401).json({ error: 'Invalid research ingestion credential' });
  }
  return next();
}

function isLocalPreview(req) {
  const address = req.socket.remoteAddress;
  return !process.env.RENDER
    && process.env.NODE_ENV !== 'production'
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function setAuthChallenge(res) {
  const resourceMetadata = `${siteFinderOrigin}/.well-known/oauth-protected-resource/mcp`;
  res.set('WWW-Authenticate', `Bearer realm="GSD SiteFinder", resource_metadata="${resourceMetadata}"`);
}

async function requireSiteFinderAuth(req, res, next) {
  if (isLocalPreview(req)) {
    req.siteFinderAuth = { type: 'local', email: 'local-preview' };
    return next();
  }

  const token = bearerToken(req);
  if (!token || !authClient) {
    setAuthChallenge(res);
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { data, error } = await authClient.auth.getUser(token);
    const email = String(data.user?.email || '').toLowerCase();
    if (error || !email.endsWith('@gsdecorating.com')) {
      setAuthChallenge(res);
      return res.status(401).json({ error: 'Invalid or unauthorised session' });
    }
    req.siteFinderAuth = { type: 'user', email, userId: data.user.id };
    req.siteFinderToken = token;
    return next();
  } catch {
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }
}

function validateMcpOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  const allowed = new Set([
    'https://gsd-sitefinder.onrender.com',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
  ]);
  if (process.env.SITEFINDER_URL) allowed.add(process.env.SITEFINDER_URL.replace(/\/+$/, ''));
  return allowed.has(origin)
    ? next()
    : res.status(403).json({ error: 'Origin not allowed' });
}

export function isTargetProject(project) {
  return targetAuthority.test(String(project.LaId || ''));
}

async function markers() {
  if (Date.now() - markerCache.at < CACHE_TTL_MS && markerCache.data.length) return markerCache.data;
  if (markerRefresh) return markerRefresh;
  markerRefresh = (async () => {
    markerCache.lastAttemptAt = Date.now();
    try {
      const response = await fetch(MARKERS, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`CCS marker feed returned ${response.status}`);
      const raw = await response.json();
      markerCache = {
        at: Date.now(),
        data: Array.isArray(raw) ? raw : [],
        lastAttemptAt: markerCache.lastAttemptAt,
        lastError: null,
      };
      return markerCache.data;
    } catch (error) {
      markerCache.lastError = error instanceof Error ? error.message : String(error);
      if (markerCache.data.length) return markerCache.data;
      throw error;
    } finally {
      markerRefresh = null;
    }
  })();
  return markerRefresh;
}

async function projectSchedules() {
  if (!authClient) return scheduleCache.data;
  if (Date.now() - scheduleCache.at < SCHEDULE_CACHE_TTL_MS && scheduleCache.data.size) return scheduleCache.data;
  if (scheduleRefresh) return scheduleRefresh;
  scheduleRefresh = (async () => {
    scheduleCache.lastAttemptAt = Date.now();
    try {
      const rows = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await authClient
          .from('ccs_project_schedule')
          .select('project_id,site_start_date,site_end_date,site_closed,is_active')
          .eq('is_active', true)
          .range(from, from + pageSize - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
      }
      scheduleCache = {
        at: Date.now(),
        data: new Map(rows.map(row => [String(row.project_id), row])),
        lastAttemptAt: scheduleCache.lastAttemptAt,
        lastError: null,
      };
      return scheduleCache.data;
    } catch (error) {
      scheduleCache.lastError = error instanceof Error ? error.message : String(error);
      if (scheduleCache.data.size) return scheduleCache.data;
      return new Map();
    } finally {
      scheduleRefresh = null;
    }
  })();
  return scheduleRefresh;
}

function withinDateRange(value, from, to) {
  if (!from && !to) return true;
  if (!value) return false;
  const date = String(value).slice(0, 10);
  return (!from || date >= from) && (!to || date <= to);
}

async function enrichedMarkers() {
  const [all, schedules] = await Promise.all([markers(), projectSchedules()]);
  return all.map(project => {
    const schedule = schedules.get(String(project.Id));
    return schedule ? {
      ...project,
      SiteStartDate: schedule.site_start_date,
      SiteEndDate: schedule.site_end_date,
      SiteClosed: schedule.site_closed,
    } : project;
  });
}

app.get('/api/projects', requireSiteFinderAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const region = String(req.query.region || 'target');
    const completionFrom = String(req.query.completion_from || '').slice(0, 10);
    const completionTo = String(req.query.completion_to || '').slice(0, 10);
    const all = await enrichedMarkers();
    const filtered = all.filter(x => {
      const haystack = [x.Name, x.Client, x.MainContractor, x.LaId].join(' ');
      return (region === 'all' || isTargetProject(x))
        && (!q || haystack.toLowerCase().includes(q))
        && withinDateRange(x.SiteEndDate, completionFrom, completionTo);
    });
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ source: MARKERS, updatedAt: new Date(markerCache.at).toISOString(), total: filtered.length, projects: filtered });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/projects/:id', requireSiteFinderAuth, async (req, res) => {
  try {
    const id = String(req.params.id).replace(/^site/, '');
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid CCS site ID' });
    const sourceUrl = `${DETAILS}/${id}/null`;
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`CCS detail feed returned ${response.status}`);
    res.set('Cache-Control', 'private, no-store');
    res.json({ ...(await response.json()), SourceUrl: sourceUrl });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/research/ingest', requireResearchIngestAuth, async (req, res) => {
  try {
    const result = await applyResearchIngestMessage(
      researchAdminClient,
      req.body,
      researchActorId,
    );
    res.status(202).json(result);
  } catch (error) {
    const validationFailure = error?.name === 'ZodError';
    res.status(validationFailure ? 400 : 502).json({
      error: validationFailure
        ? 'Invalid research event'
        : 'Research event could not be saved',
    });
  }
});

function protectedResourceMetadata() {
  return {
    resource: `${siteFinderOrigin}/mcp`,
    authorization_servers: oauthIssuer ? [oauthIssuer] : [],
    bearer_methods_supported: ['header'],
    scopes_supported: ['email', 'profile'],
    resource_documentation: `${siteFinderOrigin}/`,
  };
}

app.get([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
], (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(protectedResourceMetadata());
});

app.all('/mcp', validateMcpOrigin, requireSiteFinderAuth, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
  }

  const client = createSiteFinderClient(`http://127.0.0.1:${PORT}`, req.siteFinderToken);
  const server = createSiteFinderMcpServer({ client });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

app.use('/api', requireSiteFinderAuth, (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.get('/health', (_req, res) => {
  const markerAgeMs = markerCache.at ? Date.now() - markerCache.at : null;
  res.json({
    ok: Boolean(markerCache.data.length) || !markerCache.lastError,
    markerCacheStatus: markerCache.data.length
      ? (markerAgeMs > CACHE_TTL_MS ? 'stale' : 'ready')
      : (markerCache.lastError ? 'error' : 'warming'),
    markerCacheAt: markerCache.at || null,
    markerCacheProjects: markerCache.data.length,
    markerCacheLastAttemptAt: markerCache.lastAttemptAt || null,
    markerCacheLastError: markerCache.lastError,
    scheduleCacheAt: scheduleCache.at || null,
    scheduleCacheProjects: scheduleCache.data.size,
    scheduleCacheLastError: scheduleCache.lastError,
  });
});
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root, 'dist')));
app.use((req, res, next) => req.method === 'GET' ? res.sendFile(path.join(root, 'dist', 'index.html')) : next());
setInterval(() => markers().catch(error => console.error('CCS refresh failed:', error.message)), 30 * 60_000).unref();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`GSD SiteFinder listening on port ${PORT}`);
  Promise.all([markers(), projectSchedules()])
    .catch(error => console.error('SiteFinder cache warm failed:', error.message));
});
