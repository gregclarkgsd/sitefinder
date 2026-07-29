import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = Deno.env.get('OUTREACH_CRON_SECRET');
  if (!cronSecret || req.headers.get('x-sitefinder-cron-secret') !== cronSecret) {
    return json({ error: 'Unauthorised' }, 401);
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Follow-up processor not configured' }, 503);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: due, error } = await db
    .from('outreach_leads')
    .select('id')
    .in('status', ['sent', 'followup_due'])
    .eq('follow_up_enabled', true)
    .lt('follow_up_step', 2)
    .lte('next_follow_up_at', new Date().toISOString())
    .order('next_follow_up_at', { ascending: true })
    .limit(20);
  if (error) return json({ error: error.message }, 502);

  const results = [];
  for (const lead of due || []) {
    const response = await fetch(`${supabaseUrl}/functions/v1/send-approved-outreach`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'x-sitefinder-cron-secret': cronSecret,
      },
      body: JSON.stringify({ lead_id: lead.id, mode: 'followup' }),
    });
    const body = await response.json().catch(() => ({}));
    results.push({ lead_id: lead.id, ok: response.ok, ...body });
  }
  return json({ ok: true, processed: results.length, results });
});
