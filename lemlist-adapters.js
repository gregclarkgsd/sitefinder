// Read-only ports. No credentials, external writes, enrollment, or campaign actions.
const normalized = value => String(value || '').trim().toLowerCase();
const fail = message => { throw new Error(`Review held: ${message}`); };

export function createSupabaseReadPort(db) {
  const tables = {
    events: ['private', 'lemlist_insert_events', 'id'],
    boundary: ['private', 'lemlist_review_boundary', 'singleton'],
    excluded: ['private', 'lemlist_excluded_projects', 'project_id'],
    runs: ['public', 'ccs_sync_runs', 'id'],
    projects: ['public', 'ccs_projects', 'project_id'],
    leads: ['public', 'outreach_leads', 'id'],
    tracking: ['public', 'lead_tracking', 'project_id'],
    suppressions: ['public', 'outreach_suppressions', 'id'],
    communications: ['public', 'outreach_communications', 'id'],
    claims: ['private', 'outreach_provider_claims', 'project_id'],
  };
  function table(name) {
    const spec = tables[name];
    if (!spec) fail('unknown read table');
    return { query: db.schema(spec[0]).from(spec[1]).select('*'), key: spec[2] };
  }
  return {
    async one(name, value) {
      const { query, key } = table(name);
      const { data, error } = await query.eq(key, value).single();
      if (error || !data) fail(`missing ${name} record`);
      return data;
    },
    async all(name) {
      const rows = [], seen = new Set();
      for (let offset = 0; ; offset += 1000) {
        const { query, key } = table(name);
        const { data, error } = await query.order(key).range(offset, offset + 999);
        if (error || !Array.isArray(data)) fail(`incomplete ${name} read`);
        for (const row of data) {
          if (row[key] == null || seen.has(String(row[key]))) fail(`unstable ${name} pagination`);
          seen.add(String(row[key])); rows.push(row);
        }
        if (data.length < 1000) return rows;
        if (offset >= 1_000_000) fail('read limit exceeded');
      }
    },
  };
}

// Provider-specific transports must normalize their GET responses into this
// contract. It is intentionally injected; no live client is wired in this branch.
export function createProviderSnapshotReader(readPage) {
  return async (provider, now) => {
    const records = [], cursors = new Set();
    let cursor = null;
    do {
      const page = await readPage(provider, cursor);
      if (!page || page.complete !== true || !Array.isArray(page.records) || !Object.hasOwn(page, 'nextCursor')) fail(`${provider} incomplete page`);
      records.push(...page.records);
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 10000) fail(`${provider} invalid cursor`);
        cursors.add(cursor);
      }
    } while (cursor !== null);
    return { provider, checkedAt: now, complete: true, records };
  };
}

