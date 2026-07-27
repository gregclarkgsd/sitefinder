import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createClient } from '@supabase/supabase-js';
import { createSiteFinderClient, createSiteFinderMcpServer } from './mcp/sitefinder-mcp.js';

const app = express();
const PORT = process.env.PORT || 8787;
const MARKERS = 'https://ccsfilestore.blob.core.windows.net/constructionmap/live/json/sitemarkers.json';
const DETAILS = 'https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails';
let markerCache = { at: 0, data: [] };
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const mcpTokenHash = process.env.SITEFINDER_MCP_TOKEN_SHA256
  || 'a536da901c6ba6c3cf18a33b049a1c274013d5574dd0349a70fe47a0cdc36954';
const authClient = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
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

function tokenHashMatches(candidate, expectedHash) {
  if (!candidate || !expectedHash) return false;
  const left = Buffer.from(createHash('sha256').update(String(candidate)).digest('hex'));
  const right = Buffer.from(String(expectedHash));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function isLocalPreview(req) {
  const address = req.socket.remoteAddress;
  return !process.env.RENDER
    && process.env.NODE_ENV !== 'production'
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

async function requireSiteFinderAuth(req, res, next) {
  if (isLocalPreview(req)) {
    req.siteFinderAuth = { type: 'local', email: 'local-preview' };
    return next();
  }

  const token = bearerToken(req);
  if (tokenHashMatches(token, mcpTokenHash)) {
    req.siteFinderAuth = { type: 'mcp', email: 'sitefinder-mcp' };
    req.siteFinderToken = token;
    return next();
  }

  if (!token || !authClient) {
    res.set('WWW-Authenticate', 'Bearer realm="GSD SiteFinder"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { data, error } = await authClient.auth.getUser(token);
    const email = String(data.user?.email || '').toLowerCase();
    if (error || !email.endsWith('@gsdecorating.com')) {
      res.set('WWW-Authenticate', 'Bearer realm="GSD SiteFinder"');
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
  if (Date.now() - markerCache.at < 30 * 60_000 && markerCache.data.length) return markerCache.data;
  const response = await fetch(MARKERS);
  if (!response.ok) throw new Error(`CCS marker feed returned ${response.status}`);
  const raw = await response.json();
  markerCache = { at: Date.now(), data: raw };
  return raw;
}

app.get('/api/projects', requireSiteFinderAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const region = String(req.query.region || 'target');
    const all = await markers();
    const filtered = all.filter(x => {
      const haystack = [x.Name, x.Client, x.MainContractor, x.LaId].join(' ');
      return (region === 'all' || isTargetProject(x)) && (!q || haystack.toLowerCase().includes(q));
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

app.get('/health', (_req, res) => res.json({ ok: true, markerCacheAt: markerCache.at || null }));
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root, 'dist')));
app.use((req, res, next) => req.method === 'GET' ? res.sendFile(path.join(root, 'dist', 'index.html')) : next());
setInterval(() => markers().catch(error => console.error('CCS refresh failed:', error.message)), 30 * 60_000).unref();
app.listen(PORT, '0.0.0.0', () => console.log(`GSD SiteFinder listening on port ${PORT}`));
