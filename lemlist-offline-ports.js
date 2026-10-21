// Injected ports only: no fetch, connection constructor, environment or credentials.
export const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export function syntheticGate(options) {
  requireValue(options.enabled === true && options.mode === 'synthetic', 'Disabled: synthetic execution only');
}
const id = value => {
  requireValue(typeof value === 'string' && /^[\w-]{1,200}$/.test(value), 'Invalid identifier');
  return encodeURIComponent(value);
};
const email = value => {
  requireValue(typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && value === value.trim().toLowerCase(), 'Invalid normalized email');
  return value;
};

// Errors intentionally omit URLs, credentials, response bodies and personal data.
function createRequest(options) {
  return async (request, retryRead = false) => {
    syntheticGate(options);
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await options.request(structuredClone(request)); }
      catch { throw new Error('Provider outcome unknown'); }
      if (retryRead && [429, 502, 503, 504].includes(response?.status) && attempt < 2) {
        const retry = Number(response.retryAfterSeconds ?? 1);
        requireValue(Number.isFinite(retry) && retry >= 0 && retry <= 30, 'Provider retry exceeds bound');
        requireValue(typeof options.delay === 'function', 'Retry requires injected delay');
        await options.delay(retry * 1000);
        continue;
      }
      requireValue(Number.isInteger(response?.status) && response.status >= 200 && response.status < 300, 'Provider request not successful');
      return response.body;
    }
    throw new Error('Provider retry exhausted');
  };
}

export function createLemlistPort(options = {}) {
  const request = createRequest(options);
  const campaign = value => {
    syntheticGate(options);
    requireValue(value === options.campaignId, 'Campaign outside allowlist');
    return id(value);
  };
  async function listLeads(campaignId) {
    const campaignIdPath = campaign(campaignId), rows = [], seen = new Set();
    const limit = options.pageSize ?? 100;
    requireValue(Number.isInteger(limit) && limit > 0 && limit <= 500, 'Invalid page size');
    for (let offset = 0; offset < 100000; offset += limit) {
      const page = await request({ provider:'lemlist', method:'GET', path:`/api/campaigns/${campaignIdPath}/leads/`, query:{limit,offset} }, true);
      requireValue(Array.isArray(page) && page.length <= limit, 'Incomplete lead page');
      for (const row of page) {
        requireValue(row && typeof row._id === 'string' && !seen.has(row._id), 'Unstable lead pagination');
        seen.add(row._id); rows.push(row);
      }
      if (page.length < limit) return rows;
    }
    throw new Error('Lead pagination limit exceeded');
  }
  async function getLead(campaignId, recipient) {
    // This campaign endpoint accepts email or ID; list responses contain IDs only.
    const body = await request({provider:'lemlist',method:'GET',path:`/api/campaigns/${campaign(campaignId)}/leads/${encodeURIComponent(email(recipient))}`}, true);
    requireValue(body?.campaignId === campaignId && body.email === recipient && typeof body._id === 'string', 'Lead readback identity mismatch');
    return body;
  }
  return {
    listLeads,
    getLead,
    async lookup({campaignId, email:recipient}) {
      const row = await getLead(campaignId, recipient);
      return {complete:true,matches:[{...row,id:row._id}]};
    },
    async enroll({campaignId,payload,launch}) {
      const path = `/api/campaigns/${campaign(campaignId)}/leads`;
      requireValue(launch === false && options.allowSyntheticWrites === true, 'Synthetic writes disabled');
      email(payload?.email);
      requireValue(payload?.projectName && payload?.firstName && payload?.sitefinderProjectId, 'Missing reviewed variables');
      // Never forward launch as a guessed API safety parameter. No start/review
      // endpoint exists in this adapter. Actual paused-state behavior is unverified.
      const result = await request({provider:'lemlist',method:'POST',path,
        query:{deduplicate:true,updateStrategy:'fillEmptyOnly',linkedinEnrichment:false,findEmail:false,verifyEmail:false,findPhone:false},body:payload});
      requireValue(result && (result.warnings===undefined || (Array.isArray(result.warnings) && result.warnings.length===0)), 'Provider warnings require reconciliation');
      return result;
    },
    async pause({campaignId,leadId,email:recipient}) {
      campaign(campaignId); email(recipient); id(leadId);
      requireValue(options.allowSyntheticWrites === true, 'Synthetic writes disabled');
      // Read-before-write allows recovery after timeout without blindly repeating.
      const before = await getLead(campaignId,recipient);
      requireValue(before._id === leadId, 'Pause identity mismatch');
      if (before.isPaused !== true) await request({provider:'lemlist',method:'POST',path:`/api/leads/pause/${id(leadId)}`,query:{campaignId}});
      const after = await getLead(campaignId,recipient);
      requireValue(after._id === leadId && after.isPaused === true, 'Pause not confirmed');
      return {confirmed:true,leadId,campaignId};
    },
  };
}

