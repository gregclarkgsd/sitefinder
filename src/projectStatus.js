export function hasCurrentAttioLink(link) {
  return Boolean(link?.attio_web_url && link.sync_status === 'synced');
}

export function needsProjectClassification(intelligence = {}) {
  return !intelligence.sector || !intelligence.work_type;
}
