import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpportunityItems,
  correctPipelineContactChanges,
  correctManualContactChanges,
  countOpportunityBuckets,
  deriveContactState,
  deriveInboxState,
  isInOpportunityScope,
  manualContactChanges,
  markReviewedChanges,
  mergeOpportunityProjects,
  nextTriageChanges,
  normaliseTrackingChanges,
} from './opportunityState.js';

const NOW = new Date('2026-07-30T20:00:00.000Z');

test('an auto-queued outreach lead is not treated as contacted', () => {
  assert.deepEqual(
    deriveContactState({outreachLead: {status: 'queued'}}),
    {state: 'queued', lastContactAt: null, source: 'outreach'},
  );
});

test('sent and inbound communication evidence determines contacted state', () => {
  const sent = deriveContactState({
    communications: [{
      direction: 'outbound',
      status: 'delivered',
      occurred_at: '2026-07-29T12:00:00Z',
    }],
  });
  assert.equal(sent.state, 'contacted');
  assert.equal(sent.source, 'communication');

  const replied = deriveContactState({
    communications: [{
      direction: 'inbound',
      status: 'received',
      occurred_at: '2026-07-30T12:00:00Z',
    }],
  });
  assert.equal(replied.state, 'replied');
});

test('bounce notifications and failed delivery remain attempted, not replied or contacted', () => {
  assert.equal(
    deriveContactState({
      outreachLead: {
        status: 'bounced',
        sent_at: '2026-07-29T10:00:00Z',
      },
      communications: [{
        direction: 'inbound',
        status: 'bounced',
        occurred_at: '2026-07-29T10:01:00Z',
      }],
    }).state,
    'attempted',
  );
  assert.equal(
    deriveContactState({
      communications: [{direction: 'outbound', status: 'failed'}],
    }).state,
    'attempted',
  );
});

test('a later successful send can recover from an older failed attempt', () => {
  assert.equal(
    deriveContactState({
      outreachLead: {status: 'sent', sent_at: '2026-07-30T10:00:00Z'},
      communications: [
        {
          direction: 'inbound',
          status: 'bounced',
          occurred_at: '2026-07-29T10:00:00Z',
        },
        {
          direction: 'outbound',
          status: 'sent',
          occurred_at: '2026-07-30T10:00:00Z',
        },
      ],
    }).state,
    'contacted',
  );
});

test('a logged outbound phone attempt is visible without claiming contact', () => {
  assert.equal(
    deriveContactState({
      communications: [{
        direction: 'outbound',
        channel: 'phone',
        status: 'logged',
        occurred_at: '2026-07-30T10:00:00Z',
      }],
    }).state,
    'attempted',
  );
});

test('a later phone attempt does not erase earlier successful contact evidence', () => {
  assert.equal(
    deriveContactState({
      outreachLead: {status: 'sent', sent_at: '2026-07-29T10:00:00Z'},
      communications: [
        {
          direction: 'outbound',
          channel: 'email',
          status: 'delivered',
          occurred_at: '2026-07-29T10:00:00Z',
        },
        {
          direction: 'outbound',
          channel: 'phone',
          status: 'logged',
          occurred_at: '2026-07-30T10:00:00Z',
        },
      ],
    }).state,
    'contacted',
  );
});

test('unreviewed work stays unreviewed regardless of its age', () => {
  assert.equal(
    deriveInboxState({
      history: {
        first_seen_at: '2025-01-01T00:00:00Z',
        discovered_after_baseline: false,
      },
      tracking: {},
      now: NOW,
    }),
    'unreviewed',
  );
});

test('post-baseline projects stay new until reviewed even after seven days', () => {
  assert.equal(
    deriveInboxState({
      history: {
        first_seen_at: '2026-06-01T00:00:00Z',
        discovered_after_baseline: true,
      },
      tracking: {},
      now: NOW,
    }),
    'new',
  );
});

test('a CCS change after review resurfaces even a contacted project', () => {
  assert.equal(
    deriveInboxState({
      history: {last_changed_at: '2026-07-30T12:00:00Z'},
      tracking: {
        triage_status: 'contacted',
        reviewed_at: '2026-07-29T12:00:00Z',
      },
      contact: {state: 'contacted'},
      now: NOW,
    }),
    'changed',
  );
});

test('sent or replied evidence prevents projects without tracking rows appearing unreviewed', () => {
  assert.equal(
    deriveInboxState({
      tracking: {},
      contact: {state: 'contacted'},
      now: NOW,
    }),
    'contacted',
  );
  assert.equal(
    deriveInboxState({
      tracking: {},
      contact: {state: 'replied'},
      now: NOW,
    }),
    'contacted',
  );
});

