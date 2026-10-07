import { deploymentVersion } from './deployment-version.js';

const targetAuthority = /London Borough|City of London|Westminster|Royal Borough of (Greenwich|Kensington and Chelsea)|Essex|Kent|Surrey|Hertfordshire|Berkshire|Buckinghamshire|Hampshire|Sussex|Oxfordshire|Bedfordshire|Harlow|Canterbury|Sevenoaks|Elmbridge|Wealden|Arun|Winchester|Oxford City|Luton|Dacorum|Watford|St Albans|Three Rivers|Welwyn|Stevenage|Broxbourne|Basildon|Braintree|Brentwood|Castle Point|Chelmsford|Colchester|Epping Forest|Maldon|Rochford|Southend|Thurrock|Ashford|Dartford|Dover|Folkestone|Gravesham|Maidstone|Medway|Swale|Thanet|Tonbridge|Tunbridge|Epsom|Guildford|Mole Valley|Reigate|Runnymede|Spelthorne|Tandridge|Waverley|Woking|Bracknell|Reading|Slough|Windsor|Wokingham|Milton Keynes|Basingstoke|Eastleigh|Fareham|Gosport|Hart District|Havant|New Forest|Portsmouth|Rushmoor|Southampton|Test Valley|Brighton|Chichester|Crawley|Horsham|Lewes|Mid Sussex|Rother|Worthing|Adur|Cherwell|West Oxfordshire|Vale of White Horse|Bedford Borough|Central Bedfordshire/i;

