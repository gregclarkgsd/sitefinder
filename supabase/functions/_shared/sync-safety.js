export function isExplicitlyEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

export function canonicalCcsSiteId(value) {
  const siteId = String(value || '').trim().replace(/^site/i, '');
  if (!/^\d+$/.test(siteId)) throw new Error('Invalid CCS project identifier');
  return siteId;
}

export function staleCcsSyncCutoff(now = new Date(), leaseMinutes = 30) {
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(nowTime) || !Number.isFinite(leaseMinutes) || leaseMinutes <= 0) {
    throw new TypeError('A valid time and positive sync lease are required');
  }
  return new Date(nowTime - leaseMinutes * 60_000).toISOString();
}

export function assertSafeCcsFeedSnapshot(markerFeed, targetProjectCount, activeProjectCount) {
  if (!Array.isArray(markerFeed)) {
    throw new Error('CCS marker feed did not return an array');
  }
  if (!Number.isInteger(targetProjectCount) || targetProjectCount < 1) {
    throw new Error('CCS marker feed returned no target projects; refusing to deactivate existing data');
  }

  const activeCount = Math.max(0, Number(activeProjectCount) || 0);
  if (activeCount < 20) return;
  const minimumExpected = Math.max(10, Math.ceil(activeCount * 0.5));
  if (targetProjectCount < minimumExpected) {
    throw new Error(
      `CCS marker feed dropped from ${activeCount} active projects to ${targetProjectCount}; `
      + `minimum safe count is ${minimumExpected}`,
    );
  }
}
