export const researchEventSteps = [
  'Confirmed the company domain matches the CRM record.',
  'Checked the website rules and allowed pages.',
  'Opened the team page and inspected public staff profiles.',
  'Compared the exact public work email with Attio and Pipedrive snapshots.',
  'Saved the source URL and evidence for human review.',
];

export const minimumResearchApprovalConfidence = 0.65;

const approvableCrmComparisons = new Set([
  'pipedrive_only',
  'missing_from_both',
]);

export function researchCrmComparisonLabel(value) {
  return {
    already_in_attio: 'Exact work email already in Attio',
    pipedrive_only: 'Exact work email in Pipedrive · no exact match in Attio',
    missing_from_both: 'No exact work-email match in either CRM',
    conflicting_multiple_matches: 'Conflicting exact-email CRM matches · investigate',
    unverifiable_no_email: 'Cannot compare · no valid business email',
  }[value] || 'Unverified CRM comparison';
}

export function researchCandidateApprovalBlockReason(candidate) {
  if (!approvableCrmComparisons.has(candidate?.crmComparison)) {
    return {
      already_in_attio: 'This exact work email is already present in Attio.',
      conflicting_multiple_matches: 'Resolve the conflicting exact-email CRM matches before approval.',
      unverifiable_no_email: 'A public work email is required before CRM comparison and approval.',
    }[candidate?.crmComparison] || 'A verified exact-email CRM comparison is required before approval.';
  }
  if (candidate?.emailStatus !== 'public_email_found') {
    return 'Only a publicly sourced work email can be approved.';
  }
  if (
    !Number.isFinite(candidate?.confidence)
    || candidate.confidence < minimumResearchApprovalConfidence
  ) {
    return `Evidence confidence must be at least ${Math.round(minimumResearchApprovalConfidence * 100)}%.`;
  }
  return '';
}

export function canApproveResearchCandidate(candidate) {
  return researchCandidateApprovalBlockReason(candidate) === '';
}

export function createPreviewResearchRun() {
  return {
    id: 'preview-main-contractors',
    name: 'Main contractors',
    mode: 'preview',
    status: 'running',
    startedAt: '2026-07-28T09:14:00.000Z',
    stopAfterCurrent: false,
    companyLimit: 50,
    companiesChecked: 18,
    pagesInspected: 147,
    peopleFound: 26,
    tasks: [
      {
        id: 'bam',
        companyName: 'BAM Construction',
        domain: 'bam.co.uk',
        status: 'running',
        progress: 6,
        pageCount: 9,
        contactsFound: 1,
        pageTitle: 'Leadership and teams',
        currentUrl: 'https://www.bam.co.uk/',
        currentRole: 'Commercial Manager',
        currentStep: 3,
      },
      {
        id: 'galliford',
        companyName: 'Galliford Try',
        domain: 'gallifordtry.co.uk',
        status: 'review',
        progress: 8,
        pageCount: 8,
        contactsFound: 3,
        pageTitle: 'Our people',
        currentUrl: 'https://www.gallifordtry.co.uk/',
        currentRole: 'Project Manager',
        currentStep: 4,
      },
      {
        id: 'bowmer',
        companyName: 'Bowmer + Kirkland',
        domain: 'bandk.co.uk',
        status: 'review',
        progress: 7,
        pageCount: 7,
        contactsFound: 2,
        pageTitle: 'Supply chain',
        currentUrl: 'https://www.bandk.co.uk/',
        currentRole: 'Supply Chain Manager',
        currentStep: 4,
      },
      {
        id: 'turner',
        companyName: 'Turner Construction',
        domain: 'turnerconstruction.com',
        status: 'waiting',
        progress: 0,
        pageCount: 0,
        contactsFound: 0,
        pageTitle: 'Meet our team',
        currentUrl: 'https://www.turnerconstruction.com/',
        currentRole: 'Quantity Surveyor',
        currentStep: 0,
      },
      {
        id: 'mace',
        companyName: 'Mace',
        domain: 'macegroup.com',
        status: 'waiting',
        progress: 0,
        pageCount: 0,
        contactsFound: 0,
        pageTitle: 'Commercial leadership',
        currentUrl: 'https://www.macegroup.com/',
        currentRole: 'Commercial Director',
        currentStep: 0,
      },
    ],
    candidates: [
      {
        id: 'preview-candidate',
        taskId: 'bam',
        name: 'Illustrative candidate',
        jobTitle: 'Commercial Manager',
        roleCategory: 'Commercial',
        sourceKind: 'Official company team page',
        sourceUrl: 'https://www.bam.co.uk/',
        evidence: 'The public page associates this person with a relevant commercial role.',
        crmComparison: 'missing_from_both',
        emailStatus: 'public_email_found',
        confidence: 0.88,
        reviewStatus: 'pending',
      },
      {
        id: 'preview-galliford-candidate',
        taskId: 'galliford',
        name: 'Illustrative candidate',
        jobTitle: 'Project Manager',
        roleCategory: 'Project management',
        sourceKind: 'Official company people page',
        sourceUrl: 'https://www.gallifordtry.co.uk/',
        evidence: 'The public page associates this person with a relevant project-management role.',
        crmComparison: 'missing_from_both',
        emailStatus: 'public_email_found',
        confidence: 0.91,
        reviewStatus: 'pending',
      },
      {
        id: 'preview-galliford-candidate-2',
        taskId: 'galliford',
        name: 'Illustrative candidate two',
        jobTitle: 'Senior Quantity Surveyor',
        roleCategory: 'Quantity surveying',
        sourceKind: 'Official company people page',
        sourceUrl: 'https://www.gallifordtry.co.uk/',
        evidence: 'The public page associates this person with a relevant quantity-surveying role.',
        crmComparison: 'pipedrive_only',
        emailStatus: 'public_email_found',
        confidence: 0.89,
        reviewStatus: 'pending',
      },
      {
        id: 'preview-galliford-candidate-3',
        taskId: 'galliford',
        name: 'Illustrative candidate three',
        jobTitle: 'Procurement Manager',
        roleCategory: 'Procurement',
        sourceKind: 'Official company people page',
        sourceUrl: 'https://www.gallifordtry.co.uk/',
        evidence: 'The public page associates this person with a relevant procurement role.',
        crmComparison: 'conflicting_multiple_matches',
        emailStatus: 'public_email_found',
        confidence: 0.84,
        reviewStatus: 'pending',
      },
      {
        id: 'preview-bowmer-candidate',
        taskId: 'bowmer',
        name: 'Illustrative candidate',
        jobTitle: 'Supply Chain Manager',
        roleCategory: 'Supply chain',
        sourceKind: 'Official company supply-chain page',
        sourceUrl: 'https://www.bandk.co.uk/',
        evidence: 'The public page associates this person with a relevant supply-chain role.',
        crmComparison: 'already_in_attio',
        emailStatus: 'public_email_found',
        confidence: 0.86,
        reviewStatus: 'pending',
      },
    ],
  };
}

