import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = process.env.PORT || 8787;
const MARKERS = 'https://ccsfilestore.blob.core.windows.net/constructionmap/live/json/sitemarkers.json';
const DETAILS = 'https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails';
let markerCache = { at: 0, data: [] };

const targetAuthority = /London Borough|City of London|Westminster|Royal Borough of (Greenwich|Kensington and Chelsea)|Essex|Kent|Surrey|Hertfordshire|Berkshire|Buckinghamshire|Hampshire|Sussex|Oxfordshire|Bedfordshire|Harlow|Canterbury|Sevenoaks|Elmbridge|Wealden|Arun|Winchester|Oxford City|Luton|Dacorum|Watford|St Albans|Three Rivers|Welwyn|Stevenage|Broxbourne|Basildon|Braintree|Brentwood|Castle Point|Chelmsford|Colchester|Epping Forest|Maldon|Rochford|Southend|Thurrock|Ashford|Dartford|Dover|Folkestone|Gravesham|Maidstone|Medway|Swale|Thanet|Tonbridge|Tunbridge|Epsom|Guildford|Mole Valley|Reigate|Runnymede|Spelthorne|Tandridge|Waverley|Woking|Bracknell|Reading|Slough|Windsor|Wokingham|Milton Keynes|Basingstoke|Eastleigh|Fareham|Gosport|Hart District|Havant|New Forest|Portsmouth|Rushmoor|Southampton|Test Valley|Brighton|Chichester|Crawley|Horsham|Lewes|Mid Sussex|Rother|Worthing|Adur|Cherwell|West Oxfordshire|Vale of White Horse|Bedford Borough|Central Bedfordshire/i;

export function isTargetProject(project) {
  return targetAuthority.test(String(project.LaId || ''));
}

async function markers() {
  if (Date.now() - markerCache.at < 30 * 60_000 && markerCache.data.length) return markerCache.data;
  const response = await fetch(MARKERS);
  if (!response.ok) throw new Error(`CCS marker feed returned ${response.status}`);
  const raw = await response.json();
  markerCache = { at: Date.now(), data: raw };
  return raw;
}

app.get('/api/projects', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const region = String(req.query.region || 'target');
    const all = await markers();
    const filtered = all.filter(x => {
      const haystack = [x.Name, x.Client, x.MainContractor, x.LaId].join(' ');
      return (region === 'all' || isTargetProject(x)) && (!q || haystack.toLowerCase().includes(q));
    });
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ source: MARKERS, updatedAt: new Date(markerCache.at).toISOString(), total: filtered.length, projects: filtered });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const id = String(req.params.id).replace(/^site/, '');
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid CCS site ID' });
    const sourceUrl = `${DETAILS}/${id}/null`;
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`CCS detail feed returned ${response.status}`);
    res.json({ ...(await response.json()), SourceUrl: sourceUrl });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/health', (_req, res) => res.json({ ok: true, markerCacheAt: markerCache.at || null }));
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root, 'dist')));
app.use((req, res, next) => req.method === 'GET' ? res.sendFile(path.join(root, 'dist', 'index.html')) : next());
setInterval(() => markers().catch(error => console.error('CCS refresh failed:', error.message)), 30 * 60_000).unref();
app.listen(PORT, '0.0.0.0', () => console.log(`GSD SiteFinder listening on port ${PORT}`));
