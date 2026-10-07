import { createProjectReader } from './project-reader.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createClient } from '@supabase/supabase-js';
import {
  researchCredentialMatches,
  tokenHashMatches,
} from './credential-utils.js';
import { createSiteFinderMcpServer } from './mcp/sitefinder-mcp.js';
import {
  applyResearchIngestMessage,
  parseResearchRunId,
} from './research-agent-ingest.js';
import {
  applyResearchCandidateReview,
  applyResearchRunRequest,
  applyResearchRunControl,
  parseResearchControlRequest,
  parseResearchRunRequest,
  parseResearchReviewRequest,
  ResearchActionError,
} from './research-agent-actions.js';
import {
  claimNextResearchRun,
  parseResearchQueueClaimRequest,
} from './research-agent-queue.js';

export function createSiteFinderApp(options = {}) {
  const env = options.env || process.env;
  const app = express();
  const supabaseUrl = env.VITE_SUPABASE_URL;
  const supabaseKey = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY;
  const researchIngestToken = env.RESEARCH_AGENT_INGEST_TOKEN;
  const researchIngestTokenHash = env.RESEARCH_AGENT_INGEST_TOKEN_SHA256;
  const siteFinderOrigin = String(env.SITEFINDER_URL || 'https://gsd-sitefinder.onrender.com').replace(/\/+$/, '');
  const oauthIssuer = supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/auth/v1` : null;
  const mcpTokenHash = env.SITEFINDER_MCP_TOKEN_SHA256
    || 'a536da901c6ba6c3cf18a33b049a1c274013d5574dd0349a70fe47a0cdc36954';
  const authClient = options.authClient || (supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    : null);
  const researchAdminClient = supabaseUrl && supabaseSecretKey
    ? createClient(supabaseUrl, supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    : null;

  const reader = options.reader || createProjectReader({ authClient, origin: siteFinderOrigin });
  function userReadClient(req) {
    if (req.siteFinderAuth?.type !== 'user' || !supabaseUrl || !supabaseKey) return null;
    return createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${req.siteFinderToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  function bearerToken(req) {
    const header = String(req.get('authorization') || '');
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  }

  function requireResearchIngestAuth(req, res, next) {
    if (!researchAdminClient || (!researchIngestToken && !researchIngestTokenHash)) {
      return res.status(503).json({ error: 'Research ingestion is not configured' });
    }
    if (!researchCredentialMatches(
      bearerToken(req),
      researchIngestToken,
      researchIngestTokenHash,
    )) {
      return res.status(401).json({ error: 'Invalid research ingestion credential' });
    }
    return next();
  }

  function isLocalPreview(req) {
    const address = req.socket.remoteAddress;
    return !env.RENDER
      && env.NODE_ENV !== 'production'
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
    if (tokenHashMatches(token, mcpTokenHash)) {
      req.siteFinderAuth = { type: 'mcp', email: 'sitefinder-mcp' };
      req.siteFinderToken = token;
      return next();
    }

    if (!token || !authClient) {
      setAuthChallenge(res);
      return res.status(401).json({ error: 'Authentication required. Connect using OAuth with your GSD account, or configure a valid server-only bearer token.', code: 'authentication_required' });
    }

    try {
      const { data, error } = await authClient.auth.getUser(token);
      if (error && (error.status >= 500 || error.name === 'AuthRetryableFetchError')) {
        return res.status(503).json({ error: 'Authentication service unavailable. Retry later; do not replace credentials.', code: 'authentication_unavailable' });
      }
      const email = String(data.user?.email || '').toLowerCase();
      if (error || !email.endsWith('@gsdecorating.com')) {
        setAuthChallenge(res);
        return res.status(401).json({ error: 'Session expired or unauthorised. Refresh the OAuth access token or reconnect with your @gsdecorating.com account.', code: 'invalid_session' });
      }
      req.siteFinderAuth = { type: 'user', email, userId: data.user.id };
      req.siteFinderToken = token;
      return next();
    } catch {
      return res.status(503).json({ error: 'Authentication service unavailable. Retry later; do not replace credentials.', code: 'authentication_unavailable' });
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
    if (env.SITEFINDER_URL) allowed.add(env.SITEFINDER_URL.replace(/\/+$/, ''));
    return allowed.has(origin)
      ? next()
      : res.status(403).json({ error: 'Origin not allowed' });
  }

  app.get('/api/projects', requireSiteFinderAuth, async (req, res) => {
    try {
      res.set('Cache-Control', 'private, max-age=300');
      res.json(await reader.listProjects(req.query, userReadClient(req)));
    } catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
  });
  app.get('/api/projects/:id', requireSiteFinderAuth, async (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await reader.getProject(req.params.id));
    } catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
  });

  app.post('/api/research/ingest', requireResearchIngestAuth, async (req, res) => {
    try {
      const result = await applyResearchIngestMessage(researchAdminClient, req.body);
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

  app.get('/api/research/runs/:runId/control', requireResearchIngestAuth, async (req, res) => {
    let runId;
    try {
      runId = parseResearchRunId(req.params.runId);
    } catch {
      return res.status(400).json({error: 'Invalid research run identifier'});
    }
    try {
      const {data, error} = await researchAdminClient
        .from('research_runs')
        .select('status')
        .eq('id', runId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({error: 'Research run not found'});
      res.set('Cache-Control', 'no-store');
      return res.json({status: data.status});
    } catch {
      return res.status(503).json({error: 'Research control state is unavailable'});
    }
  });

  app.post('/api/research/worker/claim', requireResearchIngestAuth, async (req, res) => {
    try {
      const input = parseResearchQueueClaimRequest(req.body);
      const result = await claimNextResearchRun(
        researchAdminClient,
        input,
      );
      res.set('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      const validationFailure = error?.name === 'ZodError';
      return res.status(validationFailure ? 400 : 503).json({
        error: validationFailure
          ? 'Invalid research worker claim'
          : 'Research queue is unavailable',
      });
    }
  });

  function researchActionError(res, error, fallback) {
    if (error?.name === 'ZodError') {
      return res.status(400).json({error: 'Invalid Research Agent action'});
    }
    if (error instanceof ResearchActionError) {
      return res.status(error.statusCode).json({error: error.message});
    }
    return res.status(503).json({error: fallback});
  }

  app.post('/api/research/runs/:runId/control', requireSiteFinderAuth, async (req, res) => {
    if (!researchAdminClient) {
      return res.status(503).json({error: 'Research controls are not configured'});
    }
    if (!req.siteFinderAuth?.userId) {
      return res.status(403).json({error: 'A signed-in GSD user is required'});
    }
    try {
      const input = parseResearchControlRequest(req.params.runId, req.body);
      const result = await applyResearchRunControl(
        researchAdminClient,
        input,
        req.siteFinderAuth.userId,
      );
      return res.json(result);
    } catch (error) {
      return researchActionError(
        res,
        error,
        'Research control state could not be updated',
      );
    }
  });

  app.post('/api/research/runs', requireSiteFinderAuth, async (req, res) => {
    if (!researchAdminClient) {
      return res.status(503).json({error: 'Research requests are not configured'});
    }
    if (!req.siteFinderAuth?.userId) {
      return res.status(403).json({error: 'A signed-in GSD user is required'});
    }
    try {
      const input = parseResearchRunRequest(req.body);
      const result = await applyResearchRunRequest(
        researchAdminClient,
        input,
        req.siteFinderAuth.userId,
      );
      return res.status(201).json(result);
    } catch (error) {
      return researchActionError(
        res,
        error,
        'Research request could not be queued',
      );
    }
  });

  app.post('/api/research/candidates/:candidateId/review', requireSiteFinderAuth, async (req, res) => {
    if (!researchAdminClient) {
      return res.status(503).json({error: 'Research reviews are not configured'});
    }
    if (!req.siteFinderAuth?.userId) {
      return res.status(403).json({error: 'A signed-in GSD user is required'});
    }
    try {
      const input = parseResearchReviewRequest(req.params.candidateId, req.body);
      const result = await applyResearchCandidateReview(
        researchAdminClient,
        input,
        req.siteFinderAuth.userId,
      );
      return res.json(result);
    } catch (error) {
      return researchActionError(
        res,
        error,
        'Research candidate decision could not be saved',
      );
    }
  });

  function protectedResourceMetadata() {
    return {
      resource: `${siteFinderOrigin}/mcp`,
      authorization_servers: oauthIssuer ? [oauthIssuer] : [],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
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

    const client = {
      origin: reader.origin,
      listProjects: () => reader.listProjects({}, userReadClient(req)),
      getProject: id => reader.getProject(id),
      health: () => reader.health(),
    };
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

  app.get('/health', (_req, res) => res.json(reader.health()));
  const root = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(root, 'dist')));
  app.use((req, res, next) => req.method === 'GET' ? res.sendFile(path.join(root, 'dist', 'index.html')) : next());
  return { app, reader };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, reader } = createSiteFinderApp();
  setInterval(() => reader.refresh().catch(error => console.error('CCS refresh failed:', error.message)), 30 * 60_000).unref();
  app.listen(process.env.PORT || 8787, '0.0.0.0', () => {
    console.log(`GSD SiteFinder listening on port ${process.env.PORT || 8787}`);
    reader.warm().catch(error => console.error('SiteFinder cache warm failed:', error.message));
  });
}
