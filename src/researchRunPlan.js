function clean(value) {
  return String(value || '').trim();
}

function normalizedName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
}

function contractorIdentity(project, name) {
  const source = project?.source_data || {};
  const sourceId = clean(
    project?.MainContractorId
      || project?.main_contractor_id
      || source.MainContractorId
      || source.main_contractor_id,
  );
  return sourceId
    ? `sitefinder_contractor:${sourceId}`
    : `sitefinder_contractor_name:${normalizedName(name)}`;
}

function projectLabel(project) {
  return clean(
    project?.Name
      || project?.project_name
      || project?.source_data?.Name,
  );
}

export function buildResearchCompanyOptions(projects = [], knownTasks = []) {
  const knownDomains = new Map(
    knownTasks
      .filter(task => clean(task.companyName) && clean(task.domain))
      .map(task => [clean(task.companyName).toLowerCase(), clean(task.domain).toLowerCase()]),
  );
  const companies = new Map();
  for (const project of projects) {
    const name = clean(
      project?.MainContractor
        || project?.main_contractor
        || project?.source_data?.MainContractor,
    );
    if (!name || name.toLowerCase() === 'unknown contractor') continue;
    const id = contractorIdentity(project, name);
    const existing = companies.get(id);
    if (existing) {
      existing.projectCount += 1;
      const label = projectLabel(project);
      if (label && existing.projectNames.length < 2) {
        existing.projectNames = [...new Set([...existing.projectNames, label])];
      }
      continue;
    }
    const label = projectLabel(project);
    companies.set(id, {
      id,
      name,
      projectCount: 1,
      projectNames: label ? [label] : [],
      domain: knownDomains.get(name.toLowerCase()) || '',
      apolloSearchDomain:
        ['bam uk & ireland', 'bam construction'].includes(name.toLowerCase())
          ? 'ukandireland.bam.com'
          : '',
    });
  }
  return [...companies.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function createQueuedPreviewRun(
  request,
  {
    idFactory = () => crypto.randomUUID(),
    now = () => new Date().toISOString(),
  } = {},
) {
  const runId = idFactory();
  const createdAt = now();
  return {
    id: runId,
    name: request.name,
    mode: 'preview',
    status: 'queued',
    startedAt: createdAt,
    completedAt: null,
    stopAfterCurrent: false,
    companyLimit: request.companies.length,
    companiesChecked: 0,
    pagesInspected: 0,
    peopleFound: 0,
    tasks: request.companies.map(company => ({
      id: `${runId}:${company.companyId}`,
      companyId: company.companyId,
      companyName: company.companyName,
      domain: company.domain,
      status: 'waiting',
      progress: 0,
      pageCount: 0,
      contactsFound: 0,
      currentUrl: '',
      pageTitle: 'Waiting for the approved local worker',
      currentRole: '',
      currentStep: 0,
    })),
    events: [{
      id: `${runId}:queued`,
      taskId: null,
      sequence: 0,
      eventType: 'run',
      message:
        'Research request queued. Waiting for the approved local worker.',
      createdAt,
    }],
    candidates: [],
  };
}
