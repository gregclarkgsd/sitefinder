export function normaliseProjectId(value) {
  const clean = String(value || '').trim();
  if (/^site\d+$/.test(clean)) return clean;
  if (/^\d+$/.test(clean)) return `site${clean}`;
  return null;
}

export function projectIdFromSearch(search) {
  return normaliseProjectId(new URLSearchParams(search).get('project'));
}

export function projectSearchUrl(locationLike, projectId) {
  const url = new URL(locationLike.href);
  const normalised = normaliseProjectId(projectId);
  if (normalised) url.searchParams.set('project', normalised);
  else url.searchParams.delete('project');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function sitefinderProjectUrl(projectId, origin = 'https://gsd-sitefinder.onrender.com') {
  const normalised = normaliseProjectId(projectId);
  if (!normalised) return origin;
  const url = new URL(origin);
  url.searchParams.set('project', normalised);
  return url.toString();
}
