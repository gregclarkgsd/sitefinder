// No network or activation. The optional column exists only after reviewed SQL.
export function insertSyncLink(enabled, runId) {
  if (!enabled) return {};
  if ((typeof runId === 'number' && !Number.isSafeInteger(runId)) || !/^[1-9]\d*$/.test(String(runId))) throw new Error('Valid sync run ID required');
  return { first_seen_sync_run_id: runId };
}

export async function guardGmailProvider(db, leadId, enabled) {
  if (!enabled) return;
  const { data, error } = await db.rpc('claim_outreach_provider', { requested_lead: leadId, requested_provider: 'gmail' });
  if (error || data?.allowed !== true) throw new Error('Cross-provider ownership/history check failed; no email sent');
}
