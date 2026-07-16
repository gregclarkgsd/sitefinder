import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Search, MapPin, Star, StickyNote, ExternalLink, X, RefreshCw, Building2, ChevronDown, SlidersHorizontal, List, Map, Phone, Mail, CalendarDays } from 'lucide-react';
import './styles.css';
import './mobile.css';
import AuthGate from './AuthGate';
import { supabase } from './supabase';

const API = '/api';
const fallback = [
  {Id:'site520666',Name:'Ladywell Park Gardens',MainContractor:'Higgins Partnerships',Client:'Louise Hunt',LaId:'London Borough of Lewisham',Latitude:51.4567,Longitude:-0.0132},
  {Id:'site518253',Name:'22 Hill Street',MainContractor:'Overbury plc',Client:'Berkeley Estate Asset Management',LaId:'Westminster City Council',Latitude:51.5088,Longitude:-0.1486},
  {Id:'site517241',Name:'Allen & Overy Shearman',MainContractor:'Overbury plc',Client:'Allen & Overy Shearman',LaId:'City of London',Latitude:51.5188,Longitude:-0.0843},
  {Id:'site116717',Name:'CitiBank',MainContractor:'Overbury plc',Client:'Citibank',LaId:'London Borough of Tower Hamlets',Latitude:51.5042,Longitude:-0.0177},
];
const fmtDate = d => d ? new Intl.DateTimeFormat('en-GB').format(new Date(d)) : 'Not published';

function Filter({label, children}) { return <label className="filter"><span>{label}</span><div className="filter-control">{children}<ChevronDown size={15}/></div></label> }

