import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Search, MapPin, Map as MapIcon, LocateFixed, MoreHorizontal, ArrowUp, ArrowDown, ArrowUpDown, Star, StickyNote, ExternalLink, X, RefreshCw, Building2, SlidersHorizontal, Phone, Mail, CalendarDays, Bookmark, BarChart3, Users, FolderKanban, ChevronLeft, ChevronRight, CheckSquare, Circle, CheckCircle2, Trash2, Plus, Megaphone, Bot } from 'lucide-react';
import './styles.css';
import './mobile.css';
import AuthGate from './AuthGate';
import { CommunicationTimeline, OutreachPage } from './Outreach';
import { ResearchAgentPage } from './ResearchAgent';
import { apiFetch } from './api';
import { supabase } from './supabase';
import { projectIdFromSearch, projectSearchUrl } from './projectLinks';
import { hasCurrentAttioLink, needsProjectClassification } from './projectStatus';
import { postcodeFromAddress } from '../supabase/functions/_shared/project-enrichment.js';

const ProjectMap = lazy(() => import('./ProjectMap'));
const API = '/api';
const PAGE_SIZE = 30;
const NEW_DAYS = 7;
const STAGES = ['new','reviewing','contacted','quoting','won','lost'];
const fallback = [
  {Id:'site520666',Name:'Ladywell Park Gardens',MainContractor:'Higgins Partnerships',Client:'Louise Hunt',LaId:'London Borough of Lewisham',Latitude:51.4567,Longitude:-0.0132},
  {Id:'site518253',Name:'22 Hill Street',MainContractor:'Overbury plc',Client:'Berkeley Estate Asset Management',LaId:'Westminster City Council',Latitude:51.5088,Longitude:-0.1486},
  {Id:'site517241',Name:'Allen & Overy Shearman',MainContractor:'Overbury plc',Client:'Allen & Overy Shearman',LaId:'City of London',Latitude:51.5188,Longitude:-0.0843},
  {Id:'site116717',Name:'CitiBank',MainContractor:'Overbury plc',Client:'Citibank',LaId:'London Borough of Tower Hamlets',Latitude:51.5042,Longitude:-0.0177},
];
const fmtDate = d => d ? new Intl.DateTimeFormat('en-GB').format(new Date(d)) : 'Not published';
const value = (v, fallbackText='Not published') => String(v || '').trim() || fallbackText;
const timingLabel = timing => ({
  completing_0_3m:'Completing 0–3 months',
  decorating_3_9m:'Decorating window',
  monitor_9_18m:'Monitor 9–18 months',
  early_over_18m:'Early opportunity',
  overdue:'Past finish date',
  unknown:'Timing unknown',
})[timing||'unknown']||'Timing unknown';
const programmeLabel = stage => ({
  early:'Early programme',
  mid:'Mid programme',
  late:'Late programme',
  closed:'Closed',
  unknown:'Stage unknown',
})[stage||'unknown']||'Stage unknown';
const projectCompleteness = (project,meta={},intelligence={}) => {
  const fields=[
    project.Name,project.MainContractor,project.Client,project.LaId,
    meta.address,project.Latitude!=null&&project.Longitude!=null,meta.site_start_date,
    meta.site_end_date,meta.site_manager_name,meta.site_manager_phone,
    meta.marker_email,intelligence.programme_stage&&intelligence.programme_stage!=='unknown',
    intelligence.gsd_timing&&intelligence.gsd_timing!=='unknown',
  ];
  return Math.round(fields.filter(Boolean).length/fields.length*100);
};
const unique = (items, key) => [...new Set(items.map(item => item[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
const isoDateMonthsFromNow = months => {
  const date = new Date();
  date.setHours(0,0,0,0);
  date.setMonth(date.getMonth()+months);
  return date.toISOString().slice(0,10);
};
const matchesCompletionWindow = (dateValue, window) => {
  if(!window)return true;
  if(!dateValue)return window==='unknown';
  if(window==='unknown')return false;
  const date=String(dateValue).slice(0,10), today=isoDateMonthsFromNow(0);
  if(window==='next-3')return date>=today&&date<=isoDateMonthsFromNow(3);
  if(window==='3-9')return date>=isoDateMonthsFromNow(3)&&date<=isoDateMonthsFromNow(9);
  if(window==='9-18')return date>=isoDateMonthsFromNow(9)&&date<=isoDateMonthsFromNow(18);
  if(window==='past')return date<today;
  return true;
};
const fetchAllRows = async (table, columns, pageSize=1000, filterQuery=query=>query) => {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const query=filterQuery(supabase.from(table).select(columns));
    const {data,error} = await query.range(from,from+pageSize-1);
    if (error) return {data:null,error};
    rows.push(...(data||[]));
    if (!data || data.length < pageSize) return {data:rows,error:null};
  }
};
const navItems = [
  {id:'projects',label:'Projects',icon:FolderKanban},
  {id:'map',label:'Map',icon:MapIcon},
  {id:'saved',label:'Saved',icon:Bookmark},
  {id:'tasks',label:'Tasks',icon:CheckSquare},
  {id:'outreach',label:'Outreach',icon:Megaphone},
  {id:'research',label:'Research Agent',icon:Bot},
  {id:'insights',label:'Insights',icon:BarChart3},
  {id:'contractors',label:'Contractors',icon:Users},
];

const demoOutreachLeads = [
  {id:'demo-bowmer',project_id:'site520001',project_name:'Office & warehouse, Birmingham',recipient_email:'procurement@bandk.co.uk',recipient_name:'Jemima Rowe',company_name:'Bowmer + Kirkland',status:'queued',email_subject:'Painting and spray support for your Birmingham project',email_body:'Hi Jemima,\\n\\nI came across Bowmer + Kirkland’s new office and warehouse project in Birmingham and wanted to introduce GSD Decorating.\\n\\nWe support main contractors with high-quality painting, decorating and specialist spray finishes. We would welcome the opportunity to price the relevant packages for this project.\\n\\nWould it be useful if I sent over a short capability summary and examples of similar work?\\n\\nKind regards,\\nSam Ward\\nGSD Decorating',attio_record_id:'demo-attio-1',attio_synced_at:'2026-07-29T10:28:00Z',created_at:'2026-07-29T09:14:00Z',updated_at:'2026-07-29T10:29:00Z'},
  {id:'demo-overbury',project_id:'site517241',project_name:'HQ fit-out, London',recipient_email:'david.walsh@overbury.com',recipient_name:'David Walsh',company_name:'Overbury plc',status:'queued',email_subject:'Decorating support for your London fit-out',email_body:'Hi David,\\n\\nI noticed the new London fit-out and wanted to introduce GSD Decorating.\\n\\nWe support fit-out contractors with commercial decorating and spray finishes across London and the South East.\\n\\nWould you be the right person to speak with about the package?\\n\\nKind regards,\\nSam Ward\\nGSD Decorating',created_at:'2026-07-29T08:41:00Z',updated_at:'2026-07-29T09:41:00Z'},
  {id:'demo-parkeray',project_id:'site520220',project_name:'Retail scheme, Barking',recipient_email:'ian.ambrose@parkeray.co.uk',recipient_name:'Ian Ambrose',company_name:'Parkeray Ltd',status:'approved',email_subject:'Painting support for your Barking retail scheme',email_body:'Hi Ian,\\n\\nI came across the Barking retail scheme and wanted to introduce GSD Decorating.\\n\\nWe would welcome the opportunity to price the painting and decorating packages.\\n\\nKind regards,\\nSam Ward\\nGSD Decorating',created_at:'2026-07-28T14:18:00Z',updated_at:'2026-07-29T09:18:00Z'},
  {id:'demo-mackley',project_id:'site520831',project_name:'Industrial extension, Leicester',recipient_email:'glen.oaten@mackley.co.uk',recipient_name:'Glen Oaten',company_name:'J T Mackley & Co Ltd',status:'sent',email_subject:'Decorating support for your Leicester project',email_body:'Hi Glen,\\n\\nI wanted to introduce GSD Decorating in relation to your Leicester industrial extension.\\n\\nKind regards,\\nSam Ward\\nGSD Decorating',created_at:'2026-07-27T08:32:00Z',updated_at:'2026-07-29T08:32:00Z'},
  {id:'demo-bam',project_id:'site520900',project_name:'Education project, Kent',recipient_email:'commercial@bam.com',recipient_name:'Commercial Team',company_name:'BAM Construction',status:'followup_due',email_subject:'Follow-up: Kent education project',email_body:'Hi,\\n\\nI wanted to follow up on my note about the Kent education project.\\n\\nKind regards,\\nSam Ward\\nGSD Decorating',created_at:'2026-07-20T08:32:00Z',updated_at:'2026-07-24T08:32:00Z'},
];

function SelectFilter({label,value,onChange,options,allLabel}) {
  return <label className="filter"><span>{label}</span><select value={value} onChange={e=>onChange(e.target.value)}><option value="">{allLabel}</option>{options.map(option=><option key={option} value={option}>{option}</option>)}</select></label>;
}

function App({session,cloudEnabled}){
  const [projects,setProjects]=useState([]), [query,setQuery]=useState(''), [selected,setSelected]=useState(null), [detail,setDetail]=useState(null);
  const [loading,setLoading]=useState(true), [error,setError]=useState(''), [activeView,setActiveView]=useState(()=>new URLSearchParams(window.location.search).get('view')||'projects'), [page,setPage]=useState(1);
  const [mapFitRequest,setMapFitRequest]=useState(0);
  const [mobileMoreOpen,setMobileMoreOpen]=useState(false);
  const [saved,setSaved]=useState(()=>new Set(JSON.parse(localStorage.getItem('gsd-saved')||'[]'))), [notes,setNotes]=useState(()=>JSON.parse(localStorage.getItem('gsd-notes')||'{}'));
  const [history,setHistory]=useState({}), [syncStatus,setSyncStatus]=useState(null), [tracking,setTracking]=useState({});
  const [attioLinks,setAttioLinks]=useState({}), [enrichment,setEnrichment]=useState({});
  const [tasks,setTasks]=useState([]);
  const [outreachLeads,setOutreachLeads]=useState(()=>cloudEnabled?[]:demoOutreachLeads), [communications,setCommunications]=useState([]), [suppressions,setSuppressions]=useState([]);
  const [mailboxes,setMailboxes]=useState([]), [mailboxesLoading,setMailboxesLoading]=useState(cloudEnabled), [mailboxError,setMailboxError]=useState('');
  const [draftFilters,setDraftFilters]=useState({location:'',contractor:'',client:'',recency:'',completionWindow:'',opportunity:'',liveOnly:true}), [filters,setFilters]=useState({location:'',contractor:'',client:'',recency:'',completionWindow:'',opportunity:'',liveOnly:true});
  const draftFiltersRef=useRef(draftFilters);

  const load=()=>{setLoading(true);setError('');apiFetch(`${API}/projects`,{cache:'no-store'}).then(async r=>{if(!r.ok) throw new Error((await r.json()).error||'Unable to load CCS projects');return r.json()}).then(d=>setProjects(d.projects||fallback)).catch(err=>{setProjects(fallback);setError(`${err.message}. Showing cached examples.`)}).finally(()=>setLoading(false))};
  useEffect(load,[]);
  useEffect(()=>{ if(!cloudEnabled) return; Promise.all([
    supabase.from('saved_projects').select('project_id'),
    supabase.from('project_notes').select('project_id,note'),
    fetchAllRows('ccs_projects','project_id,first_seen_at,last_seen_at,last_changed_at,discovered_after_baseline,is_active,site_start_date,site_end_date,site_closed,address,site_manager_name,site_manager_job_title,site_manager_phone,marker_email,last_visit_date,detail_last_checked_at'),
    supabase.from('ccs_sync_runs').select('completed_at,total_projects,new_projects,changed_projects,detail_projects,detail_errors,status').eq('status','completed').order('completed_at',{ascending:false}).limit(1).maybeSingle(),
    supabase.from('lead_tracking').select('project_id,stage,assigned_email,next_action,next_action_at,updated_at'),
    supabase.from('project_tasks').select('*').order('completed',{ascending:true}).order('due_date',{ascending:true,nullsFirst:false}).order('created_at',{ascending:false}),
    fetchAllRows('outreach_leads','*'),
    fetchAllRows('outreach_communications','*'),
    fetchAllRows('outreach_suppressions','*'),
    fetchAllRows('attio_sync_links','project_id,attio_record_id,attio_web_url,sync_status,sync_error,synced_at',1000,query=>query.eq('entity_type','project')),
    fetchAllRows('ccs_project_enrichment','*')
  ]).then(([s,n,h,sync,t,taskRows,outreachRows,communicationRows,suppressionRows,attioRows,enrichmentRows])=>{if(s.data)setSaved(new Set(s.data.map(x=>x.project_id)));if(n.data)setNotes(Object.fromEntries(n.data.map(x=>[x.project_id,x.note])));if(h.data)setHistory(Object.fromEntries(h.data.map(x=>[x.project_id,x])));if(sync.data)setSyncStatus(sync.data);if(t.data)setTracking(Object.fromEntries(t.data.map(x=>[x.project_id,x])));if(taskRows.data)setTasks(taskRows.data);if(outreachRows.data)setOutreachLeads(outreachRows.data);if(communicationRows.data)setCommunications(communicationRows.data);if(suppressionRows.data)setSuppressions(suppressionRows.data);if(attioRows.data)setAttioLinks(Object.fromEntries(attioRows.data.filter(x=>x.project_id).map(x=>[x.project_id,x])));if(enrichmentRows.data)setEnrichment(Object.fromEntries(enrichmentRows.data.map(x=>[x.project_id,x])))}) },[cloudEnabled]);
  useEffect(()=>setPage(1),[query,filters,activeView]);
  const loadMailboxes=useCallback(async()=>{
    if(!cloudEnabled){setMailboxesLoading(false);return}
    setMailboxesLoading(true);
    setMailboxError('');
    const {data,error:mailboxError}=await supabase.functions.invoke('gmail-mailboxes',{body:{action:'list'}});
    let mailboxMessage=data?.error||mailboxError?.message;
    if(mailboxError?.context){const responseBody=await mailboxError.context.clone().json().catch(()=>null);mailboxMessage=responseBody?.error||mailboxMessage}
    if(mailboxError||data?.error)setMailboxError(`Could not load sending mailboxes: ${mailboxMessage}`);
    else setMailboxes(data?.mailboxes||[]);
    setMailboxesLoading(false);
  },[cloudEnabled]);
  useEffect(()=>{if(activeView==='outreach')loadMailboxes()},[activeView,loadMailboxes]);
  const connectMailbox=async()=>{
    if(!cloudEnabled){window.location.assign('https://gsd-sitefinder.onrender.com/?view=outreach');return}
    setMailboxError('');
    const {data,error:mailboxError}=await supabase.functions.invoke('gmail-mailboxes',{body:{action:'begin'}});
    let mailboxMessage=data?.error||mailboxError?.message;
    if(mailboxError?.context){const responseBody=await mailboxError.context.clone().json().catch(()=>null);mailboxMessage=responseBody?.error||mailboxMessage}
    if(mailboxError||data?.error||!data?.auth_url){setMailboxError(`Could not start Gmail connection: ${mailboxMessage||'No connection URL returned'}`);return}
    window.location.assign(data.auth_url);
  };

  const options=useMemo(()=>({locations:unique(projects,'LaId'),contractors:unique(projects,'MainContractor'),clients:unique(projects,'Client')}),[projects]);
  const filtered=useMemo(()=>projects.filter(p=>{
    const intelligence=enrichment[p.Id]||{}, meta=history[p.Id]||{};
    const search=[
      p.Name,p.MainContractor,p.Client,p.LaId,p.Id,meta.address,
      meta.site_manager_name,intelligence.sector,intelligence.work_type,
      timingLabel(intelligence.gsd_timing),programmeLabel(intelligence.programme_stage),
    ].join(' ').toLowerCase();
    const age=meta.first_seen_at?Date.now()-new Date(meta.first_seen_at).getTime():Infinity, changedAge=meta.last_changed_at?Date.now()-new Date(meta.last_changed_at).getTime():Infinity;
    return (!query.trim()||search.includes(query.trim().toLowerCase()))
      && (!filters.location||p.LaId===filters.location)
      && (!filters.contractor||p.MainContractor===filters.contractor)
      && (!filters.client||p.Client===filters.client)
      && (!filters.recency||(filters.recency==='new'&&meta?.discovered_after_baseline&&age<=NEW_DAYS*86400000)||(filters.recency==='updated'&&changedAge<=NEW_DAYS*86400000&&new Date(meta.last_changed_at).getTime()>new Date(meta.first_seen_at).getTime()+1000))
      && matchesCompletionWindow(meta?.site_end_date||p.SiteEndDate,filters.completionWindow)
      && (!filters.opportunity
        || (filters.opportunity==='decorating'&&intelligence.gsd_timing==='decorating_3_9m')
        || (filters.opportunity==='fit-out'&&intelligence.fit_out_state==='yes')
        || (filters.opportunity==='new-build-housing'&&intelligence.new_build_housing_state==='yes')
        || (filters.opportunity==='contact'&&Boolean(meta?.marker_email||meta?.site_manager_phone))
        || (filters.opportunity==='attio'&&hasCurrentAttioLink(attioLinks[p.Id]))
        || (filters.opportunity==='needs-classification'&&needsProjectClassification(intelligence)))
      && (!filters.liveOnly||p.TypeOfSite==='CCS'||!p.TypeOfSite);
  }),[projects,query,filters,history,enrichment,attioLinks]);
  const visibleProjects=activeView==='saved'?filtered.filter(p=>saved.has(p.Id)):filtered;
  const totalPages=Math.max(1,Math.ceil(visibleProjects.length/PAGE_SIZE));
  const shown=visibleProjects.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);
  const contractorStats=useMemo(()=>Object.values(projects.reduce((acc,p)=>{const name=value(p.MainContractor,'Unknown contractor');if(!acc[name])acc[name]={name,count:0,locations:new Set(),saved:0};acc[name].count++;if(p.LaId)acc[name].locations.add(p.LaId);if(saved.has(p.Id))acc[name].saved++;return acc},{})).sort((a,b)=>b.count-a.count),[projects,saved]);
  const syncIsStale=syncStatus&&Date.now()-new Date(syncStatus.completed_at).getTime()>36*60*60*1000;

  const open=useCallback(async (p,{updateUrl=true}={})=>{setSelected(p);setDetail(null);if(updateUrl)window.history.replaceState({},'',projectSearchUrl(window.location,p.Id));try{const r=await apiFetch(`${API}/projects/${p.Id}`);if(!r.ok)throw new Error('Detail unavailable');setDetail(await r.json())}catch{setDetail({...p,Address:p.LaId,SourceUrl:`https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/${p.Id.replace('site','')}/null`})}},[]);
  const closeProject=useCallback(()=>{setSelected(null);setDetail(null);window.history.replaceState({},'',projectSearchUrl(window.location,null))},[]);
  useEffect(()=>{
    const linkedId=projectIdFromSearch(window.location.search);
    if(!linkedId||!projects.length||selected?.Id===linkedId)return;
    const linkedProject=projects.find(project=>project.Id===linkedId);
    if(linkedProject){setActiveView('projects');open(linkedProject,{updateUrl:false})}
    else setError(`Project ${linkedId.replace('site','')} is not in the current SiteFinder feed.`);
  },[projects,selected?.Id,open]);
  const toggleSave=async p=>{const wasSaved=saved.has(p.Id),next=new Set(saved);wasSaved?next.delete(p.Id):next.add(p.Id);setSaved(next);localStorage.setItem('gsd-saved',JSON.stringify([...next]));if(cloudEnabled){const result=wasSaved?await supabase.from('saved_projects').delete().eq('project_id',p.Id):await supabase.from('saved_projects').upsert({project_id:p.Id,project_name:p.Name,saved_by:session.user.id});if(result.error){setSaved(saved);setError(`Could not update saved projects: ${result.error.message}`)}}};
  const addNote=async p=>{const note=window.prompt('Shared project note',notes[p.Id]||'');if(note===null)return;const next={...notes};note.trim()?next[p.Id]=note.trim():delete next[p.Id];setNotes(next);localStorage.setItem('gsd-notes',JSON.stringify(next));if(cloudEnabled){const result=note.trim()?await supabase.from('project_notes').upsert({project_id:p.Id,project_name:p.Name,note:note.trim(),updated_by:session.user.id,updated_at:new Date().toISOString()}):await supabase.from('project_notes').delete().eq('project_id',p.Id);if(result.error)setError(`Could not update note: ${result.error.message}`)}};
  const updateTracking=async(p,changes)=>{const next={...(tracking[p.Id]||{}),project_id:p.Id,...changes,updated_at:new Date().toISOString()};setTracking(x=>({...x,[p.Id]:next}));if(cloudEnabled){const {error:trackingError}=await supabase.from('lead_tracking').upsert({...next,updated_by:session.user.id});if(trackingError){setError(`Could not update lead: ${trackingError.message}`);return false}}return true};
  const createTask=async(p,input)=>{const optimistic={id:crypto.randomUUID(),project_id:p.Id,project_name:p.Name,title:input.title.trim(),assigned_email:input.assigned_email.trim()||null,due_date:input.due_date||null,completed:false,created_at:new Date().toISOString()};if(!optimistic.title)return false;setTasks(current=>[optimistic,...current]);if(cloudEnabled){const {data,error:taskError}=await supabase.from('project_tasks').insert({...optimistic,created_by:session.user.id,updated_by:session.user.id}).select().single();if(taskError){setTasks(current=>current.filter(task=>task.id!==optimistic.id));setError(`Could not create task: ${taskError.message}`);return false}setTasks(current=>current.map(task=>task.id===optimistic.id?data:task))}return true};
  const toggleTask=async task=>{const changes={completed:!task.completed,completed_at:task.completed?null:new Date().toISOString(),updated_at:new Date().toISOString()};setTasks(current=>current.map(item=>item.id===task.id?{...item,...changes}:item));if(cloudEnabled){const {error:taskError}=await supabase.from('project_tasks').update({...changes,updated_by:session.user.id}).eq('id',task.id);if(taskError){setTasks(current=>current.map(item=>item.id===task.id?task:item));setError(`Could not update task: ${taskError.message}`)}}};
  const deleteTask=async task=>{setTasks(current=>current.filter(item=>item.id!==task.id));if(cloudEnabled){const {error:taskError}=await supabase.from('project_tasks').delete().eq('id',task.id);if(taskError){setTasks(current=>[task,...current]);setError(`Could not delete task: ${taskError.message}`)}}};
  const queueOutreach=async(p,record={})=>{
    const existing=outreachLeads.find(lead=>lead.project_id===p.Id);
    if(existing){setActiveView('outreach');setSelected(null);return true}
    const contactName=[record.SiteManagerFirstName,record.SiteManagerLastName].filter(Boolean).join(' ')||null;
    const company=value(record.MainContractor||p.MainContractor,'your team');
    const row={id:crypto.randomUUID(),project_id:p.Id,project_name:p.Name,recipient_email:record.MarkerEmail||null,recipient_name:contactName,company_name:company,status:'queued',email_subject:`Painting and decorating support for ${p.Name}`,email_body:`Hi${contactName?` ${contactName.split(' ')[0]}`:''},\n\nI’m getting in touch from GSD Painting & Decorating regarding ${p.Name}.\n\nWe support main contractors with commercial painting and decorating packages across London and the Home Counties. If this package is still available, we would welcome the opportunity to introduce GSD and understand your requirements.\n\nWould you be the right person to speak with?\n\nKind regards,\nSam\nGSD Painting & Decorating`,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    setOutreachLeads(current=>[row,...current]);
    if(cloudEnabled){const {data,error:outreachError}=await supabase.from('outreach_leads').insert({...row,created_by:session.user.id,updated_by:session.user.id}).select().single();if(outreachError){setOutreachLeads(current=>current.filter(lead=>lead.id!==row.id));setError(`Could not add outreach lead: ${outreachError.message}`);return false}setOutreachLeads(current=>current.map(lead=>lead.id===row.id?data:lead))}
    setActiveView('outreach');setSelected(null);return true
  };
  const updateOutreach=async(lead,changes)=>{
    const now=new Date().toISOString(), updates={...changes,updated_at:now};
    if(changes.status==='approved'&&cloudEnabled)updates.approved_by=session.user.id;
    const previous=lead;
    setOutreachLeads(current=>current.map(item=>item.id===lead.id?{...item,...updates}:item));
    if(cloudEnabled){const {data,error:outreachError}=await supabase.from('outreach_leads').update({...updates,updated_by:session.user.id}).eq('id',lead.id).select().single();if(outreachError){setOutreachLeads(current=>current.map(item=>item.id===lead.id?previous:item));setError(`Could not update outreach: ${outreachError.message}`);return false}setOutreachLeads(current=>current.map(item=>item.id===lead.id?data:item));if(changes.status==='approved')await syncOutreachToAttio(data)}
    return true
  };
  const approveAndSendOutreach=async(lead,changes)=>{
    const approved=await updateOutreach(lead,changes);
    if(!approved)return {ok:false,sent:false,error:'The draft could not be approved.'};
    if(!cloudEnabled)return {ok:true,sent:false};
    const {data,error:sendError}=await supabase.functions.invoke('send-approved-outreach',{body:{lead_id:lead.id,mode:'initial'}});
    if(sendError||data?.error){
      const message=data?.error||sendError?.message||'GSD mailbox connection is not ready';
      setError(`Draft approved, but no email was sent: ${message}`);
      return {ok:false,sent:false,error:`Draft approved, but no email was sent: ${message}`};
    }
    const sentAt=new Date().toISOString();
    setOutreachLeads(current=>current.map(item=>item.id===lead.id?{...item,status:'sent',sent_at:sentAt,gmail_message_id:data.gmail_message_id,gmail_thread_id:data.gmail_thread_id,next_follow_up_at:data.next_follow_up_at,follow_up_step:data.follow_up_step,updated_at:sentAt}:item));
    const {data:historyRows}=await supabase.from('outreach_communications').select('*').eq('project_id',lead.project_id).order('occurred_at',{ascending:false});
    if(historyRows)setCommunications(current=>[...current.filter(item=>item.project_id!==lead.project_id),...historyRows]);
    return {ok:true,sent:true};
  };
  const syncOutreachToAttio=async lead=>{
    if(!cloudEnabled)return false;
    const {data,error:syncError}=await supabase.functions.invoke('sync-approved-leads-to-attio',{body:{lead_id:lead.id}});
    if(syncError||data?.error){const message=data?.error||syncError?.message||'Attio sync failed';setOutreachLeads(current=>current.map(item=>item.id===lead.id?{...item,attio_sync_error:message}:item));setError(`Lead approved, but Attio could not be updated: ${message}`);return false}
    setOutreachLeads(current=>current.map(item=>item.id===lead.id?{...item,attio_record_id:data.attio_record_id,attio_company_record_id:data.attio_company_record_id||null,attio_person_record_id:data.attio_person_record_id||null,attio_synced_at:data.attio_synced_at,attio_sync_error:null}:item));
    return true
  };
  const logCommunication=async(p,channel)=>{
    const label=channel==='phone'?'Call notes':'Communication note', body=window.prompt(label,'');
    if(body===null||!body.trim())return false;
    const lead=outreachLeads.find(item=>item.project_id===p.Id);
    const row={id:crypto.randomUUID(),project_id:p.Id,outreach_lead_id:lead?.id||null,direction:'internal',channel,status:'logged',subject:channel==='phone'?'Call logged':'Note added',body:body.trim(),occurred_at:new Date().toISOString(),created_at:new Date().toISOString()};
    setCommunications(current=>[row,...current]);
    if(cloudEnabled){const {data,error:communicationError}=await supabase.from('outreach_communications').insert({...row,created_by:session.user.id}).select().single();if(communicationError){setCommunications(current=>current.filter(item=>item.id!==row.id));setError(`Could not record communication: ${communicationError.message}`);return false}setCommunications(current=>current.map(item=>item.id===row.id?data:item))}
    return true
  };
  const updateDraftFilter=(key,nextValue)=>setDraftFilters(current=>{const next={...current,[key]:nextValue};draftFiltersRef.current=next;return next});
  const applyFilters=()=>setFilters({...draftFiltersRef.current});
  const clearFilters=()=>{const empty={location:'',contractor:'',client:'',recency:'',completionWindow:'',opportunity:'',liveOnly:true};draftFiltersRef.current=empty;setDraftFilters(empty);setFilters(empty);setQuery('')};
  const goToView=id=>{setActiveView(id);closeProject();setMobileMoreOpen(false)};

  return <div className="app">
    <header><div className="brand"><Building2/><b>GSD</b> SiteFinder</div><nav aria-label="Primary navigation">{navItems.map(({id,label,icon:Icon})=><button key={id} className={`${activeView===id?'active':''} ${['outreach','insights','contractors'].includes(id)?'secondary-nav':''}`} onClick={()=>goToView(id)}><Icon size={16}/>{label}{id==='saved'&&saved.size>0&&<span>{saved.size}</span>}</button>)}<button className={`more-nav ${mobileMoreOpen?'active':''}`} onClick={()=>setMobileMoreOpen(value=>!value)}><MoreHorizontal size={18}/>More</button></nav><button className="user" onClick={()=>cloudEnabled&&supabase.auth.signOut()} title={cloudEnabled?'Sign out':'Local preview'}>{session?.user?.email?.slice(0,2).toUpperCase()||'GC'}</button>{mobileMoreOpen&&<div className="mobile-more-menu">{navItems.filter(item=>['outreach','insights','contractors'].includes(item.id)).map(({id,label,icon:Icon})=><button key={id} onClick={()=>goToView(id)}><Icon size={17}/>{label}</button>)}</div>}</header>
    {(activeView==='projects'||activeView==='saved'||activeView==='map')&&<aside><div className="aside-title"><b>Filters</b><button onClick={clearFilters}>Clear all</button></div>
      <SelectFilter label="Location" value={draftFilters.location} onChange={location=>updateDraftFilter('location',location)} options={options.locations} allLabel="All locations"/>
      <SelectFilter label="Lead activity" value={draftFilters.recency} onChange={recency=>updateDraftFilter('recency',recency)} options={['new','updated']} allLabel="All project activity"/>
      <label className="filter"><span>Completion window</span><select value={draftFilters.completionWindow} onChange={e=>updateDraftFilter('completionWindow',e.target.value)}><option value="">Any completion date</option><option value="next-3">Completing in 0–3 months</option><option value="3-9">Decorating window: 3–9 months</option><option value="9-18">Completing in 9–18 months</option><option value="past">Past completion date</option><option value="unknown">Completion date unknown</option></select></label>
      <label className="filter"><span>Sales opportunity</span><select value={draftFilters.opportunity} onChange={e=>updateDraftFilter('opportunity',e.target.value)}><option value="">All opportunities</option><option value="decorating">Decorating window</option><option value="fit-out">Confirmed fit-out</option><option value="new-build-housing">Confirmed new-build housing</option><option value="contact">Contact available</option><option value="attio">Current Attio link</option><option value="needs-classification">Needs classification</option></select></label>
      <label className="switch-row"><span>Live Sites Only</span><input type="checkbox" checked={draftFilters.liveOnly} onChange={e=>updateDraftFilter('liveOnly',e.target.checked)}/><i/></label>
      <SelectFilter label="Contractor" value={draftFilters.contractor} onChange={contractor=>updateDraftFilter('contractor',contractor)} options={options.contractors} allLabel="All contractors"/>
      <SelectFilter label="Client" value={draftFilters.client} onChange={client=>updateDraftFilter('client',client)} options={options.clients} allLabel="All clients"/>
      <button className="apply" onClick={applyFilters}><SlidersHorizontal size={16}/> Apply filters</button>
    </aside>}
    <main className={`${(activeView==='insights'||activeView==='contractors'||activeView==='tasks'||activeView==='outreach'||activeView==='research')?'wide':''} ${activeView==='map'?'map-main':''}`}>
      {(activeView==='projects'||activeView==='saved')&&<><section className="toolbar"><div><strong>{visibleProjects.length.toLocaleString()} {activeView==='saved'?'saved':'active'} projects</strong><button className="icon" onClick={load} aria-label="Refresh projects"><RefreshCw size={16}/></button></div><label className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects, contractors, clients, locations…" aria-label="Search projects"/></label><button className="filter-mobile" onClick={()=>document.querySelector('aside')?.classList.toggle('open')}><SlidersHorizontal size={17}/> Filters</button></section>
        {error&&<div className="notice" role="alert">{error}<button onClick={()=>setError('')}><X size={15}/></button></div>}
        {syncIsStale&&<div className="notice sync-warning" role="alert">CCS data may be out of date. The last successful nightly sync was {new Date(syncStatus.completed_at).toLocaleString('en-GB')}.</div>}
        <ProjectTable loading={loading} projects={shown} selected={selected} saved={saved} notes={notes} history={history} tracking={tracking} enrichment={enrichment} attioLinks={attioLinks} open={open} toggleSave={toggleSave} addNote={addNote}/>
        <footer><div><span>Showing {shown.length?((page-1)*PAGE_SIZE)+1:0}–{Math.min(page*PAGE_SIZE,visibleProjects.length)} of {visibleProjects.length.toLocaleString()}</span>{syncStatus&&<small className="sync-status">CCS synced {new Date(syncStatus.completed_at).toLocaleString('en-GB')} · {syncStatus.new_projects} new · {syncStatus.changed_projects} updated{syncStatus.detail_projects?` · ${syncStatus.detail_projects} details checked`:''}{syncStatus.detail_errors?` · ${syncStatus.detail_errors} detail errors`:''}</small>}</div><div className="pagination"><button disabled={page===1} onClick={()=>setPage(x=>x-1)} aria-label="Previous page"><ChevronLeft size={16}/></button><b>Page {page} of {totalPages}</b><button disabled={page===totalPages} onClick={()=>setPage(x=>x+1)} aria-label="Next page"><ChevronRight size={16}/></button></div></footer>
      </>}
      {activeView==='map'&&<><section className="map-toolbar"><div className="map-toolbar-count"><strong>{filtered.length.toLocaleString()} projects on map</strong><button className="icon" onClick={load} aria-label="Refresh projects"><RefreshCw size={16}/></button></div><label className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects, contractors, clients, locations…" aria-label="Search map projects"/></label><button className="filter-mobile" onClick={()=>document.querySelector('aside')?.classList.toggle('open')}><SlidersHorizontal size={17}/> Filters</button><button className="fit-results" onClick={()=>setMapFitRequest(value=>value+1)}><LocateFixed size={17}/><span>Fit results</span></button></section>
        {error&&<div className="notice" role="alert">{error}<button onClick={()=>setError('')}><X size={15}/></button></div>}
        <Suspense fallback={<div className="map-loading">Loading project map…</div>}><ProjectMap projects={filtered} selected={selected} saved={saved} history={history} onSelect={open} fitRequest={mapFitRequest}/></Suspense>
      </>}
      {activeView==='insights'&&<Insights projects={projects} saved={saved} contractorStats={contractorStats}/>}
      {activeView==='tasks'&&<TaskDashboard tasks={tasks} projects={projects} openProject={open} toggleTask={toggleTask} deleteTask={deleteTask}/>}
      {activeView==='outreach'&&<OutreachPage leads={outreachLeads} communications={communications} suppressions={suppressions} mailboxes={mailboxes} mailboxesLoading={mailboxesLoading} mailboxError={mailboxError} connectMailbox={connectMailbox} updateLead={updateOutreach} approveAndSend={approveAndSendOutreach}/>}
      {activeView==='research'&&<ResearchAgentPage cloudEnabled={cloudEnabled} session={session}/>}
      {activeView==='contractors'&&<Contractors stats={contractorStats} onSelect={name=>{updateDraftFilter('contractor',name);setFilters(x=>({...x,contractor:name}));goToView('projects')}}/>}
    </main>
    {selected&&<ProjectDrawer className={activeView==='map'?'map-drawer':''} selected={selected} detail={detail} close={closeProject} saved={saved.has(selected.Id)} toggleSave={()=>toggleSave(selected)} note={notes[selected.Id]} addNote={()=>addNote(selected)} meta={history[selected.Id]} attioLink={attioLinks[selected.Id]} enrichment={enrichment[selected.Id]} tracking={tracking[selected.Id]} updateTracking={changes=>updateTracking(selected,changes)} tasks={tasks.filter(task=>task.project_id===selected.Id)} createTask={input=>createTask(selected,input)} toggleTask={toggleTask} deleteTask={deleteTask} outreachLead={outreachLeads.find(lead=>lead.project_id===selected.Id)} queueOutreach={()=>queueOutreach(selected,detail||{})} communications={communications.filter(item=>item.project_id===selected.Id)} logCommunication={channel=>logCommunication(selected,channel)}/>}
  </div>
}

function ProjectTable({loading,projects,selected,saved,notes,history,tracking,enrichment,attioLinks,open,toggleSave,addNote}){
  return <div className="table-wrap"><table className="projects-table"><thead><tr><th>Project</th><th>Contractor</th><th>Opportunity</th><th>Location</th><th>Finish</th><th>Contact</th><th>Attio</th><th>Saved</th><th>Notes</th></tr></thead><tbody>{loading?<tr><td colSpan="9" className="empty">Loading the live CCS feed…</td></tr>:projects.length===0?<tr><td colSpan="9" className="empty"><Search size={24}/><b>No projects found</b><span>Try changing your search or filters.</span></td></tr>:projects.map(p=>{
    const meta=history[p.Id]||{}, intelligence=enrichment[p.Id]||{}, attioLink=attioLinks[p.Id];
    const endDate=meta.site_end_date||p.SiteEndDate;
    const isNew=meta.discovered_after_baseline&&Date.now()-new Date(meta.first_seen_at).getTime()<=NEW_DAYS*86400000;
    const isUpdated=meta.last_changed_at&&Date.now()-new Date(meta.last_changed_at).getTime()<=NEW_DAYS*86400000&&new Date(meta.last_changed_at).getTime()>new Date(meta.first_seen_at).getTime()+1000&&!isNew;
    const contactChannels=[meta.marker_email&&'email',meta.site_manager_phone&&'phone'].filter(Boolean).join(' + ');
    const classification=[intelligence.sector,intelligence.work_type].filter(Boolean).join(' · ');
    return <tr key={p.Id} data-completion-date={endDate||''} className={selected?.Id===p.Id?'selected':''}>
      <td><div className="project-line"><button className="project" onClick={()=>open(p)}>{p.Name}</button>{isNew&&<span className="badge new">New</span>}{isUpdated&&<span className="badge updated">Updated</span>}{tracking[p.Id]?.stage&&tracking[p.Id].stage!=='new'&&<span className={`badge stage-${tracking[p.Id].stage}`}>{tracking[p.Id].stage}</span>}</div><small>CCS {p.Id.replace('site','')} · {projectCompleteness(p,meta,intelligence)}% complete</small></td>
      <td>{value(p.MainContractor)}</td>
      <td className="opportunity-cell"><span className={`timing-pill timing-${intelligence.gsd_timing||'unknown'}`}>{timingLabel(intelligence.gsd_timing)}</span><small>{classification||programmeLabel(intelligence.programme_stage)}</small></td>
      <td><MapPin size={14}/><span>{postcodeFromAddress(meta.address)||value(p.LaId)}</span></td>
      <td className={`date-cell ${endDate?'':'missing'}`}>{fmtDate(endDate)}<small>{programmeLabel(intelligence.programme_stage)}</small></td>
      <td><button className="contact-summary" onClick={()=>open(p)}><b>{meta.site_manager_name||'Not published'}</b><small>{contactChannels||'Open project details'}</small></button></td>
      <td>{attioLink?.attio_web_url?<span className="attio-link-status"><a className="attio-row-link" href={attioLink.attio_web_url} target="_blank" rel="noreferrer">Open <ExternalLink size={13}/></a>{attioLink.sync_status==='error'&&<small className="attio-refresh-error">Refresh failed</small>}</span>:<span className="pending-link">Pending</span>}</td>
      <td><button className={'row-icon '+(saved.has(p.Id)?'saved':'')} onClick={()=>toggleSave(p)} aria-label={`${saved.has(p.Id)?'Remove':'Save'} ${p.Name}`}><Star size={18} fill={saved.has(p.Id)?'currentColor':'none'}/></button></td>
      <td><button className="row-icon" onClick={()=>addNote(p)} aria-label={`Note for ${p.Name}`}><StickyNote size={18}/>{notes[p.Id]&&<em/>}</button></td>
    </tr>
  })}</tbody></table></div>
}

function Insights({projects,saved,contractorStats}){
  const locations=useMemo(()=>Object.entries(projects.reduce((acc,p)=>{const k=value(p.LaId,'Unknown');acc[k]=(acc[k]||0)+1;return acc},{})).sort((a,b)=>b[1]-a[1]).slice(0,8),[projects]);
  const max=Math.max(...locations.map(x=>x[1]),1);
  return <section className="dashboard"><div className="page-heading"><div><span>Portfolio overview</span><h1>Project insights</h1><p>Live summary of the CCS projects in your target region.</p></div></div><div className="stats"><article><span>Active projects</span><strong>{projects.length}</strong></article><article><span>Saved leads</span><strong>{saved.size}</strong></article><article><span>Contractors</span><strong>{contractorStats.length}</strong></article><article><span>Locations</span><strong>{locations.length}</strong></article></div><div className="insight-grid"><article className="panel"><h2>Top project locations</h2>{locations.map(([name,count])=><div className="bar-row" key={name}><div><span>{name}</span><b>{count}</b></div><i><em style={{width:`${count/max*100}%`}}/></i></div>)}</article><article className="panel"><h2>Leading contractors</h2>{contractorStats.slice(0,8).map((item,index)=><div className="rank" key={item.name}><span>{index+1}</span><div><b>{item.name}</b><small>{item.locations.size} locations</small></div><strong>{item.count}</strong></div>)}</article></div></section>;
}

function ContractorSortHeader({label,sortKey,sort,onSort,className=''}) {
  const active=sort.key===sortKey, direction=active?sort.direction:null;
  const Icon=!active?ArrowUpDown:direction==='asc'?ArrowUp:ArrowDown;
  return <th className={className} aria-sort={!active?'none':direction==='asc'?'ascending':'descending'}><button type="button" onClick={()=>onSort(sortKey)} aria-label={`Sort contractors by ${label} ${active&&direction==='asc'?'descending':'ascending'}`}>{label}<Icon size={14}/></button></th>;
}

function Contractors({stats,onSelect}){
  const [sort,setSort]=useState({key:'projects',direction:'desc'});
  const rows=useMemo(()=>stats.map(item=>{
    const locationNames=[...item.locations].sort((a,b)=>a.localeCompare(b));
    return {...item,locationNames,primaryLocation:locationNames[0]||'Location not published'};
  }).sort((a,b)=>{
    let result=0;
    if(sort.key==='contractor')result=a.name.localeCompare(b.name);
    if(sort.key==='location')result=a.primaryLocation.localeCompare(b.primaryLocation);
    if(sort.key==='projects')result=a.count-b.count;
    return (sort.direction==='asc'?result:-result)||a.name.localeCompare(b.name);
  }),[sort,stats]);
  const changeSort=key=>setSort(current=>current.key===key
    ? {...current,direction:current.direction==='asc'?'desc':'asc'}
    : {key,direction:key==='projects'?'desc':'asc'});
  return <section className="dashboard contractors-page"><div className="page-heading"><div><span>Directory</span><h1>Contractors</h1><p>Companies delivering active CCS projects in London and the Home Counties.</p></div></div><div className="contractor-table-shell"><table className="contractor-table"><thead><tr><ContractorSortHeader label="Contractor A–Z" sortKey="contractor" sort={sort} onSort={changeSort}/><ContractorSortHeader label="Location" sortKey="location" sort={sort} onSort={changeSort}/><ContractorSortHeader label="Active projects" sortKey="projects" sort={sort} onSort={changeSort} className="number-column"/><th aria-label="Open contractor projects"/></tr></thead><tbody>{rows.map(item=><tr key={item.name}><td><div className="contractor-name"><span className="contractor-icon"><Building2 size={19}/></span><button type="button" onClick={()=>onSelect(item.name)}>{item.name}</button></div></td><td><span>{item.primaryLocation}</span><small>{item.locations.size} location{item.locations.size===1?'':'s'}{item.locationNames.length>1?` · +${item.locationNames.length-1} more`:''}</small></td><td className="number-column"><strong>{item.count}</strong></td><td><button className="contractor-open" type="button" onClick={()=>onSelect(item.name)} aria-label={`View projects for ${item.name}`}><ChevronRight size={18}/></button></td></tr>)}</tbody></table></div></section>
}

function TaskDashboard({tasks,projects,openProject,toggleTask,deleteTask}){
  const openTasks=tasks.filter(task=>!task.completed), completed=tasks.filter(task=>task.completed), overdue=openTasks.filter(task=>task.due_date&&new Date(`${task.due_date}T23:59:59`)<new Date());
  const projectMap=useMemo(()=>new Map(projects.map(project=>[project.Id,project])),[projects]);
  return <section className="dashboard tasks-page"><div className="page-heading"><div><span>Team actions</span><h1>Task list</h1><p>Shared follow-ups across every active lead and project.</p></div></div><div className="stats task-stats"><article><span>Open tasks</span><strong>{openTasks.length}</strong></article><article><span>Overdue</span><strong>{overdue.length}</strong></article><article><span>Completed</span><strong>{completed.length}</strong></article></div><div className="task-board"><article className="panel"><h2>To do</h2>{openTasks.length===0?<p className="task-empty">No open tasks.</p>:openTasks.map(task=><TaskRow key={task.id} task={task} project={projectMap.get(task.project_id)} openProject={openProject} toggleTask={toggleTask} deleteTask={deleteTask}/>)}</article><article className="panel completed-panel"><h2>Completed</h2>{completed.length===0?<p className="task-empty">Completed tasks will appear here.</p>:completed.slice(0,25).map(task=><TaskRow key={task.id} task={task} project={projectMap.get(task.project_id)} openProject={openProject} toggleTask={toggleTask} deleteTask={deleteTask}/>)}</article></div></section>;
}

function TaskRow({task,project,openProject,toggleTask,deleteTask}){
  const overdue=!task.completed&&task.due_date&&new Date(`${task.due_date}T23:59:59`)<new Date();
  return <div className={`task-row ${task.completed?'done':''}`}><button className="task-check" onClick={()=>toggleTask(task)} aria-label={`${task.completed?'Reopen':'Complete'} ${task.title}`}>{task.completed?<CheckCircle2/>:<Circle/>}</button><div><b>{task.title}</b><button className="task-project" onClick={()=>project&&openProject(project)}>{task.project_name}</button><small>{task.assigned_email||'Unassigned'}{task.due_date&&<> · <span className={overdue?'overdue':''}>{overdue?'Overdue · ':''}{fmtDate(task.due_date)}</span></>}</small></div><button className="task-delete" onClick={()=>deleteTask(task)} aria-label={`Delete ${task.title}`}><Trash2 size={15}/></button></div>;
}

function ProjectTaskList({tasks,createTask,toggleTask,deleteTask}){
  const [adding,setAdding]=useState(false), [title,setTitle]=useState(''), [assigned,setAssigned]=useState(''), [due,setDue]=useState('');
  const submit=async event=>{event.preventDefault();if(await createTask({title,assigned_email:assigned,due_date:due})){setTitle('');setAssigned('');setDue('');setAdding(false)}};
  return <section className="project-tasks"><div className="section-title"><h3>Tasks ({tasks.filter(task=>!task.completed).length} open)</h3><button onClick={()=>setAdding(value=>!value)}><Plus size={14}/> Add task</button></div>{adding&&<form className="task-form" onSubmit={submit}><label>Task<input required maxLength="240" value={title} onChange={e=>setTitle(e.target.value)} placeholder="e.g. Call the project manager"/></label><label>Assign to<input type="email" value={assigned} onChange={e=>setAssigned(e.target.value)} placeholder="name@gsdecorating.com"/></label><label>Due date<input type="date" value={due} onChange={e=>setDue(e.target.value)}/></label><div><button type="button" onClick={()=>setAdding(false)}>Cancel</button><button type="submit">Create task</button></div></form>}{tasks.length===0?<p className="task-empty">No tasks for this project yet.</p>:tasks.map(task=><TaskRow key={task.id} task={task} toggleTask={toggleTask} deleteTask={deleteTask}/>)}</section>;
}

function OAuthConsent({session}){
  const authorizationId=new URLSearchParams(location.search).get('authorization_id');
  const [details,setDetails]=useState(null), [error,setError]=useState(''), [working,setWorking]=useState(false);
  useEffect(()=>{
    if(!authorizationId){setError('This authorization request is missing its ID.');return}
    supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({data,error:detailsError})=>{
      if(detailsError||!data){setError(detailsError?.message||'This authorization request is invalid or has expired.');return}
      if(!('authorization_id' in data)&&data.redirect_url){location.assign(data.redirect_url);return}
      setDetails(data);
    });
  },[authorizationId]);
  const decide=async decision=>{
    setWorking(true);setError('');
    const action=decision==='approve'
      ? supabase.auth.oauth.approveAuthorization(authorizationId,{skipBrowserRedirect:true})
      : supabase.auth.oauth.denyAuthorization(authorizationId,{skipBrowserRedirect:true});
    const {data,error:decisionError}=await action;
    if(decisionError||!data?.redirect_url){setError(decisionError?.message||'Unable to complete authorization.');setWorking(false);return}
    location.assign(data.redirect_url);
  };
  return <div className="auth-page"><section className="auth-card consent-card"><div className="auth-brand"><Building2/><b>GSD</b> SiteFinder</div><h1>Connect SiteFinder</h1>{error?<output>{error}</output>:!details?<p>Checking the connection request…</p>:<><p><b>{details.client?.name||'An external application'}</b> is requesting read-only access to SiteFinder for <b>{session.user.email}</b>.</p><dl><dt>Requested access</dt><dd>{details.scope?.split(' ').filter(Boolean).join(', ')||'Email identity'}</dd><dt>SiteFinder tools</dt><dd>Search projects, view CCS details, contractors, locations and service status</dd></dl><div className="consent-actions"><button type="button" className="secondary" disabled={working} onClick={()=>decide('deny')}>Deny</button><button type="button" disabled={working} onClick={()=>decide('approve')}>{working?'Connecting…':'Approve connection'}</button></div></>}</section></div>;
}

function projectDescription(detail,selected){
  if(detail.Summary||detail.ContractorText)return detail.Summary||detail.ContractorText;
  const contractor=value(detail.MainContractor||selected.MainContractor,'the published main contractor');
  const client=value(detail.Client||selected.Client,'the published client');
  const address=value(detail.Address||selected.LaId,'the registered CCS location');
  const period=detail.SiteStartDate||detail.SiteEndDate?` The registered project period is ${fmtDate(detail.SiteStartDate)} to ${fmtDate(detail.SiteEndDate)}.`:'';
  return `${selected.Name} is an active CCS-registered construction project at ${address}, being delivered by ${contractor} for ${client}.${period} CCS has not published a more detailed scope of works for this registration.`;
}

function ProjectDrawer({className='',selected,detail,close,saved,toggleSave,note,addNote,meta,attioLink,enrichment={},tracking={},updateTracking,tasks,createTask,toggleTask,deleteTask,outreachLead,queueOutreach,communications,logCommunication}){
  const label=value=>String(value||'unknown').split('_').map(word=>word[0].toUpperCase()+word.slice(1)).join(' ');
  const mapUrl=enrichment.map_url||(selected.Latitude&&selected.Longitude?`https://www.google.com/maps/search/?api=1&query=${selected.Latitude},${selected.Longitude}`:null);
  const detailContactName=[detail?.SiteManagerFirstName,detail?.SiteManagerLastName].filter(Boolean).join(' ');
  const contactName=detailContactName||meta?.site_manager_name||'Not published';
  const contactRole=detail?.SiteManagerJobTitle||meta?.site_manager_job_title||'Site contact';
  const contactPhone=detail?.SiteManagerPhone||meta?.site_manager_phone;
  const contactEmail=detail?.MarkerEmail||meta?.marker_email;
  const address=detail?.Address||meta?.address||selected.LaId;
  const postcode=postcodeFromAddress(address);
  const completeness=projectCompleteness(selected,meta,enrichment);
  const attioRefreshFailed=attioLink?.sync_status==='error';
  return <div className={`drawer ${className}`} role="dialog" aria-label={`${selected.Name} project details`}>
    <div className="drawer-head"><div><h2>{selected.Name}</h2><p>CCS {selected.Id.replace('site','')}{meta&&` · First seen ${fmtDate(meta.first_seen_at)}`}</p></div><button className="icon" onClick={close} aria-label="Close project details"><X/></button></div>
    <div className="drawer-actions">
      <button onClick={toggleSave}><Star size={16} fill={saved?'currentColor':'none'}/>{saved?'Saved':'Save lead'}</button>
      <button onClick={addNote}><StickyNote size={16}/>{note?'Edit note':'Add note'}</button>
      <button onClick={queueOutreach}><Megaphone size={16}/>{outreachLead?'Open outreach':'Add to outreach'}</button>
      {attioLink?.attio_web_url&&<a className={`attio-action${attioRefreshFailed?' refresh-failed':''}`} href={attioLink.attio_web_url} target="_blank" rel="noreferrer"><ExternalLink size={16}/>{attioRefreshFailed?'Open last linked Attio record':'Open in Attio'}</a>}
    </div>
    <section className="lead-workflow"><h3>Lead workflow</h3><label>Stage<select value={tracking.stage||'new'} onChange={e=>updateTracking({stage:e.target.value})}>{STAGES.map(stage=><option key={stage} value={stage}>{stage[0].toUpperCase()+stage.slice(1)}</option>)}</select></label><label>Next action<input key={tracking.next_action||''} defaultValue={tracking.next_action||''} placeholder="e.g. Call the site manager" onBlur={e=>updateTracking({next_action:e.target.value})}/></label><label>Follow-up date<input type="date" value={tracking.next_action_at?.slice(0,10)||''} onChange={e=>updateTracking({next_action_at:e.target.value?new Date(`${e.target.value}T09:00:00`).toISOString():null})}/></label></section>
    <ProjectTaskList tasks={tasks} createTask={createTask} toggleTask={toggleTask} deleteTask={deleteTask}/>
    <section><div className="section-title"><h3>Communication history</h3></div><CommunicationTimeline communications={communications}/><div className="communication-actions"><button onClick={()=>logCommunication('phone')}><Phone size={15}/> Log call</button><button onClick={()=>logCommunication('note')}><StickyNote size={15}/> Add note</button></div></section>
    {!detail?<div className="drawer-loading">Loading verified project record…</div>:<>
      <section><h3>Project description</h3><p>{projectDescription(detail,selected)}</p></section>
      <section><h3>CCS site contact</h3><h4>{contactName}</h4><p>{contactRole}</p>{contactPhone&&<a href={`tel:${contactPhone}`}><Phone size={15}/>{contactPhone}</a>}{contactEmail&&<a href={`mailto:${contactEmail}`}><Mail size={15}/>{contactEmail}</a>}<small className="native-source">Published by CCS and held in SiteFinder</small></section>
      <section className="facts"><h3>Project intelligence</h3><dl>
        <dt>GSD Timing</dt><dd>{label(enrichment.gsd_timing)}</dd>
        <dt>Programme</dt><dd>{label(enrichment.programme_stage)}</dd>
        <dt>Months Remaining</dt><dd>{enrichment.months_remaining??'Unknown'}</dd>
        <dt>Fit Out</dt><dd>{label(enrichment.fit_out_state)}</dd>
        <dt>New Build Housing</dt><dd>{label(enrichment.new_build_housing_state)}</dd>
        <dt>Sector</dt><dd>{enrichment.sector||'Unknown'}</dd>
        <dt>Work Type</dt><dd>{enrichment.work_type||'Unknown'}</dd>
        <dt>CCS Rating</dt><dd>{enrichment.ccs_rating||'Not published'}</dd>
        <dt>Complaints</dt><dd>{enrichment.complaints_count??'Not published'}</dd>
        <dt>Registrations</dt><dd>{enrichment.registration_count??'Not published'}</dd>
        <dt>Data Coverage</dt><dd>{completeness}%</dd>
      </dl>{enrichment.classification_evidence?.length>0&&<p className="classification-evidence">{enrichment.classification_evidence.join(' · ')}</p>}</section>
      <section className="facts"><h3>Project details</h3><dl><dt>Main Contractor</dt><dd>{value(detail.MainContractor||selected.MainContractor)}</dd><dt>Client</dt><dd>{value(detail.Client||selected.Client)}</dd><dt>Project Period</dt><dd><CalendarDays size={14}/>{fmtDate(detail.SiteStartDate||meta?.site_start_date)} – {fmtDate(detail.SiteEndDate||meta?.site_end_date)}</dd><dt>Address</dt><dd>{value(address)}</dd><dt>Postcode</dt><dd>{postcode||'Not published'}</dd><dt>Local Authority</dt><dd>{value(detail.LocalAuthority||selected.LaId)}</dd><dt>Last CCS Visit</dt><dd>{fmtDate(detail.LastVisitDate||meta?.last_visit_date)}</dd><dt>Last Detail Check</dt><dd>{meta?.detail_last_checked_at?new Date(meta.detail_last_checked_at).toLocaleString('en-GB'):'Not published'}</dd></dl></section>
      <section className="record-links"><h3>Connected records</h3>{attioLink?.attio_web_url?<><a className="source" href={attioLink.attio_web_url} target="_blank" rel="noreferrer">Open linked Attio Project <ExternalLink size={15}/></a>{attioRefreshFailed&&<small className="attio-refresh-error">Latest refresh failed. This opens the last successfully linked record.</small>}<small>Last successfully linked {attioLink.synced_at?new Date(attioLink.synced_at).toLocaleString('en-GB'):'date not published'}</small></>:<p>Attio project link pending.</p>}{mapUrl&&<a className="source" href={mapUrl} target="_blank" rel="noreferrer">Open project map <MapPin size={15}/></a>}<a className="source" href={detail.SourceUrl} target="_blank" rel="noreferrer">Open verified CCS source record <ExternalLink size={15}/></a></section>
    </>}
  </div>
}

createRoot(document.getElementById('root')).render(<AuthGate>{props=>location.pathname==='/oauth/consent'?<OAuthConsent {...props}/>:<App {...props}/>}</AuthGate>);
