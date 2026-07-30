const TRACKED_FIELDS = [
  ['project_name', 'Project name'],
  ['main_contractor', 'Main contractor'],
  ['client', 'Client'],
  ['local_authority', 'Local authority'],
  ['latitude', 'Location coordinates'],
  ['longitude', 'Location coordinates'],
  ['address', 'Site address'],
  ['site_manager_name', 'Site manager'],
  ['site_manager_job_title', 'Site manager role'],
  ['site_manager_phone', 'Site manager phone'],
  ['marker_email', 'Site email'],
  ['site_start_date', 'Start date'],
  ['site_end_date', 'Finish date'],
  ['site_closed', 'Closed status'],
  ['summary', 'Project summary'],
  ['last_visit_date', 'Last CCS visit'],
  ['performance_level', 'CCS performance rating'],
];

function normalise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  return value;
}

export function changedCcsFields(before = {}, after = {}) {
  const changed = new Set();
  for (const [field, label] of TRACKED_FIELDS) {
    if (!Object.is(normalise(before[field]), normalise(after[field]))) {
      changed.add(label);
    }
  }
  return [...changed];
}

export function latestCcsChangedFields({
  before = {},
  after = {},
  isNew = false,
  markerChanged = false,
  detailChanged = false,
  reactivated = false,
  previous = [],
} = {}) {
  if (isNew) return [];
  if (!markerChanged && !detailChanged && !reactivated) return previous;
  const exact = changedCcsFields(before, after);
  if (exact.length) {
    return reactivated ? [...exact, 'Reactivated in CCS feed'] : exact;
  }
  return [
    ...(markerChanged ? ['CCS map listing'] : []),
    ...(detailChanged ? ['CCS project details'] : []),
    ...(reactivated ? ['Reactivated in CCS feed'] : []),
  ];
}

export function hasCcsDetailChanged({
  projectExists = false,
  previousHash = null,
  nextHash = null,
} = {}) {
  return Boolean(
    projectExists
    && nextHash
    && previousHash !== nextHash
  );
}