export function createAttioReadPort(options = {}) {
  const request = createRequest(options);
  return {
    async listRecords(object) {
      syntheticGate(options);
      requireValue(['companies','people','projects','leads','activity_history'].includes(object), 'Object outside read allowlist');
      const limit=options.pageSize ?? 500, rows=[], seen=new Set();
      requireValue(Number.isInteger(limit) && limit>0 && limit<=500, 'Invalid page size');
      for(let offset=0;offset<100000;offset+=limit) {
        const page=await request({provider:'attio',method:'POST',path:`/v2/objects/${id(object)}/records/query`,body:{limit,offset}},true);
        requireValue(Array.isArray(page?.data) && page.data.length<=limit,'Incomplete Attio page');
        for(const row of page.data) {
          requireValue(typeof row.id?.record_id==='string' && !seen.has(row.id.record_id),'Unstable Attio pagination');
          seen.add(row.id.record_id);rows.push(row);
        }
        if(page.data.length<limit)return rows;
      }
      throw new Error('Attio pagination limit exceeded');
    },
  };
}

// Neither raw lead state nor a short final page proves historical coverage or a
// consistent snapshot. A reviewed, identity-bound coverage record is mandatory.
export function normalizeHistorySnapshot({provider,rows,coverage,mapRecord,now}) {
  requireValue(['lemlist','attio','woodpecker'].includes(provider),'Unknown provider');
  requireValue(coverage?.provider===provider && coverage.complete===true && coverage.stable===true
    && coverage.history===true && coverage.suppressions===true && typeof coverage.reference==='string' && coverage.reference.length>0
    && Date.parse(coverage.checkedAt)<=Date.parse(now) && Date.parse(now)-Date.parse(coverage.checkedAt)<=900000,'Unverified source coverage');
  requireValue(Array.isArray(rows) && typeof mapRecord==='function','Missing reviewed field mapping');
  const records=rows.map(row=>{
    const r=mapRecord(structuredClone(row));email(r?.email);
    requireValue(/^attio:[\w-]+$/.test(r?.companyKey)
      && ['active','contacted','suppressed','bounced','replied'].every(k=>typeof r[k]==='boolean'),'Incomplete history mapping');
    return r;
  });
  return {provider,checkedAt:coverage.checkedAt,complete:true,records,coverageReference:coverage.reference};
}

// Unknown optional sources hold, but do not mandate buying/configuring that API.
export function createSourceInventoryReader({inventory,readSnapshot}) {
  return async(provider,now)=>{
    const item=inventory?.[provider];
    requireValue(item && ['in_use','not_used'].includes(item.status),'Source usage unconfirmed');
    requireValue(item.verifiedBy && item.reference && Date.parse(item.checkedAt)<=Date.parse(now)
      && Date.parse(now)-Date.parse(item.checkedAt)<=900000,'Source inventory stale');
    if(item.status==='not_used') {
      requireValue(provider==='woodpecker','Required source cannot be disabled');
      return {provider,checkedAt:item.checkedAt,complete:true,records:[],unusedVerified:true};
    }
    return readSnapshot(provider,now);
  };
}

const flags=['active','contacted','suppressed','bounced','replied'];
function historyFor(evidence,subjectId) {
  requireValue(evidence?.subjectId===subjectId && flags.every(k=>typeof evidence[k]==='boolean'),'History is not bound to record');
  return Object.fromEntries(flags.map(k=>[k,evidence[k]]));
}
export function mapLemlistHistoryLead(row,{companyKey,evidence}) {
  email(row?.email);
  requireValue(typeof row._id==='string' && row.campaignId===evidence?.campaignId && /^attio:[\w-]+$/.test(companyKey),'Unverified lead/company join');
  return {email:row.email,companyKey,projectId:row.sitefinderProjectId,ownerEmail:evidence.ownerEmail,
    ...historyFor(evidence,row._id)};
}
export function mapAttioHistoryPerson(row,{approvedEmail,companyId,companyAttribute='company',evidence}) {
  const recordId=row?.id?.record_id;requireValue(typeof recordId==='string','Missing person record ID');
  const addresses=row.values?.email_addresses?.map(v=>String(v.email_address||'').trim().toLowerCase());
  const recipient=approvedEmail ?? (addresses?.length===1?addresses[0]:null);
  email(recipient);requireValue(addresses?.includes(recipient),'Recipient not in person record');
  requireValue(/^[\w-]+$/.test(companyId) && row.values?.[companyAttribute]?.some(v=>v.target_record_id===companyId && v.target_object==='companies'),'Unverified person/company link');
  return {email:recipient,companyKey:`attio:${companyId}`,ownerEmail:evidence?.ownerEmail,...historyFor(evidence,recordId)};
}
