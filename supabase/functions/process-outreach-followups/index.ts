import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import {
  classifyFollowupStateAfterInvocation,
  classifyFollowupResponse,
  summariseFollowupResults,
} from '../_shared/gmail-reliability.js';

const SEND_REQUEST_TIMEOUT_MS = 60_000;
const PROCESSING_BUDGET_MS = 110_000;
const MINIMUM_REQUEST_BUDGET_MS = 5_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async req => {
  const startedAt = Date.now();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = Deno.env.get('OUTREACH_CRON_SECRET');
  if (!cronSecret || req.headers.get('x-sitefinder-cron-secret') !== cronSecret) {
    return json({ error: 'Unauthorised' }, 401);
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Follow-up processor not configured' }, 503);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: due, error, count } = await db
    .from('outreach_leads')
    .select('id,follow_up_step,gmail_message_id', { count: 'exact' })
    .in('status', ['sent', 'followup_due'])
    .eq('follow_up_enabled', true)
    .lt('follow_up_step', 2)
    .lte('next_follow_up_at', new Date().toISOString())
    .order('next_follow_up_at', { ascending: true })
    .limit(20)
    .abortSignal(AbortSignal.timeout(15_000));
  if (error) return json({ error: error.message }, 502);

  const results = [];
  for (const lead of due || []) {
    const remainingBudget = PROCESSING_BUDGET_MS - (Date.now() - startedAt);
    if (remainingBudget < MINIMUM_REQUEST_BUDGET_MS) break;
    const requestTimeout = Math.min(
      SEND_REQUEST_TIMEOUT_MS,
      remainingBudget - 1_000,
    );
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/send-approved-outreach`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'x-sitefinder-cron-secret': cronSecret,
        },
        body: JSON.stringify({ lead_id: lead.id, mode: 'followup' }),
        signal: AbortSignal.timeout(requestTimeout),
      });
      const responseText = await response.text();
      let body: any = {};
      try {
        body = responseText ? JSON.parse(responseText) : {};
      } catch {
        body = { error: `Send function returned a non-JSON response (${response.status})` };
      }
      results.push({
        lead_id: lead.id,
        ...classifyFollowupResponse(response.status, response.ok, body),
      });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
      const { data: currentLead, error: stateError } = await db
        .from('outreach_leads')
        .select('status,gmail_message_id,send_error,follow_up_step,next_follow_up_at')
        .eq('id', lead.id)
        .maybeSingle()
        .abortSignal(AbortSignal.timeout(10_000));
      results.push({
        lead_id: lead.id,
        ...classifyFollowupStateAfterInvocation(lead, currentLead),
        error: `Follow-up invocation did not complete: ${message}`,
        ...(stateError
          ? { state_error: `Could not verify the atomic send state: ${stateError.message}` }
          : {}),
      });
    }
  }
  const totalDue = Number(count ?? due?.length ?? 0);
  const summary = summariseFollowupResults(results, totalDue);
  return json({
    ...summary,
    due: totalDue,
    results,
  }, summary.ok ? 200 : 502);
});