test('explicit research work remains visible even when the project was contacted', () => {
  assert.equal(
    deriveInboxState({
      tracking: {
        triage_status: 'research',
        reviewed_at: '2026-07-30T10:00:00Z',
      },
      contact: {
        state: 'contacted',
        lastContactAt: Date.parse('2026-07-29T10:00:00Z'),
      },
      now: NOW,
    }),
    'research',
  );
});

test('a post-contact CCS change resurfaces without requiring a lead tracking row', () => {
  assert.equal(
    deriveInboxState({
      history: {last_changed_at: '2026-07-30T12:00:00Z'},
      tracking: {},
      contact: {
        state: 'contacted',
        lastContactAt: Date.parse('2026-07-29T12:00:00Z'),
        reviewWatermarkAt: Date.parse('2026-07-29T12:00:00Z'),
      },
      now: NOW,
    }),
    'changed',
  );
});

test('the latest review or successful contact is the change watermark', () => {
  assert.equal(
    deriveInboxState({
      history: {last_changed_at: '2026-07-29T12:00:00Z'},
      tracking: {reviewed_at: '2026-07-28T12:00:00Z'},
      contact: {
        state: 'contacted',
        lastContactAt: Date.parse('2026-07-30T12:00:00Z'),
        reviewWatermarkAt: Date.parse('2026-07-30T12:00:00Z'),
      },
      now: NOW,
    }),
    'contacted',
  );
  assert.equal(
    deriveInboxState({
      history: {last_changed_at: '2026-07-30T12:00:00Z'},
      tracking: {reviewed_at: '2026-07-29T12:00:00Z'},
      contact: {
        state: 'contacted',
        lastContactAt: Date.parse('2026-07-28T12:00:00Z'),
        reviewWatermarkAt: Date.parse('2026-07-28T12:00:00Z'),
      },
      now: NOW,
    }),
    'changed',
  );
});

test('a later non-contact lead edit cannot become a false contact watermark', () => {
  const contact = deriveContactState({
    tracking: {
      stage: 'contacted',
      contacted_at: '2026-07-28T12:00:00Z',
      updated_at: '2026-07-30T13:00:00Z',
    },
  });
  assert.equal(contact.lastContactAt, Date.parse('2026-07-28T12:00:00Z'));
  assert.equal(
    deriveInboxState({
      history: {last_changed_at: '2026-07-29T12:00:00Z'},
      tracking: {
        stage: 'contacted',
        contacted_at: '2026-07-28T12:00:00Z',
        updated_at: '2026-07-30T13:00:00Z',
      },
      contact,
      now: NOW,
    }),
    'changed',
  );
});

test('dedicated reply and bounce evidence outrank later outreach metadata edits', () => {
  const replied = deriveContactState({
    outreachLead: {
      status: 'replied',
      last_reply_at: '2026-07-28T10:00:00Z',
      updated_at: '2026-07-30T10:00:00Z',
    },
  });
  assert.equal(replied.lastContactAt, Date.parse('2026-07-28T10:00:00Z'));

  const bounced = deriveContactState({
    outreachLead: {
      status: 'bounced',
      last_bounce_at: '2026-07-27T10:00:00Z',
      updated_at: '2026-07-30T10:00:00Z',
    },
  });
  assert.equal(bounced.lastContactAt, Date.parse('2026-07-27T10:00:00Z'));
});

test('active deferrals stay out of the work queue and expired ones return', () => {
  const tracking = {
    triage_status: 'deferred',
    reviewed_at: '2026-07-20T12:00:00Z',
  };
  assert.equal(
    deriveInboxState({
      tracking: {...tracking, snoozed_until: '2026-08-15T00:00:00Z'},
      now: NOW,
    }),
    'deferred',
  );
  assert.equal(
    deriveInboxState({
      tracking: {...tracking, snoozed_until: '2026-07-29T00:00:00Z'},
      now: NOW,
    }),
    'needs_contact',
  );
});

test('checkpoint scope uses durable project activity and handles no checkpoint', () => {
  const item = {history: {first_seen_at: '2026-07-29T00:00:00Z'}};
  assert.equal(isInOpportunityScope(item, 'checkpoint'), true);
  assert.equal(
    isInOpportunityScope(item, 'checkpoint', {
      checkpointAt: '2026-07-28T00:00:00Z',
    }),
    true,
  );
  assert.equal(
    isInOpportunityScope(item, 'checkpoint', {
      checkpointAt: '2026-07-30T00:00:00Z',
    }),
    false,
  );
});