export function createProjectReader({ authClient = null, fetchImpl = fetch, now = Date.now, origin = 'https://gsd-sitefinder.onrender.com' } = {}) {
  const MARKERS = 'https://ccsfilestore.blob.core.windows.net/constructionmap/live/json/sitemarkers.json';
  const DETAILS = 'https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails';
  const CACHE_TTL_MS = 30 * 60_000;
  const SCHEDULE_CACHE_TTL_MS = 15 * 60_000;
  let markerCache = { at: 0, data: [], lastAttemptAt: 0, lastError: null };
  let markerRefresh = null;
  let scheduleCache = { at: 0, data: new Map(), lastAttemptAt: 0, lastError: null };
  let scheduleRefresh = null;
  function isTargetProject(project) {
    return targetAuthority.test(String(project.LaId || ''));
  }

  async function markers() {
    if (now() - markerCache.at < CACHE_TTL_MS && markerCache.data.length) return markerCache.data;
    if (markerRefresh) return markerRefresh;
    markerRefresh = (async () => {
      markerCache.lastAttemptAt = now();
      try {
        const response = await fetchImpl(MARKERS, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`CCS marker feed returned ${response.status}`);
        const raw = await response.json();
        markerCache = {
          at: now(),
          sourceLastModifiedAt: response.headers.get('last-modified') || null,
          data: Array.isArray(raw) ? raw : [],
          lastAttemptAt: markerCache.lastAttemptAt,
          lastError: null,
        };
        return markerCache.data;
      } catch (error) {
        markerCache.lastError = error instanceof Error ? error.message : String(error);
        if (markerCache.data.length) return markerCache.data;
        throw error;
      } finally {
        markerRefresh = null;
      }
    })();
    return markerRefresh;
  }

  async function projectSchedules() {
    if (!authClient) return scheduleCache.data;
    if (now() - scheduleCache.at < SCHEDULE_CACHE_TTL_MS && scheduleCache.data.size) return scheduleCache.data;
    if (scheduleRefresh) return scheduleRefresh;
    scheduleRefresh = (async () => {
      scheduleCache.lastAttemptAt = now();
      try {
        const rows = [];
        const pageSize = 1000;
        for (let from = 0; ; from += pageSize) {
          const { data, error } = await authClient
            .from('ccs_project_schedule')
            .select('project_id,site_start_date,site_end_date,site_closed,is_active')
            .eq('is_active', true)
            .range(from, from + pageSize - 1);
          if (error) throw error;
          rows.push(...(data || []));
          if (!data || data.length < pageSize) break;
        }
        scheduleCache = {
          at: now(),
          data: new Map(rows.map(row => [String(row.project_id), row])),
          lastAttemptAt: scheduleCache.lastAttemptAt,
          lastError: null,
        };
        return scheduleCache.data;
      } catch (error) {
        scheduleCache.lastError = error instanceof Error ? error.message : String(error);
        if (scheduleCache.data.size) return scheduleCache.data;
        return new Map();
      } finally {
        scheduleRefresh = null;
      }
    })();
    return scheduleRefresh;
  }

  function withinDateRange(value, from, to) {
    if (!from && !to) return true;
    if (!value) return false;
    const date = String(value).slice(0, 10);
    return (!from || date >= from) && (!to || date <= to);
  }

  async function enrichedMarkers() {
    const [all, schedules] = await Promise.all([markers(), projectSchedules()]);
    return all.map(project => {
      const schedule = schedules.get(String(project.Id));
      return schedule ? {
        ...project,
        SiteStartDate: schedule.site_start_date,
        SiteEndDate: schedule.site_end_date,
        SiteClosed: schedule.site_closed,
      } : project;
    });
  }


  async function lastSuccessfulSync(userClient) {
    if (!userClient) return { at: null, status: 'unavailable' };
    try {
      const { data, error } = await userClient.from('ccs_sync_runs')
        .select('completed_at').eq('status', 'completed')
        .order('completed_at', { ascending: false }).limit(1).maybeSingle();
      if (error) return { at: null, status: 'unavailable' };
      return { at: data?.completed_at || null, status: data ? 'available' : 'no_successful_sync' };
    } catch { return { at: null, status: 'unavailable' }; }
  }
  async function listProjects(options = {}, userClient = null) {
    const all = await enrichedMarkers();
    const q = String(options.q || '').toLowerCase();
    const completionFrom = String(options.completion_from || '').slice(0, 10);
    const completionTo = String(options.completion_to || '').slice(0, 10);
    const filtered = all.filter(x => (options.region === 'all' || isTargetProject(x))
      && (!q || [x.Name, x.Client, x.MainContractor, x.LaId].join(' ').toLowerCase().includes(q))
      && withinDateRange(x.SiteEndDate, completionFrom, completionTo));
    const sync = await lastSuccessfulSync(userClient);
    return { source: MARKERS, updatedAt: new Date(markerCache.at).toISOString(),
      retrievedAt: new Date(now()).toISOString(), markerRetrievedAt: new Date(markerCache.at).toISOString(),
      lastSuccessfulSyncAt: sync.at, syncStatus: sync.status,
      sourcePublicationDate: null, sourceLastModifiedAt: markerCache.sourceLastModifiedAt || null,
      stale: Boolean(markerCache.lastError) || now() - markerCache.at >= CACHE_TTL_MS,
      total: filtered.length, projects: filtered };
  }
  async function getProject(value) {
    const id = String(value).replace(/^site/i, '');
    if (!/^\d+$/.test(id)) throw Object.assign(new Error('Invalid CCS site ID'), { statusCode: 400 });
    const sourceUrl = `${DETAILS}/${id}/null`;
    const response = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`CCS detail feed returned ${response.status}`);
    const detail = await response.json();
    return { ...detail, SourceUrl: sourceUrl,
      retrievedAt: new Date(now()).toISOString(), sourcePublicationDate: null,
      sourceRecordDate: detail.Date || null,
      sourceLastModifiedAt: response.headers.get('last-modified') || null };
  }
  function health() {
    const markerAgeMs = markerCache.at ? now() - markerCache.at : null;
    return {
      ok: Boolean(markerCache.data.length) || !markerCache.lastError,
      markerCacheStatus: markerCache.data.length
        ? (markerAgeMs > CACHE_TTL_MS ? 'stale' : 'ready')
        : (markerCache.lastError ? 'error' : 'warming'),
      markerCacheAt: markerCache.at || null,
      markerCacheProjects: markerCache.data.length,
      markerCacheLastAttemptAt: markerCache.lastAttemptAt || null,
      markerCacheLastError: markerCache.lastError,
      scheduleCacheAt: scheduleCache.at || null,
      scheduleCacheProjects: scheduleCache.data.size,
      scheduleCacheLastError: scheduleCache.lastError,
    };
  }
  return { origin, listProjects, getProject, health: () => ({ ...health(), deployment: deploymentVersion }),
    warm: () => Promise.all([markers(), projectSchedules()]), refresh: markers };
}