export async function buildDatabaseReview({ sitefinder, providerSnapshot, eventId, review, now = new Date().toISOString() }) {
  const startedAt = now;
  const [raw, boundary, excluded] = await Promise.all([
    sitefinder.one('events', eventId), sitefinder.one('boundary', true), sitefinder.all('excluded'),
  ]);
  if (raw.id !== eventId || !raw.sync_run_id || raw.capture_id !== boundary.capture_id || raw.project_id !== raw.project?.project_id) fail('unlinked insertion');
  const [run, project, leads, tracking, suppressions, communications, claims, ...external] = await Promise.all([
    sitefinder.one('runs', raw.sync_run_id), sitefinder.one('projects', raw.project_id),
    sitefinder.all('leads'), sitefinder.one('tracking', raw.project_id), sitefinder.all('suppressions'),
    sitefinder.all('communications'), sitefinder.all('claims'),
    ...['lemlist', 'woodpecker', 'attio'].map(provider => providerSnapshot(provider, startedAt)),
  ]);
  if (String(run.id) !== String(raw.sync_run_id) || String(project.first_seen_sync_run_id) !== String(run.id) || String(raw.project.first_seen_sync_run_id) !== String(run.id)
      || run.status !== 'completed' || !(Date.parse(run.started_at) <= Date.parse(raw.project.first_seen_at)
      && Date.parse(raw.captured_at) <= Date.parse(run.completed_at) && Date.parse(run.completed_at) <= Date.parse(now))) fail('originating sync not completed');
  const lead = leads.find(item => item.project_id === project.project_id);
  if (!lead || !lead.attio_company_record_id) fail('missing canonical company');
  const companyKey = `attio:${lead.attio_company_record_id}`.toLowerCase();
  const recipient = normalized(lead.recipient_email);
  if (review?.projectId !== project.project_id || normalized(review?.contact?.email) !== recipient
      || review?.companyKey !== companyKey || review?.approved !== true || normalized(review?.approvedBy) !== normalized(tracking.assigned_email)
      || !(Date.parse(review.checkedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(review.checkedAt) <= 900000)) fail('missing current owner review');
  const records = [];
  for (const [index, snapshot] of external.entries()) {
    if (snapshot?.provider !== ['lemlist', 'woodpecker', 'attio'][index] || snapshot.complete !== true || !Array.isArray(snapshot.records)
        || !(Date.parse(snapshot.checkedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(snapshot.checkedAt) <= 900000)) fail('stale or incomplete external history');
    for (const row of snapshot.records) {
      if (!row.email || !row.companyKey || ['suppressed', 'bounced', 'replied', 'active', 'contacted'].some(key => typeof row[key] !== 'boolean')) fail('incomplete normalized external record');
      records.push(row);
    }
  }
  const same = row => row.projectId === project.project_id || normalized(row.email) === recipient || normalized(row.companyKey) === companyKey;
  const matching = records.filter(same);
  const relatedLeads = leads.filter(item => item.id !== lead.id && (item.project_id === project.project_id || normalized(item.recipient_email) === recipient || item.attio_company_record_id === lead.attio_company_record_id));
  const blockedStatus = !['queued', 'reviewing'].includes(lead.status);
  const history = communications.some(item => item.project_id === project.project_id || normalized(item.recipient_email) === recipient || relatedLeads.some(other => other.id === item.outreach_lead_id));
  const reserved = claims.some(item => item.project_id === project.project_id || normalized(item.recipient_email) === recipient || normalized(item.company_key) === companyKey);
  return {
    boundary: { campaignId: boundary.campaign_id, captureId: boundary.capture_id, goLiveAt: boundary.go_live_at, excludedProjectIds: excluded.map(row => row.project_id), evidenceMode: 'database' },
    event: { id: raw.id, captureId: raw.capture_id, capturedAt: raw.captured_at, operation: 'INSERT', evidenceMode: 'database', project: raw.project },
    evidence: {
      checkedAt: startedAt, projectId: project.project_id, insertEventId: raw.id, syncCompleted: true,
      projectActive: project.is_active, projectClosed: project.site_closed, contact: review.contact, companyKey, companyVerified: true,
      suppressionChecksComplete: true, suppressed: lead.status === 'suppressed' || suppressions.some(row => normalized(row.email) === recipient) || matching.some(row => row.suppressed),
      bounced: Boolean(lead.last_bounce_at) || matching.some(row => row.bounced), replied: Boolean(lead.last_reply_at) || matching.some(row => row.replied),
      historyChecksComplete: true, existingProjectOutreach: blockedStatus || history || reserved || matching.some(row => row.contacted || row.active),
      existingContactOutreach: relatedLeads.length > 0, existingCompanyOutreach: relatedLeads.length > 0,
      ownershipChecksComplete: true, ownerConflict: matching.some(row => row.ownerEmail && normalized(row.ownerEmail) !== normalized(tracking.assigned_email)),
      ownerEmail: tracking.assigned_email, ownerApproved: true, stage: tracking.stage,
      provider: review.provider, gmailActive: Boolean(lead.gmail_message_id || lead.sent_at || lead.send_claimed_at || lead.next_follow_up_at),
      otherProviderActive: matching.some(row => row.active), reviewedBy: review.approvedBy, manualReviewApproved: true,
    },
  };
}
