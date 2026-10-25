// supabase-js implementation of the db adapter used by tender-pull.js. Needs a
// service-role client: it writes tender_pull_runs, calls the service-only
// ingest function and writes tender_leads scores.

const SCORING_COLUMNS = [
  'ocid', 'stage', 'tender_status', 'title', 'description', 'buyer_name', 'buyer_id',
  'cpv_codes', 'regions', 'postcodes', 'value_amount', 'tender_deadline',
].join(',');
const SCORING_SELECT = `${SCORING_COLUMNS},parties:raw->parties`;

function check({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

function withRaw(rows) {
  return (rows || []).map(({ parties, ...notice }) => ({ ...notice, raw: { parties: parties ?? [] } }));
}

export function createTenderPullDb(client) {
  return {
    async recentRuns(source) {
      return check(await client
        .from('tender_pull_runs')
        .select('source,mode,status,started_at,window_from,window_to,next_cursor')
        .eq('source', source)
        .order('started_at', { ascending: false })
        .limit(50), 'Could not read previous pull runs');
    },

    async startRun(row) {
      return check(await client.from('tender_pull_runs').insert(row).select('id').single(), 'Could not log pull run').id;
    },

    async finishRun(id, patch) {
      check(await client.from('tender_pull_runs').update(patch).eq('id', id), 'Could not update pull run');
    },

    async ingest(notices) {
      return check(await client.rpc('ingest_tender_notices', { notices }), 'Could not store notices');
    },

    async tenantSettings(tenantIds = null) {
      let query = client.from('tender_tenant_settings').select('*');
      if (tenantIds) query = query.in('tenant_id', tenantIds);
      return check(await query, 'Could not read tenant tender settings');
    },

    async noticesByOcid(ocids) {
      return withRaw(check(await client.from('tender_notices').select(SCORING_SELECT).in('ocid', ocids), 'Could not read notices'));
    },

    async* allNoticeBatches(size) {
      let after = null;
      for (;;) {
        let query = client.from('tender_notices').select(SCORING_SELECT).order('ocid').limit(size);
        if (after !== null) query = query.gt('ocid', after);
        const rows = check(await query, 'Could not read notices');
        if (!rows.length) return;
        yield withRaw(rows);
        after = rows.at(-1).ocid;
        if (rows.length < size) return;
      }
    },

    async existingLeadOcids(tenantId, ocids) {
      const rows = check(await client
        .from('tender_leads')
        .select('ocid')
        .eq('tenant_id', tenantId)
        .in('ocid', ocids), 'Could not read existing leads');
      return rows.map((row) => row.ocid);
    },

    // Only score columns are sent, so on conflict PostgREST leaves status,
    // assignee and the rest of the workflow fields as they were.
    async upsertLeadScores(rows) {
      check(await client.from('tender_leads').upsert(rows, { onConflict: 'tenant_id,ocid' }), 'Could not write lead scores');
    },
  };
}
