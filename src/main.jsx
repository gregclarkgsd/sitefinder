import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Search, MapPin, Star, StickyNote, ExternalLink, X, RefreshCw, Building2, SlidersHorizontal, List, Phone, Mail, CalendarDays, Bookmark, BarChart3, Users, FolderKanban, ChevronLeft, ChevronRight } from 'lucide-react';
import './styles.css';
import './mobile.css';
import AuthGate from './AuthGate';
import { supabase } from './supabase';

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
const unique = (items, key) => [...new Set(items.map(item => item[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
const navItems = [
  {id:'projects',label:'Projects',icon:FolderKanban},
  {id:'saved',label:'Saved',icon:Bookmark},
  {id:'insights',label:'Insights',icon:BarChart3},
  {id:'contractors',label:'Contractors',icon:Users},
];

function SelectFilter({label,value,onChange,options,allLabel}) {
  return <label className="filter"><span>{label}</span><select value={value} onChange={e=>onChange(e.target.value)}><option value="">{allLabel}</option>{options.map(option=><option key={option} value={option}>{option}</option>)}</select></label>;
}

function App({session,cloudEnabled}){
  const [projects,setProjects]=useState([]), [query,setQuery]=useState(''), [selected,setSelected]=useState(null), [detail,setDetail]=useState(null);
  const [loading,setLoading]=useState(true), [error,setError]=useState(''), [activeView,setActiveView]=useState('projects'), [page,setPage]=useState(1);
  const [saved,setSaved]=useState(()=>new Set(JSON.parse(localStorage.getItem('gsd-saved')||'[]'))), [notes,setNotes]=useState(()=>JSON.parse(localStorage.getItem('gsd-notes')||'{}'));
  const [history,setHistory]=useState({}), [syncStatus,setSyncStatus]=useState(null), [tracking,setTracking]=useState({});
  const [draftFilters,setDraftFilters]=useState({location:'',contractor:'',client:'',recency:'',liveOnly:true}), [filters,setFilters]=useState({location:'',contractor:'',client:'',recency:'',liveOnly:true});

  const load=()=>{setLoading(true);setError('');fetch(`${API}/projects`).then(async r=>{if(!r.ok) throw new Error((await r.json()).error||'Unable to load CCS projects');return r.json()}).then(d=>setProjects(d.projects||fallback)).catch(err=>{setProjects(fallback);setError(`${err.message}. Showing cached examples.`)}).finally(()=>setLoading(false))};
  useEffect(load,[]);
  useEffect(()=>{ if(!cloudEnabled) return; Promise.all([
    supabase.from('saved_projects').select('project_id'),
    supabase.from('project_notes').select('project_id,note'),
    supabase.from('ccs_projects').select('project_id,first_seen_at,last_seen_at,last_changed_at,discovered_after_baseline,is_active'),
    supabase.from('ccs_sync_runs').select('completed_at,total_projects,new_projects,changed_projects,status').eq('status','completed').order('completed_at',{ascending:false}).limit(1).maybeSingle(),
    supabase.from('lead_tracking').select('project_id,stage,assigned_email,next_action,next_action_at,updated_at')
  ]).then(([s,n,h,sync,t])=>{if(s.data)setSaved(new Set(s.data.map(x=>x.project_id)));if(n.data)setNotes(Object.fromEntries(n.data.map(x=>[x.project_id,x.note])));if(h.data)setHistory(Object.fromEntries(h.data.map(x=>[x.project_id,x])));if(sync.data)setSyncStatus(sync.data);if(t.data)setTracking(Object.fromEntries(t.data.map(x=>[x.project_id,x])))}) },[cloudEnabled]);
  useEffect(()=>setPage(1),[query,filters,activeView]);

  const options=useMemo(()=>({locations:unique(projects,'LaId'),contractors:unique(projects,'MainContractor'),clients:unique(projects,'Client')}),[projects]);
  const filtered=useMemo(()=>projects.filter(p=>{
    const search=[p.Name,p.MainContractor,p.Client,p.LaId,p.Id].join(' ').toLowerCase();
    const meta=history[p.Id], age=meta?Date.now()-new Date(meta.first_seen_at).getTime():Infinity, changedAge=meta?Date.now()-new Date(meta.last_changed_at).getTime():Infinity;
    return (!query.trim()||search.includes(query.trim().toLowerCase()))
      && (!filters.location||p.LaId===filters.location)
      && (!filters.contractor||p.MainContractor===filters.contractor)
      && (!filters.client||p.Client===filters.client)
      && (!filters.recency||(filters.recency==='new'&&meta?.discovered_after_baseline&&age<=NEW_DAYS*86400000)||(filters.recency==='updated'&&changedAge<=NEW_DAYS*86400000&&new Date(meta.last_changed_at).getTime()>new Date(meta.first_seen_at).getTime()+1000))
      && (!filters.liveOnly||p.TypeOfSite==='CCS'||!p.TypeOfSite);
  }),[projects,query,filters,history]);
  const visibleProjects=activeView==='saved'?filtered.filter(p=>saved.has(p.Id)):filtered;
  const totalPages=Math.max(1,Math.ceil(visibleProjects.length/PAGE_SIZE));
  const shown=visibleProjects.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);
  const contractorStats=useMemo(()=>Object.values(projects.reduce((acc,p)=>{const name=value(p.MainContractor,'Unknown contractor');if(!acc[name])acc[name]={name,count:0,locations:new Set(),saved:0};acc[name].count++;if(p.LaId)acc[name].locations.add(p.LaId);if(saved.has(p.Id))acc[name].saved++;return acc},{})).sort((a,b)=>b.count-a.count),[projects,saved]);

  const open=async p=>{setSelected(p);setDetail(null);try{const r=await fetch(`${API}/projects/${p.Id}`);if(!r.ok)throw new Error('Detail unavailable');setDetail(await r.json())}catch{setDetail({...p,Address:p.LaId,SourceUrl:`https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/${p.Id.replace('site','')}/null`})}};
  const toggleSave=async p=>{const wasSaved=saved.has(p.Id),next=new Set(saved);wasSaved?next.delete(p.Id):next.add(p.Id);setSaved(next);localStorage.setItem('gsd-saved',JSON.stringify([...next]));if(cloudEnabled){const result=wasSaved?await supabase.from('saved_projects').delete().eq('project_id',p.Id):await supabase.from('saved_projects').upsert({project_id:p.Id,project_name:p.Name,saved_by:session.user.id});if(result.error){setSaved(saved);setError(`Could not update saved projects: ${result.error.message}`)}}};
  const addNote=async p=>{const note=window.prompt('Shared project note',notes[p.Id]||'');if(note===null)return;const next={...notes};note.trim()?next[p.Id]=note.trim():delete next[p.Id];setNotes(next);localStorage.setItem('gsd-notes',JSON.stringify(next));if(cloudEnabled){const result=note.trim()?await supabase.from('project_notes').upsert({project_id:p.Id,project_name:p.Name,note:note.trim(),updated_by:session.user.id,updated_at:new Date().toISOString()}):await supabase.from('project_notes').delete().eq('project_id',p.Id);if(result.error)setError(`Could not update note: ${result.error.message}`)}};
  const updateTracking=async(p,changes)=>{const next={...(tracking[p.Id]||{}),project_id:p.Id,...changes,updated_at:new Date().toISOString()};setTracking(x=>({...x,[p.Id]:next}));if(cloudEnabled){const {error:trackingError}=await supabase.from('lead_tracking').upsert({...next,updated_by:session.user.id});if(trackingError){setError(`Could not update lead: ${trackingError.message}`);return false}}return true};
  const clearFilters=()=>{const empty={location:'',contractor:'',client:'',recency:'',liveOnly:true};setDraftFilters(empty);setFilters(empty);setQuery('')};
  const goToView=id=>{setActiveView(id);setSelected(null)};

  return <div className="app">
    <header><div className="brand"><Building2/><b>GSD</b> SiteFinder</div><nav aria-label="Primary navigation">{navItems.map(({id,label,icon:Icon})=><button key={id} className={activeView===id?'active':''} onClick={()=>goToView(id)}><Icon size={16}/>{label}{id==='saved'&&saved.size>0&&<span>{saved.size}</span>}</button>)}</nav><button className="user" onClick={()=>cloudEnabled&&supabase.auth.signOut()} title={cloudEnabled?'Sign out':'Local preview'}>{session?.user?.email?.slice(0,2).toUpperCase()||'GC'}</button></header>
    {(activeView==='projects'||activeView==='saved')&&<aside><div className="aside-title"><b>Filters</b><button onClick={clearFilters}>Clear all</button></div>
      <SelectFilter label="Location" value={draftFilters.location} onChange={location=>setDraftFilters(x=>({...x,location}))} options={options.locations} allLabel="All locations"/>
      <SelectFilter label="Lead activity" value={draftFilters.recency} onChange={recency=>setDraftFilters(x=>({...x,recency}))} options={['new','updated']} allLabel="All project activity"/>
      <label className="switch-row"><span>Live Sites Only</span><input type="checkbox" checked={draftFilters.liveOnly} onChange={e=>setDraftFilters(x=>({...x,liveOnly:e.target.checked}))}/><i/></label>
      <SelectFilter label="Contractor" value={draftFilters.contractor} onChange={contractor=>setDraftFilters(x=>({...x,contractor}))} options={options.contractors} allLabel="All contractors"/>
      <SelectFilter label="Client" value={draftFilters.client} onChange={client=>setDraftFilters(x=>({...x,client}))} options={options.clients} allLabel="All clients"/>
      <button className="apply" onClick={()=>setFilters({...draftFilters})}><SlidersHorizontal size={16}/> Apply filters</button>
    </aside>}
    <main className={(activeView==='insights'||activeView==='contractors')?'wide':''}>
      {(activeView==='projects'||activeView==='saved')&&<><section className="toolbar"><div><strong>{visibleProjects.length.toLocaleString()} {activeView==='saved'?'saved':'active'} projects</strong><button className="icon" onClick={load} aria-label="Refresh projects"><RefreshCw size={16}/></button></div><label className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects, contractors, clients, locations…" aria-label="Search projects"/></label><button className="filter-mobile" onClick={()=>document.querySelector('aside')?.classList.toggle('open')}><SlidersHorizontal size={17}/> Filters</button></section>
        {error&&<div className="notice" role="alert">{error}<button onClick={()=>setError('')}><X size={15}/></button></div>}
        <ProjectTable loading={loading} projects={shown} selected={selected} saved={saved} notes={notes} history={history} tracking={tracking} open={open} toggleSave={toggleSave} addNote={addNote}/>
        <footer><div><span>Showing {shown.length?((page-1)*PAGE_SIZE)+1:0}–{Math.min(page*PAGE_SIZE,visibleProjects.length)} of {visibleProjects.length.toLocaleString()}</span>{syncStatus&&<small className="sync-status">CCS synced {new Date(syncStatus.completed_at).toLocaleString('en-GB')} · {syncStatus.new_projects} new · {syncStatus.changed_projects} updated</small>}</div><div className="pagination"><button disabled={page===1} onClick={()=>setPage(x=>x-1)} aria-label="Previous page"><ChevronLeft size={16}/></button><b>Page {page} of {totalPages}</b><button disabled={page===totalPages} onClick={()=>setPage(x=>x+1)} aria-label="Next page"><ChevronRight size={16}/></button></div></footer>
      </>}
      {activeView==='insights'&&<Insights projects={projects} saved={saved} contractorStats={contractorStats}/>}
      {activeView==='contractors'&&<Contractors stats={contractorStats} onSelect={name=>{setDraftFilters(x=>({...x,contractor:name}));setFilters(x=>({...x,contractor:name}));goToView('projects')}}/>}
    </main>
    {selected&&<ProjectDrawer selected={selected} detail={detail} close={()=>setSelected(null)} saved={saved.has(selected.Id)} toggleSave={()=>toggleSave(selected)} note={notes[selected.Id]} addNote={()=>addNote(selected)} meta={history[selected.Id]} tracking={tracking[selected.Id]} updateTracking={changes=>updateTracking(selected,changes)}/>}
  </div>
}

function ProjectTable({loading,projects,selected,saved,notes,history,tracking,open,toggleSave,addNote}){
  return <div className="table-wrap"><table><thead><tr><th>Project</th><th>Contractor</th><th>Location</th><th>Client</th><th>Contact</th><th>Saved</th><th>Notes</th></tr></thead><tbody>{loading?<tr><td colSpan="7" className="empty">Loading the live CCS feed…</td></tr>:projects.length===0?<tr><td colSpan="7" className="empty"><Search size={24}/><b>No projects found</b><span>Try changing your search or filters.</span></td></tr>:projects.map(p=>{const meta=history[p.Id],isNew=meta?.discovered_after_baseline&&Date.now()-new Date(meta.first_seen_at).getTime()<=NEW_DAYS*86400000,isUpdated=meta&&Date.now()-new Date(meta.last_changed_at).getTime()<=NEW_DAYS*86400000&&new Date(meta.last_changed_at).getTime()>new Date(meta.first_seen_at).getTime()+1000&&!isNew;return <tr key={p.Id} className={selected?.Id===p.Id?'selected':''}><td><div className="project-line"><button className="project" onClick={()=>open(p)}>{p.Name}</button>{isNew&&<span className="badge new">New</span>}{isUpdated&&<span className="badge updated">Updated</span>}{tracking[p.Id]?.stage&&tracking[p.Id].stage!=='new'&&<span className={`badge stage-${tracking[p.Id].stage}`}>{tracking[p.Id].stage}</span>}</div><small>CCS {p.Id.replace('site','')}</small></td><td>{value(p.MainContractor)}</td><td><MapPin size={14}/>{value(p.LaId)}</td><td>{value(p.Client)}</td><td><button className="reveal" onClick={()=>open(p)}>View</button></td><td><button className={'row-icon '+(saved.has(p.Id)?'saved':'')} onClick={()=>toggleSave(p)} aria-label={`${saved.has(p.Id)?'Remove':'Save'} ${p.Name}`}><Star size={18} fill={saved.has(p.Id)?'currentColor':'none'}/></button></td><td><button className="row-icon" onClick={()=>addNote(p)} aria-label={`Note for ${p.Name}`}><StickyNote size={18}/>{notes[p.Id]&&<em/>}</button></td></tr>})}</tbody></table></div>
}

function Insights({projects,saved,contractorStats}){
  const locations=useMemo(()=>Object.entries(projects.reduce((acc,p)=>{const k=value(p.LaId,'Unknown');acc[k]=(acc[k]||0)+1;return acc},{})).sort((a,b)=>b[1]-a[1]).slice(0,8),[projects]);
  const max=Math.max(...locations.map(x=>x[1]),1);
  return <section className="dashboard"><div className="page-heading"><div><span>Portfolio overview</span><h1>Project insights</h1><p>Live summary of the CCS projects in your target region.</p></div></div><div className="stats"><article><span>Active projects</span><strong>{projects.length}</strong></article><article><span>Saved leads</span><strong>{saved.size}</strong></article><article><span>Contractors</span><strong>{contractorStats.length}</strong></article><article><span>Locations</span><strong>{locations.length}</strong></article></div><div className="insight-grid"><article className="panel"><h2>Top project locations</h2>{locations.map(([name,count])=><div className="bar-row" key={name}><div><span>{name}</span><b>{count}</b></div><i><em style={{width:`${count/max*100}%`}}/></i></div>)}</article><article className="panel"><h2>Leading contractors</h2>{contractorStats.slice(0,8).map((item,index)=><div className="rank" key={item.name}><span>{index+1}</span><div><b>{item.name}</b><small>{item.locations.size} locations</small></div><strong>{item.count}</strong></div>)}</article></div></section>;
}

function Contractors({stats,onSelect}){return <section className="dashboard"><div className="page-heading"><div><span>Directory</span><h1>Contractors</h1><p>Companies delivering active CCS projects in London and the Home Counties.</p></div></div><div className="contractor-grid">{stats.map(item=><button className="contractor-card" key={item.name} onClick={()=>onSelect(item.name)}><div className="contractor-icon"><Building2/></div><div><h2>{item.name}</h2><p>{item.count} active project{item.count===1?'':'s'} · {item.locations.size} location{item.locations.size===1?'':'s'}</p></div><ChevronRight/></button>)}</div></section>}

function ProjectDrawer({selected,detail,close,saved,toggleSave,note,addNote,meta,tracking={},updateTracking}){return <div className="drawer" role="dialog" aria-label={`${selected.Name} project details`}><div className="drawer-head"><div><h2>{selected.Name}</h2><p>CCS {selected.Id.replace('site','')}{meta&&` · First seen ${fmtDate(meta.first_seen_at)}`}</p></div><button className="icon" onClick={close} aria-label="Close project details"><X/></button></div><div className="drawer-actions"><button onClick={toggleSave}><Star size={16} fill={saved?'currentColor':'none'}/>{saved?'Saved':'Save lead'}</button><button onClick={addNote}><StickyNote size={16}/>{note?'Edit note':'Add note'}</button></div><section className="lead-workflow"><h3>Lead workflow</h3><label>Stage<select value={tracking.stage||'new'} onChange={e=>updateTracking({stage:e.target.value})}>{STAGES.map(stage=><option key={stage} value={stage}>{stage[0].toUpperCase()+stage.slice(1)}</option>)}</select></label><label>Next action<input key={tracking.next_action||''} defaultValue={tracking.next_action||''} placeholder="e.g. Call the site manager" onBlur={e=>updateTracking({next_action:e.target.value})}/></label><label>Follow-up date<input type="date" value={tracking.next_action_at?.slice(0,10)||''} onChange={e=>updateTracking({next_action_at:e.target.value?new Date(`${e.target.value}T09:00:00`).toISOString():null})}/></label></section>{!detail?<div className="drawer-loading">Loading verified project record…</div>:<><section><h3>Project Overview</h3><p>{detail.Summary||detail.ContractorText||'Live construction project registered with the Considerate Constructors Scheme.'}</p></section><section><h3>Contact</h3><h4>{[detail.SiteManagerFirstName,detail.SiteManagerLastName].filter(Boolean).join(' ')||'Not published'}</h4><p>{detail.SiteManagerJobTitle||'Site contact'}</p>{detail.SiteManagerPhone&&<a href={`tel:${detail.SiteManagerPhone}`}><Phone size={15}/>{detail.SiteManagerPhone}</a>}{detail.MarkerEmail&&<a href={`mailto:${detail.MarkerEmail}`}><Mail size={15}/>{detail.MarkerEmail}</a>}</section><section className="facts"><h3>Project details</h3><dl><dt>Main Contractor</dt><dd>{value(detail.MainContractor||selected.MainContractor)}</dd><dt>Client</dt><dd>{value(detail.Client||selected.Client)}</dd><dt>Project Period</dt><dd><CalendarDays size={14}/>{fmtDate(detail.SiteStartDate)} – {fmtDate(detail.SiteEndDate)}</dd><dt>Address</dt><dd>{value(detail.Address||selected.LaId)}</dd><dt>Local Authority</dt><dd>{value(detail.LocalAuthority||selected.LaId)}</dd></dl></section><section><a className="source" href={detail.SourceUrl} target="_blank" rel="noreferrer">Open verified CCS source record <ExternalLink size={15}/></a></section></>}</div>}

createRoot(document.getElementById('root')).render(<AuthGate>{props=><App {...props}/>}</AuthGate>);