export function pendingReviewCount(run) {
  return run.candidates.filter(candidate => ['pending', 'investigate'].includes(candidate.reviewStatus)).length;
}

export function setRunStatus(run, status) {
  if (!['running', 'paused', 'stopping', 'completed'].includes(status)) {
    throw new Error(`Unsupported research run status: ${status}`);
  }
  return {...run, status};
}

export function primaryRunControl(status) {
  if (status === 'queued') return {status: 'running', label: 'Start'};
  if (status === 'paused') return {status: 'running', label: 'Resume'};
  if (status === 'running') return {status: 'paused', label: 'Pause'};
  return null;
}

export function requestStopAfterCurrent(run) {
  return {...run, status: run.status === 'completed' ? 'completed' : 'stopping', stopAfterCurrent: true};
}

export function reviewCandidate(run, candidateId, decision) {
  if (!['approved', 'rejected', 'investigate'].includes(decision)) {
    throw new Error(`Unsupported candidate decision: ${decision}`);
  }
  let found = false;
  const candidates = run.candidates.map(candidate => {
    if (candidate.id !== candidateId) return candidate;
    found = true;
    if (decision === 'approved' && !canApproveResearchCandidate(candidate)) {
      throw new Error(researchCandidateApprovalBlockReason(candidate));
    }
    return {...candidate, reviewStatus: decision, reviewedAt: new Date().toISOString()};
  });
  if (!found) throw new Error(`Research candidate not found: ${candidateId}`);
  return {...run, candidates};
}

export function advancePreviewRun(run) {
  if (run.mode !== 'preview' || run.status !== 'running') return run;
  const activeTask = run.tasks.find(task => task.status === 'running');
  if (!activeTask) return run;
  const completedPage = activeTask.currentStep >= researchEventSteps.length - 1;
  const canInspectAnotherPage =
    completedPage && activeTask.progress < activeTask.pageCount;
  if (completedPage && !canInspectAnotherPage) return run;
  const currentStep = completedPage
    ? researchEventSteps.length - 1
    : activeTask.currentStep + 1;
  const tasks = run.tasks.map(task => task.id === activeTask.id
    ? {
      ...task,
      currentStep,
      progress: canInspectAnotherPage
        ? Math.min(task.progress + 1, task.pageCount)
        : task.progress,
    }
    : task);
  return {
    ...run,
    pagesInspected: run.pagesInspected + (canInspectAnotherPage ? 1 : 0),
    tasks,
  };
}
