export const TRIAGE_STATUSES = [
  'unreviewed',
  'research',
  'ready',
  'contacted',
  'deferred',
  'not_fit',
];

export const INBOX_BUCKETS = [
  'new',
  'unreviewed',
  'changed',
  'research',
  'ready',
  'needs_contact',
  'contacted',
  'deferred',
  'not_fit',
];

export const MANUAL_CONTACT_SOURCE = 'manual_history';

const CONTACTED_OUTREACH_STATUSES = new Set([
  'sent',
  'followup_due',
  'replied',
]);
const ATTEMPTED_OUTREACH_STATUSES = new Set([
  'bounced',
  'failed',
  'reconciliation_required',
]);
const CONTACTED_PIPELINE_STAGES = new Set([
  'contacted',
  'quoting',
  'won',
  'lost',
]);
const SENT_COMMUNICATION_STATUSES = new Set([
  'sent',
  'delivered',
  'replied',
]);
const REPLY_COMMUNICATION_STATUSES = new Set(['received', 'replied']);

const timestamp = value => {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const latestTimestamp = values => {
  const valid = values.map(timestamp).filter(value => value !== null);
  return valid.length ? Math.max(...valid) : null;
};
const earliestTimestamp = values => {
  const valid = values.map(timestamp).filter(value => value !== null);
  return valid.length ? Math.min(...valid) : null;
};

export function deriveContactState({
  tracking = {},
  outreachLead = {},
  communications = [],
} = {}) {
  const inbound = communications
    .filter(item => (
      item.direction === 'inbound'
      && REPLY_COMMUNICATION_STATUSES.has(item.status)
    ))
    .map(item => item.occurred_at);
  const sent = communications
    .filter(item => (
      item.direction === 'outbound'
      && SENT_COMMUNICATION_STATUSES.has(item.status)
    ))
    .map(item => item.occurred_at);
  const attempted = communications
    .filter(item => (
      ['bounced', 'failed'].includes(item.status)
      || (
        item.direction === 'outbound'
        && item.channel === 'phone'
        && item.status === 'logged'
      )
    ))
    .map(item => item.occurred_at);
  const trackingContacted = Boolean(
    tracking.contacted_at
    || tracking.triage_status === 'contacted'
    || CONTACTED_PIPELINE_STAGES.has(tracking.stage)
  );
  const trackingContactAt = trackingContacted
    ? timestamp(tracking.contacted_at || tracking.updated_at)
    : null;
  const outreachAttempted = ATTEMPTED_OUTREACH_STATUSES.has(outreachLead.status);
  const successfulOutreachSentAt = outreachAttempted
    ? null
    : outreachLead.sent_at;
  const successfulSent = outreachAttempted ? [] : sent;
  const providerContacted = Boolean(
    CONTACTED_OUTREACH_STATUSES.has(outreachLead.status)
    || successfulOutreachSentAt
    || successfulSent.length
  );
  const initialSuccessfulContactAt = earliestTimestamp([
    trackingContactAt,
    successfulOutreachSentAt,
    ...successfulSent,
  ]);

  if (outreachLead.status === 'replied' || inbound.length) {
    return {
      state: 'replied',
      lastContactAt: latestTimestamp([
        outreachLead.last_reply_at
          || (outreachLead.status === 'replied' ? outreachLead.updated_at : null),
        ...inbound,
        trackingContactAt,
      ]),
      source: inbound.length ? 'communication' : 'outreach',
      reviewWatermarkAt: initialSuccessfulContactAt,
    };
  }

  if (trackingContacted || providerContacted) {
    const providerSource = successfulSent.length
      ? 'communication'
      : providerContacted
        ? 'outreach'
        : null;
    return {
      state: 'contacted',
      lastContactAt: latestTimestamp([
        trackingContactAt,
        successfulOutreachSentAt,
        ...successfulSent,
      ]),
      source: providerSource
        || (tracking.contacted_source === MANUAL_CONTACT_SOURCE
          ? MANUAL_CONTACT_SOURCE
          : 'pipeline'),
      reviewWatermarkAt: initialSuccessfulContactAt,
    };
  }

  if (ATTEMPTED_OUTREACH_STATUSES.has(outreachLead.status)) {
    return {
      state: 'attempted',
      lastContactAt: latestTimestamp([
        outreachLead.last_bounce_at || outreachLead.updated_at,
        ...attempted,
      ]),
      source: attempted.length ? 'communication' : 'outreach',
    };
  }

  if (attempted.length) {
    return {
      state: 'attempted',
      lastContactAt: latestTimestamp(attempted),
      source: 'communication',
    };
  }

  if (['queued', 'reviewing', 'approved', 'sending'].includes(outreachLead.status)) {
    return {
      state: 'queued',
      lastContactAt: null,
      source: 'outreach',
    };
  }

  return {state: 'not_contacted', lastContactAt: null, source: null};
}

export function deriveInboxState({
  history = {},
  tracking = {},
  contact = {state: 'not_contacted'},
  now = new Date(),
} = {}) {
  const nowTime = timestamp(now);
  const reviewedAt = timestamp(tracking.reviewed_at);
  const contactReviewAt = ['contacted', 'replied'].includes(contact.state)
    ? timestamp(contact.reviewWatermarkAt)
    : null;
  const reviewWatermark = reviewedAt === null
    ? contactReviewAt
    : contactReviewAt === null
      ? reviewedAt
      : Math.max(reviewedAt, contactReviewAt);
  const changedAt = timestamp(history.last_changed_at);
  const snoozedUntil = timestamp(tracking.snoozed_until);
  const triageStatus = TRIAGE_STATUSES.includes(tracking.triage_status)
    ? tracking.triage_status
    : 'unreviewed';

  if (triageStatus === 'not_fit') return 'not_fit';
  if (
    triageStatus === 'deferred'
    && snoozedUntil !== null
    && nowTime !== null
    && snoozedUntil > nowTime
  ) return 'deferred';
  if (
    reviewWatermark !== null
    && changedAt !== null
    && changedAt > reviewWatermark
  ) return 'changed';
  if (triageStatus === 'research') return 'research';
  if (triageStatus === 'ready') return 'ready';
  if (triageStatus === 'contacted') return 'contacted';
  if (['contacted', 'replied'].includes(contact.state)) return 'contacted';
  if (triageStatus === 'unreviewed' && reviewedAt === null) {
    return history.discovered_after_baseline === true ? 'new' : 'unreviewed';
  }
  return 'needs_contact';
}

export function opportunityActivityAt({history = {}, tracking = {}, contact = {}} = {}) {
  return latestTimestamp([
    history.first_seen_at,
    history.last_changed_at,
    tracking.reviewed_at,
    tracking.updated_at,
    contact.lastContactAt,
  ]);
}

export function isInOpportunityScope(item, scope, {
  checkpointAt = null,
  now = new Date(),
} = {}) {
  if (!scope || scope === 'all') return true;
  const activityAt = opportunityActivityAt(item);
  if (scope === 'checkpoint') {
    const checkpoint = timestamp(checkpointAt);
    return checkpoint === null || (activityAt !== null && activityAt > checkpoint);
  }
  const days = Number(scope);
  const nowTime = timestamp(now);
  if (!Number.isFinite(days) || nowTime === null || activityAt === null) return false;
  return activityAt >= nowTime - days * 86_400_000;
}

const PRIORITY = new Map(INBOX_BUCKETS.map((bucket, index) => [bucket, index]));

export function buildOpportunityItems({
  projects = [],
  history = {},
  tracking = {},
  outreachLeads = [],
  communications = [],
  enrichment = {},
  attioLinks = {},
  now = new Date(),
} = {}) {
  const leadByProject = new Map(outreachLeads.map(lead => [lead.project_id, lead]));
  const communicationsByProject = communications.reduce((result, item) => {
    if (!item.project_id) return result;
    if (!result.has(item.project_id)) result.set(item.project_id, []);
    result.get(item.project_id).push(item);
    return result;
  }, new Map());

  return projects.map(project => {
    const projectHistory = history[project.Id] || {};
    const projectTracking = tracking[project.Id] || {};
    const outreachLead = leadByProject.get(project.Id) || {};
    const projectCommunications = communicationsByProject.get(project.Id) || [];
    const contact = deriveContactState({
      tracking: projectTracking,
      outreachLead,
      communications: projectCommunications,
    });
    const inboxState = deriveInboxState({
      history: projectHistory,
      tracking: projectTracking,
      contact,
      now,
    });
    return {
      project,
      history: projectHistory,
      tracking: projectTracking,
      outreachLead,
      communications: projectCommunications,
      enrichment: enrichment[project.Id] || {},
      attioLink: attioLinks[project.Id] || {},
      contact,
      inboxState,
    };
  }).sort((left, right) => {
    const priority = (PRIORITY.get(left.inboxState) ?? 99)
      - (PRIORITY.get(right.inboxState) ?? 99);
    if (priority) return priority;
    return (opportunityActivityAt(right) || 0) - (opportunityActivityAt(left) || 0);
  });
}

export function mergeOpportunityProjects(liveProjects = [], history = {}) {
  const merged = new Map(liveProjects.map(project => [project.Id, project]));
  const prefer = (liveValue, historicalValue) => (
    liveValue !== null
    && liveValue !== undefined
    && (typeof liveValue !== 'string' || liveValue.trim() !== '')
  ) ? liveValue : historicalValue;
  Object.values(history).forEach(record => {
    if (!record.project_id) return;
    const historicalProject = {
      Id: record.project_id,
      Name: record.project_name || `CCS ${record.project_id.replace('site', '')}`,
      MainContractor: record.main_contractor,
      Client: record.client,
      LaId: record.local_authority,
      Latitude: record.latitude,
      Longitude: record.longitude,
      TypeOfSite: 'CCS',
    };
    const liveProject = merged.get(record.project_id);
    merged.set(record.project_id, liveProject ? {
      ...liveProject,
      Id: record.project_id,
      Name: prefer(liveProject.Name, historicalProject.Name),
      MainContractor: prefer(liveProject.MainContractor, historicalProject.MainContractor),
      Client: prefer(liveProject.Client, historicalProject.Client),
      LaId: prefer(liveProject.LaId, historicalProject.LaId),
      Latitude: prefer(liveProject.Latitude, historicalProject.Latitude),
      Longitude: prefer(liveProject.Longitude, historicalProject.Longitude),
      TypeOfSite: prefer(liveProject.TypeOfSite, historicalProject.TypeOfSite),
    } : historicalProject);
  });
  return [...merged.values()];
}

export function countOpportunityBuckets(items = []) {
  return items.reduce((counts, item) => {
    counts[item.inboxState] = (counts[item.inboxState] || 0) + 1;
    counts.all += 1;
    return counts;
  }, {all: 0});
}

export function nextTriageChanges(status, {
  now = new Date(),
  current = {},
  deferDays = 30,
} = {}) {
  if (!TRIAGE_STATUSES.includes(status)) {
    throw new TypeError(`Unknown triage status: ${status}`);
  }
  const nowIso = new Date(now).toISOString();
  if (status === 'unreviewed') {
    return {
      triage_status: status,
      reviewed_at: null,
      snoozed_until: null,
    };
  }
  if (status === 'deferred') {
    const snoozedUntil = new Date(now);
    snoozedUntil.setUTCDate(snoozedUntil.getUTCDate() + deferDays);
    return {
      triage_status: status,
      reviewed_at: current.reviewed_at || nowIso,
      snoozed_until: snoozedUntil.toISOString(),
    };
  }
  return {
    triage_status: status,
    reviewed_at: nowIso,
    contacted_at: status === 'contacted'
      ? current.contacted_at || nowIso
      : current.contacted_at || null,
    snoozed_until: null,
    ...(status === 'contacted' ? {
      stage: CONTACTED_PIPELINE_STAGES.has(current.stage)
        ? current.stage
        : 'contacted',
    } : {}),
  };
}

export function markReviewedChanges(current = {}, now = new Date()) {
  return {
    triage_status: TRIAGE_STATUSES.includes(current.triage_status)
      ? current.triage_status
      : 'unreviewed',
    reviewed_at: new Date(now).toISOString(),
  };
}

export function normaliseTrackingChanges(current = {}, changes = {}, now = new Date()) {
  if (!Object.hasOwn(changes, 'stage')) {
    return changes;
  }
  if (!CONTACTED_PIPELINE_STAGES.has(changes.stage)) return changes;
  const nowIso = new Date(now).toISOString();
  const createsContactEvidence = !current.contacted_at;
  return {
    ...changes,
    triage_status: current.triage_status === 'not_fit' ? 'not_fit' : 'contacted',
    reviewed_at: current.reviewed_at || nowIso,
    contacted_at: current.contacted_at || nowIso,
    contacted_source: createsContactEvidence
      ? 'pipeline_stage'
      : current.contacted_source || null,
  };
}

export function correctPipelineContactChanges(current = {}, nextStage, now = new Date()) {
  if (current.contacted_source !== 'pipeline_stage') {
    throw new TypeError('Only a provenance-marked pipeline contact can be corrected');
  }
  if (!['new', 'reviewing'].includes(nextStage)) {
    throw new TypeError('A corrected pipeline stage must return to new or reviewing');
  }
  const generatedDecisionStillPresent = current.triage_status === 'contacted';
  return {
    stage: nextStage,
    contacted_at: null,
    contacted_source: null,
    review_note: 'Pipeline contact stage corrected',
    ...(generatedDecisionStillPresent ? {
      triage_status: nextStage === 'reviewing' ? 'research' : 'unreviewed',
      reviewed_at: nextStage === 'reviewing' ? new Date(now).toISOString() : null,
    } : {}),
  };
}

export function manualContactChanges(current = {}, occurredAt, now = new Date()) {
  const occurred = timestamp(occurredAt);
  const currentTime = timestamp(now);
  if (occurred === null || currentTime === null || occurred > currentTime) {
    throw new TypeError('Historical contact date must be valid and cannot be in the future');
  }
  return {
    contacted_at: new Date(occurred).toISOString(),
    contacted_source: MANUAL_CONTACT_SOURCE,
    review_note: 'Historical contact recorded manually',
  };
}

export function correctManualContactChanges(current = {}) {
  if (current.contacted_source !== MANUAL_CONTACT_SOURCE) {
    throw new TypeError('Only an explicit manual historical contact mark can be corrected');
  }
  return {
    contacted_at: null,
    contacted_source: null,
    review_note: 'Manual contact mark corrected',
  };
}