test('date scopes support returning after several weeks', () => {
  const item = {history: {last_changed_at: '2026-07-10T00:00:00Z'}};
  assert.equal(isInOpportunityScope(item, '7', {now: NOW}), false);
  assert.equal(isInOpportunityScope(item, '30', {now: NOW}), true);
  assert.equal(isInOpportunityScope(item, '90', {now: NOW}), true);
});

test('items sort unresolved work before contacted work and newest within a bucket', () => {
  const items = buildOpportunityItems({
    projects: [
      {Id: 'old', Name: 'Old'},
      {Id: 'contacted', Name: 'Contacted'},
      {Id: 'new', Name: 'New'},
    ],
    history: {
      old: {first_seen_at: '2026-07-01T00:00:00Z'},
      contacted: {first_seen_at: '2026-07-30T00:00:00Z'},
      new: {first_seen_at: '2026-07-29T00:00:00Z'},
    },
    tracking: {
      contacted: {
        triage_status: 'contacted',
        reviewed_at: '2026-07-30T01:00:00Z',
        contacted_at: '2026-07-30T02:00:00Z',
      },
    },
    now: NOW,
  });
  assert.deepEqual(items.map(item => item.project.Id), ['new', 'old', 'contacted']);
  assert.deepEqual(countOpportunityBuckets(items), {
    all: 3,
    unreviewed: 2,
    contacted: 1,
  });
});

test('durable CCS history keeps inactive projects in the inbox', () => {
  const projects = mergeOpportunityProjects(
    [{Id: 'site-live', Name: 'Live project', MainContractor: 'Live Ltd'}],
    {
      'site-live': {
        project_id: 'site-live',
        project_name: 'Old live name',
        is_active: true,
      },
      'site-gone': {
        project_id: 'site-gone',
        project_name: 'Disappeared project',
        main_contractor: 'Historic Ltd',
        is_active: false,
      },
    },
  );
  assert.deepEqual(
    projects.map(project => project.Id).sort(),
    ['site-gone', 'site-live'],
  );
  assert.equal(
    projects.find(project => project.Id === 'site-live').Name,
    'Live project',
  );
  assert.equal(
    projects.find(project => project.Id === 'site-gone').MainContractor,
    'Historic Ltd',
  );
});

test('empty live marker fields do not erase richer durable history', () => {
  const [project] = mergeOpportunityProjects(
    [{
      Id: 'site-1',
      Name: 'Live name',
      MainContractor: null,
      Client: '',
      LaId: undefined,
      Latitude: null,
      Longitude: null,
    }],
    {
      'site-1': {
        project_id: 'site-1',
        project_name: 'Historical name',
        main_contractor: 'Historic contractor',
        client: 'Historic client',
        local_authority: 'Historic authority',
        latitude: 51.5,
        longitude: -0.1,
      },
    },
  );
  assert.equal(project.Name, 'Live name');
  assert.equal(project.MainContractor, 'Historic contractor');
  assert.equal(project.Client, 'Historic client');
  assert.equal(project.LaId, 'Historic authority');
  assert.equal(project.Latitude, 51.5);
  assert.equal(project.Longitude, -0.1);
});

test('triage changes are deterministic and deferral defaults to 30 days', () => {
  assert.deepEqual(
    nextTriageChanges('ready', {now: NOW}),
    {
      triage_status: 'ready',
      reviewed_at: NOW.toISOString(),
      contacted_at: null,
      snoozed_until: null,
    },
  );
  assert.equal(
    nextTriageChanges('deferred', {now: NOW}).snoozed_until,
    '2026-08-29T20:00:00.000Z',
  );
  assert.equal(
    nextTriageChanges('contacted', {
      now: NOW,
      current: {stage: 'new'},
    }).stage,
    'contacted',
  );
  assert.equal(
    nextTriageChanges('contacted', {
      now: NOW,
      current: {stage: 'quoting'},
    }).stage,
    'quoting',
  );
  assert.throws(() => nextTriageChanges('mystery'), /Unknown triage status/);
});

test('marking reviewed preserves the team decision while advancing its watermark', () => {
  assert.deepEqual(
    markReviewedChanges({triage_status: 'ready'}, NOW),
    {triage_status: 'ready', reviewed_at: NOW.toISOString()},
  );
  assert.deepEqual(
    markReviewedChanges({}, NOW),
    {triage_status: 'unreviewed', reviewed_at: NOW.toISOString()},
  );
  assert.equal(
    deriveInboxState({
      history: {discovered_after_baseline: true},
      tracking: markReviewedChanges({}, NOW),
      now: NOW,
    }),
    'needs_contact',
  );
});

