export const researchEventSteps = [
  'Confirmed the company domain matches the CRM record.',
  'Checked the website rules and allowed pages.',
  'Opened the team page and inspected public staff profiles.',
  'Compared the relevant role with existing Attio people.',
  'Saved the source URL and evidence for human review.',
];

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
        crmComparison: 'Likely new · no exact company/name match',
        emailStatus: 'No public personal email found',
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
        crmComparison: 'Likely new · no exact company/name match',
        emailStatus: 'No public personal email found',
        confidence: 0.91,
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
        crmComparison: 'Possible existing person · needs human confirmation',
        emailStatus: 'No public personal email found',
        confidence: 0.86,
        reviewStatus: 'pending',
      },
    ],
  };
}

export function pendingReviewCount(run) {
  return run.candidates.filter(candidate => candidate.reviewStatus === 'pending').length;
}

export function setRunStatus(run, status) {
  if (!['running', 'paused', 'stopping', 'completed'].includes(status)) {
    throw new Error(`Unsupported research run status: ${status}`);
  }
  return {...run, status};
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
  const currentStep = completedPage
    ? researchEventSteps.length - 1
    : activeTask.currentStep + 1;
  const tasks = run.tasks.map(task => task.id === activeTask.id
    ? {
      ...task,
      currentStep,
      progress: completedPage ? Math.min(task.progress + 1, Math.max(task.pageCount, task.progress + 1)) : task.progress,
    }
    : task);
  return {
    ...run,
    pagesInspected: run.pagesInspected + (completedPage ? 1 : 0),
    tasks,
  };
}
