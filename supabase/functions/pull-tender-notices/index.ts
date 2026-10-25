import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import {
  parsePullRequest,
  RequestError,
  runTenderPull,
  secretMatches,
} from '../_shared/tender-pull.js';
import { createTenderPullDb } from '../_shared/tender-pull-db.js';

// Reads the public Find a Tender and Contracts Finder feeds (GET only) and
// stores notices. Called by pg_cron once it is approved and installed by hand;
// see README "Tenders". verify_jwt is off; the shared secret header is the gate.
Deno.serve(async (request) => {
  if (!secretMatches(Deno.env.get('TENDER_PULL_SECRET') ?? '', request.headers.get('x-tender-pull-secret') ?? '')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (request.method !== 'POST' && request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let pullRequest;
  try {
    pullRequest = parsePullRequest(request.url, new Date());
  } catch (error) {
    const status = error instanceof RequestError ? 400 : 500;
    return Response.json({ error: String((error as Error)?.message ?? error) }, { status });
  }

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  try {
    const result = await runTenderPull({
      db: createTenderPullDb(client),
      request: pullRequest,
      now: new Date(),
      baseUrls: {
        fts: Deno.env.get('TENDER_FTS_BASE_URL') || undefined,
        cf: Deno.env.get('TENDER_CF_BASE_URL') || undefined,
      },
    });
    return Response.json(result, { status: result.status === 'failed' ? 502 : 200 });
  } catch (error) {
    return Response.json({ status: 'failed', error: String((error as Error)?.message ?? error) }, { status: 500 });
  }
});
