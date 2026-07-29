import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Inbox,
  Mail,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Phone,
  Plus,
  Send,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import './outreach.css';
import {
  canSendInitial,
  outreachFolderFor,
  outreachStatusGuidance,
  outreachStatusLabel,
  outreachTimelineFor,
} from './outreachState';

const formatDate = value => value
  ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Not yet';

const projectType = lead => lead.project_type || lead.project_name || 'New construction opportunity';

export function OutreachPage({ leads, communications, suppressions, mailboxes = [], mailboxesLoading = false, mailboxError = '', connectMailbox, updateLead, approveAndSend, focusProjectId = '' }) {
  const [folder, setFolder] = useState('review');
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [editSnapshot, setEditSnapshot] = useState({ subject: '', body: '' });
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [followUp, setFollowUp] = useState(true);
  const [senderEmail, setSenderEmail] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState('success');
  const handledFocusProjectId = useRef('');

  const suppressionEmails = useMemo(
    () => new Set(suppressions.map(item => item.email.toLowerCase())),
    [suppressions],
  );
  const folders = useMemo(() => ([
    { id: 'review', label: 'Needs review', icon: Inbox, count: leads.filter(lead => outreachFolderFor(lead) === 'review').length },
    { id: 'ready', label: 'Ready to send', icon: Send, count: leads.filter(lead => outreachFolderFor(lead) === 'ready').length },
    { id: 'waiting', label: 'Waiting for reply', icon: MessageCircle, count: leads.filter(lead => outreachFolderFor(lead) === 'waiting').length },
    { id: 'followup', label: 'Follow-up due', icon: Clock3, count: leads.filter(lead => outreachFolderFor(lead) === 'followup').length },
  ]), [leads]);
  const visible = useMemo(
    () => leads.filter(lead => outreachFolderFor(lead) === folder),
    [folder, leads],
  );
  const selected = leads.find(lead => lead.id === selectedId) || visible[0] || null;
  const projectCommunications = selected
    ? communications.filter(item => item.project_id === selected.project_id)
    : [];
  const suppressed = Boolean(selected?.recipient_email
    && suppressionEmails.has(selected.recipient_email.toLowerCase()));
  const selectedMailbox = mailboxes.find(mailbox => mailbox.mailbox_email === senderEmail) || null;
  const initialSendEligible = canSendInitial(selected);
  const timeline = selected ? outreachTimelineFor(selected) : [];

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    const nextSubject = selected.email_subject || `Painting and spray support for ${selected.project_name}`;
    const nextBody = (selected.email_body || `Hi ${selected.recipient_name?.split(' ')[0] || 'there'},\n\nI came across ${selected.project_name} and wanted to introduce GSD Decorating.\n\nWe are a specialist painting, decorating and spray contractor supporting main contractors across London and the South. We would welcome the opportunity to price the relevant packages for this project.\n\nWould it be useful if I sent over a short capability summary and examples of similar work?\n\nKind regards,\nSam Ward\nGSD Decorating`).replaceAll('\\n', '\n');
    setSubject(nextSubject);
    setBody(nextBody);
    setEditSnapshot({ subject: nextSubject, body: nextBody });
    setFollowUp(selected.follow_up_enabled ?? true);
    setEditing(false);
    setNotice('');
    setNoticeKind('success');
    setDraftNotice('');
    setDraftError('');
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) return;
    const assignedMailbox = mailboxes.find(mailbox => mailbox.mailbox_email === selected.sender_email);
    setSenderEmail(assignedMailbox?.mailbox_email || mailboxes[0]?.mailbox_email || '');
  }, [selected?.id, selected?.sender_email, mailboxes]);

  useEffect(() => {
    if (!focusProjectId) {
      handledFocusProjectId.current = '';
      return;
    }
    if (handledFocusProjectId.current === focusProjectId) return;
    const focusedLead = leads.find(lead => lead.project_id === focusProjectId);
    if (!focusedLead) return;
    handledFocusProjectId.current = focusProjectId;
    setFolder(outreachFolderFor(focusedLead));
    setSelectedId(focusedLead.id);
  }, [focusProjectId, leads]);

  const saveLead = async changes => {
    if (!selected) return false;
    const ok = await updateLead(selected, changes);
    return ok;
  };

  const beginEditing = () => {
    setEditSnapshot({ subject, body });
    setDraftNotice('');
    setDraftError('');
    setEditing(true);
  };

  const cancelEditing = () => {
    setSubject(editSnapshot.subject);
    setBody(editSnapshot.body);
    setDraftNotice('');
    setDraftError('');
    setEditing(false);
  };

  const persistDraft = async () => {
    if (!selected) return;
    setDraftSaving(true);
    setDraftNotice('');
    setDraftError('');
    const ok = await saveLead({
      email_subject: subject,
      email_body: body,
    });
    setDraftSaving(false);
    if (!ok) {
      setDraftError('The draft could not be saved. Your edits are still on screen; check the connection and try again.');
      return;
    }
    setEditSnapshot({ subject, body });
    setEditing(false);
    setDraftNotice('Draft saved.');
  };

  const approve = async () => {
    if (!selected || !initialSendEligible) {
      setNoticeKind('error');
      setNotice('This outreach status is not eligible for an initial email.');
      return;
    }
    setSaving(true);
    const changes = {
      status: 'approved',
      approved_at: new Date().toISOString(),
      email_subject: subject,
      email_body: body,
      follow_up_enabled: followUp,
      sender_email: senderEmail,
    };
    const result = approveAndSend
      ? await approveAndSend(selected, changes)
      : { ok: await updateLead(selected, changes), sent: false };
    setSaving(false);
    if (result?.approved || result?.ok) {
      setFolder(result.reconciliationRequired ? 'review' : result.sent ? 'waiting' : 'ready');
      setSelectedId(selected.id);
    }
    if (result?.ok) {
      setNoticeKind('success');
      setNotice(result.sent
        ? 'Email sent from the GSD mailbox. Replies and follow-ups will be logged automatically.'
        : 'Approved safely. This email is ready, but it will not send until the GSD mailbox connection is enabled.');
      setEditing(false);
    } else {
      setNoticeKind('error');
      setNotice(result?.error || 'The email was not sent. The approved draft remains safely in the queue.');
    }
  };

  return <section className="outreach-page outreach-inbox">
    <div className="outreach-heading">
      <div>
        <h1>Sales Outreach Agent</h1>
        <p>Review and send personalised project outreach from your connected GSD mailbox.</p>
      </div>
      <div className="outreach-heading-actions">
        <a href="https://app.woodpecker.co/" target="_blank" rel="noreferrer">Bulk campaign? Use Woodpecker <ExternalLink size={14}/></a>
        <div className="sender-state mailbox-summary">
          <Mail size={17}/>
          <div><span>Connected GSD mailboxes</span><strong>{mailboxesLoading ? 'Checking…' : `${mailboxes.length} available`}</strong><small>Choose the sender on each project</small></div>
          <button type="button" onClick={connectMailbox}><Plus size={14}/> Add</button>
        </div>
      </div>
    </div>

    {mailboxError && <div className="mailbox-error" role="alert"><ShieldX size={17}/><span>{mailboxError}</span></div>}

    <div className="outreach-workspace">
      <aside className="outreach-sidebar" aria-label="Outreach folders">
        <nav aria-label="Outreach status folders">
          {folders.map(item => {
            const Icon = item.icon;
            return <button key={item.id} aria-current={folder === item.id ? 'page' : undefined} className={folder === item.id ? 'active' : ''} onClick={() => { setFolder(item.id); setSelectedId(null); }}>
              <Icon size={19}/><span>{item.label}</span><b>{item.count}</b>
            </button>;
          })}
        </nav>
        <div className="conversation-label">Projects</div>
        <div className="conversation-list" aria-label={`Projects in ${folders.find(item => item.id === folder)?.label || folder}`}>
          {visible.length === 0
            ? <p>No projects in this folder.</p>
            : visible.map(lead => <button key={lead.id} aria-current={selected?.id === lead.id ? 'true' : undefined} className={selected?.id === lead.id ? 'active' : ''} onClick={() => setSelectedId(lead.id)}>
              <i/>
              <span><strong>{lead.company_name || lead.project_name}</strong><small>{lead.project_name}</small></span>
              <time>{new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(lead.updated_at || lead.created_at))}</time>
            </button>)}
        </div>
      </aside>

      <section className="outreach-detail" aria-label="Selected outreach project">
        {!selected
          ? <div className="outreach-empty"><Mail/><h2>Nothing needs attention here</h2><p>New SiteFinder opportunities will appear automatically.</p></div>
          : <>
            <header className="outreach-project-head">
              <div><h2>{selected.company_name || selected.project_name}</h2><p>{selected.project_name} · CCS {selected.project_id.replace('site', '')}</p></div>
              <small>Updated {formatDate(selected.updated_at || selected.created_at)}</small>
            </header>

            <div className="outreach-timeline" role="list" aria-label="Outreach progress">
              {timeline.map(item => {
                const TimelineIcon = item.state === 'complete' ? CheckCircle2 : item.state === 'error' ? ShieldX : Clock3;
                const isDate = typeof item.detail === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item.detail);
                return <div className={`timeline-${item.state}`} role="listitem" key={item.id}><TimelineIcon size={21}/><strong>{item.label}</strong><small>{isDate ? formatDate(item.detail) : item.detail}</small></div>;
              })}
            </div>

            <div className="outreach-project-facts">
              <div><span>Project</span><strong>{projectType(selected)}</strong></div>
              <div><span>Company</span><strong>{selected.company_name || 'Not published'}</strong></div>
              <div><span>Best contact</span><strong>{selected.recipient_name || 'Site contact'}</strong></div>
              <div><span>CRM status</span><strong className={selected.attio_record_id ? 'positive' : ''}>{selected.attio_record_id ? 'Project linked in Attio' : 'Project sync pending'}</strong></div>
            </div>

            <section className="email-draft">
              <div className="email-draft-title">
                <h3>Email draft</h3>
                {!editing && initialSendEligible && <button aria-expanded="false" onClick={beginEditing}><Pencil size={14}/> Edit</button>}
              </div>
              <div className="email-address-line">
                <label className="sender-picker">From:
                  <select value={senderEmail} onChange={event => setSenderEmail(event.target.value)} disabled={mailboxesLoading || mailboxes.length === 0 || Boolean(selected.gmail_message_id)}>
                    {mailboxes.length === 0
                      ? <option value="">No mailbox connected</option>
                      : mailboxes.map(mailbox => <option key={mailbox.mailbox_email} value={mailbox.mailbox_email}>{mailbox.display_name ? `${mailbox.display_name} — ` : ''}{mailbox.mailbox_email}</option>)}
                  </select>
                </label>
                <span>To: <strong>{selected.recipient_email || 'No email available'}</strong></span>
                {selected.recipient_email && !suppressed && <em><ShieldCheck size={14}/> Available</em>}
              </div>
              <label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} readOnly={!editing}/></label>
              <label>Message<textarea rows="10" value={body} onChange={event => setBody(event.target.value)} readOnly={!editing}/></label>
              {editing && <div className="edit-actions">
                <button type="button" disabled={draftSaving} onClick={cancelEditing}>Cancel</button>
                <button type="button" className="save-draft" disabled={draftSaving} onClick={persistDraft}>{draftSaving ? 'Saving…' : 'Save draft'}</button>
              </div>}
              {draftNotice && <div className="draft-feedback success" role="status"><Check size={15}/><span>{draftNotice}</span></div>}
              {draftError && <div className="draft-feedback error" role="alert"><ShieldX size={15}/><span>{draftError}</span></div>}
              {suppressed && <div className="suppressed-warning"><ShieldX size={17}/><strong>This address is on the do-not-contact list.</strong></div>}
            </section>

            {initialSendEligible
              ? <section className="outreach-send-row">
                  <label className="followup-setting">
                    <input type="checkbox" checked={followUp} onChange={event => setFollowUp(event.target.checked)}/>
                    <span><strong>If there is no reply, follow up in 5 days</strong><small>A final follow-up is due after 10 days. Any reply stops the chase.</small></span>
                  </label>
                  <button className="approve-send" disabled={saving || draftSaving || editing || suppressed || !selected.recipient_email || !selectedMailbox || !subject.trim() || !body.trim()} onClick={approve}><Send size={17}/> {saving ? 'Working…' : selected.status === 'approved' ? 'Send approved email' : selected.status === 'failed' ? 'Retry approval and send' : 'Approve and send'}</button>
                </section>
              : <section className={`outreach-status-guidance status-${selected.status}`} role="status">
                  <ShieldCheck size={17}/>
                  <div><strong>{outreachStatusLabel(selected.status)}</strong><span>{outreachStatusGuidance(selected.status)}</span></div>
                </section>}

            {notice && <div role={noticeKind === 'error' ? 'alert' : 'status'} className={`outreach-success ${noticeKind === 'error' ? 'error' : ''}`}>{noticeKind === 'error' ? <ShieldX size={17}/> : <Check size={17}/>}<span>{notice}</span></div>}

            <div className="next-step">
              <strong>What you need to do next:</strong>
              <span>{initialSendEligible
                ? 'Review the email above. If you are happy, approve it. Replies and follow-ups will be recorded in SiteFinder.'
                : 'Use the status above to decide the next sales action. SiteFinder keeps the Gmail communication history with this project.'}</span>
            </div>

            {projectCommunications.length > 0 && <section className="conversation-history"><h3>Conversation history</h3><CommunicationTimeline communications={projectCommunications}/></section>}
          </>}
      </section>
    </div>
  </section>;
}

export function CommunicationTimeline({ communications }) {
  if (!communications.length) return <p className="communication-empty">No communication recorded for this project yet.</p>;
  return <div className="communication-timeline">{communications
    .toSorted((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
    .map(item => <article key={item.id}>
      <div className="communication-icon">{item.channel === 'phone' ? <Phone size={15}/> : item.channel === 'email' ? <Mail size={15}/> : <MessageSquareText size={15}/>}</div>
      <div><strong>{item.subject || `${item.direction === 'inbound' ? 'Incoming' : 'Logged'} ${item.channel}`}</strong><p>{item.body || 'No notes added.'}</p><small>{formatDate(item.occurred_at)} · {outreachStatusLabel(item.status)}</small></div>
    </article>)}</div>;
}
