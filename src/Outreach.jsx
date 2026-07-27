import React, { useMemo, useState } from 'react';
import { Check, CheckCircle2, Clock3, Mail, MessageSquareText, Phone, Send, ShieldX, SkipForward, X } from 'lucide-react';
import './outreach.css';

const formatDate = value => value
  ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Not yet';

const statusLabel = status => ({
  queued: 'Ready for review',
  reviewing: 'Draft in progress',
  approved: 'Approved',
  sent: 'Sent',
  skipped: 'Skipped',
  replied: 'Replied',
  bounced: 'Bounced',
  failed: 'Failed',
  suppressed: 'Do not contact',
}[status] || status);

export function OutreachPage({ leads, communications, suppressions, updateLead, syncToAttio }) {
  const [view,setView] = useState('review');
  const [selectedIds,setSelectedIds] = useState(()=>new Set());
  const [editing,setEditing] = useState(null);
  const [saving,setSaving] = useState(false);

  const suppressionEmails = useMemo(
    () => new Set(suppressions.map(item=>item.email.toLowerCase())),
    [suppressions],
  );
  const reviewLeads = leads.filter(lead=>['queued','reviewing'].includes(lead.status));
  const approvedLeads = leads.filter(lead=>lead.status==='approved');
  const historyLeads = leads.filter(lead=>!['queued','reviewing','approved'].includes(lead.status));
  const visible = view==='review' ? reviewLeads : view==='approved' ? approvedLeads : historyLeads;
  const sentCount = leads.filter(lead=>['sent','replied'].includes(lead.status)).length;

  const toggle = id => setSelectedIds(current=>{
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const approveSelected = async () => {
    const selected = leads.filter(lead=>selectedIds.has(lead.id)
      && lead.recipient_email
      && !suppressionEmails.has(lead.recipient_email.toLowerCase()));
    if (!selected.length) return;
    setSaving(true);
    for (const lead of selected) {
      await updateLead(lead,{
        status:'approved',
        approved_at:new Date().toISOString(),
      });
    }
    setSelectedIds(new Set());
    setSaving(false);
  };

  return <section className="outreach-page">
    <div className="outreach-heading">
      <div>
        <h1>Outreach</h1>
        <p>Review every new CCS lead before anything is sent.</p>
      </div>
      <div className="sender-state">
        <span><Mail size={16}/> Sender</span>
        <strong>samward@gsdecorating.com</strong>
        <small>Connection required before sending</small>
      </div>
    </div>

    <div className="outreach-stats">
      <article><Clock3/><div><span>Ready for review</span><strong>{reviewLeads.length}</strong></div></article>
      <article><CheckCircle2/><div><span>Approved</span><strong>{approvedLeads.length}</strong></div></article>
      <article><Send/><div><span>Sent or replied</span><strong>{sentCount}</strong></div></article>
      <article><ShieldX/><div><span>Do not contact</span><strong>{suppressions.length}</strong></div></article>
    </div>

    <div className="outreach-panel">
      <div className="outreach-tabs" role="tablist" aria-label="Outreach queue views">
        <button className={view==='review'?'active':''} onClick={()=>setView('review')}>Review <span>{reviewLeads.length}</span></button>
        <button className={view==='approved'?'active':''} onClick={()=>setView('approved')}>Approved <span>{approvedLeads.length}</span></button>
        <button className={view==='history'?'active':''} onClick={()=>setView('history')}>History <span>{historyLeads.length}</span></button>
        {view==='review'&&<button className="approve-selected" disabled={!selectedIds.size||saving} onClick={approveSelected}><Check size={15}/> Approve selected ({selectedIds.size})</button>}
      </div>

      {visible.length===0
        ? <div className="outreach-empty"><Mail/><h2>{view==='review'?'No new leads waiting':'Nothing here yet'}</h2><p>{view==='review'?'Future nightly CCS discoveries will appear here automatically. You can also add an existing project from its detail panel.':'Approved and completed outreach will appear in this view.'}</p></div>
        : <div className="outreach-list">
          <div className="outreach-list-head"><span>Lead</span><span>Contact</span><span>Company</span><span>Status</span><span>Added</span><span/></div>
          {visible.map(lead=>{
            const suppressed = lead.recipient_email&&suppressionEmails.has(lead.recipient_email.toLowerCase());
            return <article className="outreach-row" key={lead.id}>
              <div className="lead-cell">
                {view==='review'&&<input type="checkbox" disabled={!lead.recipient_email||suppressed} checked={selectedIds.has(lead.id)} onChange={()=>toggle(lead.id)} aria-label={`Select ${lead.project_name}`}/>}
                <div><strong>{lead.project_name}</strong><small>CCS {lead.project_id.replace('site','')}</small></div>
              </div>
              <div><strong>{lead.recipient_name||'Site contact'}</strong><small>{lead.recipient_email||'No email published'}</small></div>
              <div>{lead.company_name||'Not published'}</div>
              <div><span className={`outreach-status status-${suppressed?'suppressed':lead.status}`}>{suppressed?'Do not contact':statusLabel(lead.status)}</span>{lead.status==='approved'&&<small>{lead.attio_record_id?'CRM synced':lead.attio_sync_error?'CRM error':'CRM pending'}</small>}</div>
              <div>{formatDate(lead.created_at)}</div>
              <div><button className="review-lead" onClick={()=>setEditing(lead)}>{view==='history'?'View':'Review'}</button></div>
            </article>;
          })}
        </div>}
    </div>

    <div className="outreach-notice">
      <ShieldX size={18}/>
      <div><strong>Sending remains locked until Sam’s mailbox is connected.</strong><p>Approved messages stay in SiteFinder and cannot be sent accidentally. Suppressed addresses are clearly blocked.</p></div>
    </div>

    {editing&&<OutreachComposer lead={editing} suppressed={Boolean(editing.recipient_email&&suppressionEmails.has(editing.recipient_email.toLowerCase()))} communications={communications.filter(item=>item.project_id===editing.project_id)} close={()=>setEditing(null)} save={async changes=>{setSaving(true);const ok=await updateLead(editing,changes);setSaving(false);if(ok)setEditing(null)}} syncToAttio={syncToAttio} saving={saving}/>}
  </section>;
}

function OutreachComposer({lead,suppressed,communications,close,save,syncToAttio,saving}) {
  const [subject,setSubject] = useState(lead.email_subject||'');
  const [body,setBody] = useState(lead.email_body||'');
  const readonly = ['sent','replied','bounced','suppressed'].includes(lead.status);

  return <div className="composer-backdrop" role="presentation">
    <section className="outreach-composer" role="dialog" aria-modal="true" aria-label={`Review outreach for ${lead.project_name}`}>
      <header><div><h2>{lead.project_name}</h2><p>Review the recipient and wording before approval.</p></div><button onClick={close} aria-label="Close outreach review"><X/></button></header>
      <div className="composer-addresses">
        <label>From<input value="samward@gsdecorating.com — not connected" readOnly/></label>
        <label>To<input value={lead.recipient_email||'No email published by CCS'} readOnly/></label>
      </div>
      <label>Subject<input value={subject} onChange={event=>setSubject(event.target.value)} readOnly={readonly}/></label>
      <label>Message<textarea rows="12" value={body} onChange={event=>setBody(event.target.value)} readOnly={readonly}/></label>
      {suppressed&&<div className="suppressed-warning"><ShieldX size={17}/><strong>This address is on the do-not-contact list and cannot be approved.</strong></div>}
      <div className="composer-history"><h3>Communication history</h3><CommunicationTimeline communications={communications}/></div>
      {lead.status==='approved'&&<div className="crm-state"><strong>{lead.attio_record_id?'Synced to Attio':lead.attio_sync_error?'Attio sync needs attention':'Waiting to sync to Attio'}</strong>{lead.attio_sync_error&&<small>{lead.attio_sync_error}</small>}{!lead.attio_record_id&&<button type="button" disabled={saving} onClick={()=>syncToAttio(lead)}>Retry Attio sync</button>}</div>}
      {!readonly&&<footer>
        <button className="skip" disabled={saving} onClick={()=>save({status:'skipped',skipped_at:new Date().toISOString(),email_subject:subject,email_body:body})}><SkipForward size={15}/> Skip</button>
        <button disabled={saving} onClick={()=>save({status:'reviewing',email_subject:subject,email_body:body})}>Save draft</button>
        <button className="approve" disabled={saving||suppressed||!lead.recipient_email||!subject.trim()||!body.trim()} onClick={()=>save({status:'approved',approved_at:new Date().toISOString(),email_subject:subject,email_body:body})}><Check size={15}/> Approve</button>
      </footer>}
    </section>
  </div>;
}

export function CommunicationTimeline({communications}) {
  if (!communications.length) return <p className="communication-empty">No communication recorded for this project yet.</p>;
  return <div className="communication-timeline">{communications
    .toSorted((a,b)=>new Date(b.occurred_at)-new Date(a.occurred_at))
    .map(item=><article key={item.id}>
      <div className="communication-icon">{item.channel==='phone'?<Phone size={15}/>:item.channel==='email'?<Mail size={15}/>:<MessageSquareText size={15}/>}</div>
      <div><strong>{item.subject||`${item.direction==='inbound'?'Incoming':'Logged'} ${item.channel}`}</strong><p>{item.body||'No notes added.'}</p><small>{formatDate(item.occurred_at)} · {statusLabel(item.status)}</small></div>
    </article>)}</div>;
}
