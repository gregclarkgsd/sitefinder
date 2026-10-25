import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import { parseRescoreRequest, RequestError, rescoreTenantForAdmin } from '../_shared/tender-pull.js';
import { createTenderPullDb } from '../_shared/tender-pull-db.js';

// Re-scores every stored notice for one workspace after its admin saves tender
// settings. verify_jwt is on; admin membership is checked with the caller's
// own token before the service-role client writes any lead scores.
Deno.serve(async (request) => {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let tenantId: string;
  try {
    ({ tenantId } = parseRescoreRequest(await request.json().catch(() => null)));
  } catch (error) {
    return Response.json({ error: String((error as Error)?.message ?? error) }, { status: error instanceof RequestError ? 400 : 500 });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: isAdmin, error: memberError } = await caller.rpc('is_tenant_member', { t: tenantId, min_role: 'admin' });
  if (memberError) return Response.json({ error: memberError.message }, { status: 401 });

  try {
    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const result = await rescoreTenantForAdmin({ db: createTenderPullDb(service), tenantId, isAdmin: isAdmin === true });
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return Response.json({ error: String((error as Error)?.message ?? error) }, { status: 500 });
  }
});