test('pipeline stage contact records a durable review and contact watermark', () => {
  assert.deepEqual(
    normaliseTrackingChanges({}, {stage: 'contacted'}, NOW),
    {
      stage: 'contacted',
      triage_status: 'contacted',
      reviewed_at: NOW.toISOString(),
      contacted_at: NOW.toISOString(),
      contacted_source: 'pipeline_stage',
    },
  );
  assert.deepEqual(
    normaliseTrackingChanges(
      {
        triage_status: 'not_fit',
        reviewed_at: '2026-07-01T00:00:00Z',
        contacted_at: '2026-07-02T00:00:00Z',
        contacted_source: 'pipeline_stage',
      },
      {stage: 'lost'},
      NOW,
    ),
    {
      stage: 'lost',
      triage_status: 'not_fit',
      reviewed_at: '2026-07-01T00:00:00Z',
      contacted_at: '2026-07-02T00:00:00Z',
      contacted_source: 'pipeline_stage',
    },
  );
});

test('manual historical contact is orthogonal to pipeline stage and explicitly sourced', () => {
  assert.deepEqual(
    manualContactChanges(
      {stage: 'quoting'},
      '2026-06-15T00:00:00Z',
      NOW,
    ),
    {
      contacted_at: '2026-06-15T00:00:00.000Z',
      contacted_source: 'manual_history',
      review_note: 'Historical contact recorded manually',
    },
  );
  assert.throws(
    () => manualContactChanges({}, '2026-08-01T00:00:00Z', NOW),
    /cannot be in the future/,
  );
});

test('manual contact correction only clears a proven manual mark', () => {
  assert.deepEqual(
    correctManualContactChanges({
      stage: 'won',
      triage_status: 'ready',
      contacted_at: NOW.toISOString(),
      contacted_source: 'manual_history',
    }),
    {
      contacted_at: null,
      contacted_source: null,
      review_note: 'Manual contact mark corrected',
    },
  );
  assert.throws(
    () => correctManualContactChanges({
      stage: 'lost',
      triage_status: 'contacted',
      contacted_at: NOW.toISOString(),
    }),
    /Only an explicit manual historical contact mark/,
  );
});

test('only a provenance-marked pipeline contact can be corrected by moving it back', () => {
  assert.deepEqual(
    correctPipelineContactChanges(
      {
        stage: 'contacted',
        triage_status: 'contacted',
        contacted_at: '2026-07-20T00:00:00Z',
        contacted_source: 'pipeline_stage',
      },
      'reviewing',
      NOW,
    ),
    {
      stage: 'reviewing',
      triage_status: 'research',
      reviewed_at: NOW.toISOString(),
      contacted_at: null,
      contacted_source: null,
      review_note: 'Pipeline contact stage corrected',
    },
  );
  assert.deepEqual(
    correctPipelineContactChanges(
      {
        stage: 'won',
        triage_status: 'ready',
        contacted_at: '2026-07-20T00:00:00Z',
        contacted_source: 'pipeline_stage',
      },
      'reviewing',
      NOW,
    ),
    {
      stage: 'reviewing',
      contacted_at: null,
      contacted_source: null,
      review_note: 'Pipeline contact stage corrected',
    },
  );
  assert.throws(
    () => correctPipelineContactChanges(
      {
        stage: 'won',
        triage_status: 'contacted',
        contacted_at: '2026-07-20T00:00:00Z',
      },
      'reviewing',
      NOW,
    ),
    /provenance-marked/,
  );
});

test('automatic follow-ups cannot become a newer CCS review watermark', () => {
  const contact = deriveContactState({
    outreachLead: {
      status: 'sent',
      sent_at: '2026-07-20T00:00:00Z',
    },
    communications: [
      {
        direction: 'outbound',
        status: 'sent',
        occurred_at: '2026-07-20T00:00:00Z',
      },
      {
        direction: 'outbound',
        status: 'sent',
        occurred_at: '2026-07-30T00:00:00Z',
      },
    ],
  });
  assert.equal(
    contact.reviewWatermarkAt,
    Date.parse('2026-07-20T00:00:00Z'),
  );
  assert.equal(
    deriveInboxState({
      history: {last_changed_at: '2026-07-25T00:00:00Z'},
      contact,
      now: NOW,
    }),
    'changed',
  );
});

test('last-contact display merges tracking and provider evidence without moving the review baseline', () => {
  const contact = deriveContactState({
    tracking: {
      contacted_at: '2026-07-01T00:00:00Z',
      contacted_source: 'manual_history',
    },
    outreachLead: {
      status: 'sent',
      sent_at: '2026-07-30T00:00:00Z',
    },
  });
  assert.equal(contact.lastContactAt, Date.parse('2026-07-30T00:00:00Z'));
  assert.equal(contact.reviewWatermarkAt, Date.parse('2026-07-01T00:00:00Z'));
});