function App({session,cloudEnabled}){
  const [projects,setProjects]=useState([]), [query,setQuery]=useState(''), [selected,setSelected]=useState(null), [detail,setDetail]=useState(null);
  const [loading,setLoading]=useState(true), [saved,setSaved]=useState(()=>new Set(JSON.parse(localStorage.getItem('gsd-saved')||'[]'))), [notes,setNotes]=useState(()=>JSON.parse(localStorage.getItem('gsd-notes')||'{}'));
  const load=()=>{setLoading(true);fetch(`${API}/projects`).then(r=>r.json()).then(d=>setProjects(d.projects||fallback)).catch(()=>setProjects(fallback)).finally(()=>setLoading(false))};
  useEffect(load,[]);
  useEffect(()=>{ if(!cloudEnabled) return; Promise.all([
    supabase.from('saved_projects').select('project_id'),
    supabase.from('project_notes').select('project_id,note')
  ]).then(([s,n])=>{if(s.data)setSaved(new Set(s.data.map(x=>x.project_id)));if(n.data)setNotes(Object.fromEntries(n.data.map(x=>[x.project_id,x.note])))}) },[cloudEnabled]);
  const shown=useMemo(()=>projects.filter(p=>[p.Name,p.MainContractor,p.Client,p.LaId].join(' ').toLowerCase().includes(query.toLowerCase())).slice(0,40),[projects,query]);
  const open=async p=>{setSelected(p);setDetail(null);try{const r=await fetch(`${API}/projects/${p.Id}`);setDetail(await r.json())}catch{setDetail({...p,Address:p.LaId,SourceUrl:`https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/${p.Id.replace('site','')}/null`})}};
  const toggleSave=async p=>{const wasSaved=saved.has(p.Id),next=new Set(saved);wasSaved?next.delete(p.Id):next.add(p.Id);setSaved(next);if(cloudEnabled){if(wasSaved)await supabase.from('saved_projects').delete().eq('project_id',p.Id);else await supabase.from('saved_projects').upsert({project_id:p.Id,project_name:p.Name,saved_by:session.user.id})}else localStorage.setItem('gsd-saved',JSON.stringify([...next]))};
  const addNote=async p=>{const value=prompt('Shared project note',notes[p.Id]||'');if(value!==null){const next={...notes,[p.Id]:value};setNotes(next);if(cloudEnabled){if(value.trim())await supabase.from('project_notes').upsert({project_id:p.Id,project_name:p.Name,note:value.trim(),updated_by:session.user.id,updated_at:new Date().toISOString()});else await supabase.from('project_notes').delete().eq('project_id',p.Id)}else localStorage.setItem('gsd-notes',JSON.stringify(next))}};
  return <div className="app">
    <header><div className="brand"><Building2/><b>GSD</b> SiteFinder</div><nav><a className="active">Projects</a><a>Saved</a><a>Insights</a><a>Contractors</a></nav><button className="user" onClick={()=>cloudEnabled&&supabase.auth.signOut()} title={cloudEnabled?'Sign out':'Local preview'}>{session?.user?.email?.slice(0,2).toUpperCase()||'GC'}</button></header>
    <aside><div className="aside-title"><b>Filters</b><button>Clear all</button></div>
      <Filter label="Region"><span>London & Home Counties</span></Filter><Filter label="Location"><span>All locations</span></Filter><Filter label="Start & End Date"><span>Any date</span></Filter>
      <label className="switch-row"><span>Live Sites Only</span><input type="checkbox" defaultChecked/><i/></label>
      <Filter label="Sectors"><span>All sectors</span></Filter><Filter label="Contract Value"><span>Any value</span></Filter><Filter label="Contractor"><span>All contractors</span></Filter><Filter label="Local Authority"><span>All authorities</span></Filter><Filter label="Client"><span>All clients</span></Filter>
      <button className="apply"><SlidersHorizontal size={16}/> Apply filters</button><button className="save-search"><Star size={16}/> Save search</button>
    </aside>
    <main><section className="toolbar"><div><strong>{projects.length.toLocaleString()} active projects</strong><button className="icon" onClick={load} aria-label="Refresh"><RefreshCw size={16}/></button></div><div className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects, contractors, clients, locations…"/></div><button className="view"><List size={17}/> List</button><button className="view"><Map size={17}/> Map</button></section>
      <div className="table-wrap"><table><thead><tr><th>Project</th><th>Contractor</th><th>Location</th><th>Client</th><th>Contact</th><th>Saved</th><th>Notes</th></tr></thead><tbody>{loading?<tr><td colSpan="7" className="empty">Loading the live CCS feed…</td></tr>:shown.map(p=><tr key={p.Id} className={selected?.Id===p.Id?'selected':''}><td><button className="project" onClick={()=>open(p)}>{p.Name}</button><small>CCS {p.Id.replace('site','')}</small></td><td>{p.MainContractor||'Not published'}</td><td><MapPin size={14}/>{p.LaId||'Not published'}</td><td>{p.Client||'Not published'}</td><td><button className="reveal" onClick={()=>open(p)}>View</button></td><td><button className={'row-icon '+(saved.has(p.Id)?'saved':'')} onClick={()=>toggleSave(p)} aria-label="Save"><Star size={18} fill={saved.has(p.Id)?'currentColor':'none'}/></button></td><td><button className="row-icon" onClick={()=>addNote(p)} aria-label="Note"><StickyNote size={18}/>{notes[p.Id]&&<em/>}</button></td></tr>)}</tbody></table></div>
      <footer>Showing {shown.length} of {projects.length.toLocaleString()} matching CCS sites <span>Public source: Considerate Constructors Scheme</span></footer>
    </main>
    {selected&&<div className="drawer"><div className="drawer-head"><div><h2>{selected.Name}</h2><p>CCS {selected.Id.replace('site','')}</p></div><button className="icon" onClick={()=>setSelected(null)}><X/></button></div>{!detail?<div className="drawer-loading">Loading verified project record…</div>:<>
      <section><h3>Project Overview</h3><p>{detail.Summary||detail.ContractorText||'Live construction project registered with the Considerate Constructors Scheme.'}</p></section>
      <section><h3>Contact</h3><h4>{[detail.SiteManagerFirstName,detail.SiteManagerLastName].filter(Boolean).join(' ')||'Not published'}</h4><p>{detail.SiteManagerJobTitle||'Site contact'}</p>{detail.SiteManagerPhone&&<a href={`tel:${detail.SiteManagerPhone}`}><Phone size={15}/>{detail.SiteManagerPhone}</a>}{detail.MarkerEmail&&<a href={`mailto:${detail.MarkerEmail}`}><Mail size={15}/>{detail.MarkerEmail}</a>}</section>
      <section className="facts"><h3>Project details</h3><dl><dt>Main Contractor</dt><dd>{detail.MainContractor||selected.MainContractor||'Not published'}</dd><dt>Client</dt><dd>{detail.Client||selected.Client||'Not published'}</dd><dt>Project Period</dt><dd><CalendarDays size={14}/>{fmtDate(detail.SiteStartDate)} – {fmtDate(detail.SiteEndDate)}</dd><dt>Address</dt><dd>{detail.Address||selected.LaId}</dd><dt>Local Authority</dt><dd>{detail.LocalAuthority||selected.LaId}</dd></dl></section>
      <section><a className="source" href={detail.SourceUrl} target="_blank" rel="noreferrer">Open verified CCS source record <ExternalLink size={15}/></a></section></>}</div>}
  </div>
}
createRoot(document.getElementById('root')).render(<AuthGate>{props=><App {...props}/>}</AuthGate>);
