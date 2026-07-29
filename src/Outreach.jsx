import React, { useEffect, useMemo, useState } from 'react';
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

const formatDate = value => value
  ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Not yet';

const statusLabel = status => ({
  queued: 'Needs review',
  reviewing: 'Needs review',
  approved: 'Ready to send',
  sent: 'Waiting for reply',
  followup_due: 'Follow-up due',
  skipped: 'Saved for later',
  replied: 'Replied',
  bounced: 'Bounced',
  failed: 'Failed',
  suppressed: 'Do not contact',
}[status] || status);

const folderFor = lead => {
  if (lead.status === 'approved') return 'ready';
  if (lead.status === 'followup_due') return 'followup';
  if (lead.status === 'sent') return 'waiting';
  return 'review';
};

const projectType = lead => lead.project_type || lead.project_name || 'New construction opportunity';

export function OutreachPage({ leads, communications, suppressions, mailboxes = [], mailboxesLoading = false, mailboxError = '', connectMailbox, updateLead, approveAndSend }) {
  const [folder, setFolder] = useState('review');
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [followUp, setFollowUp] = useState(true);
  const [senderEmail, setSenderEmail] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState('success');

  const suppressionEmails = useMemo(
    () => new Set(suppressions.map(item => item.email.toLowerCase())),
    [suppressions],
  );
  const folders = useMemo(() => ([
    { id: 'review', label: 'Needs review', icon: Inbox, count: leads.filter(lead => folderFor(lead) === 'review').length },
    { id: 'ready', label: 'Ready to send', icon: Send, count: leads.filter(lead => folderFor(lead) === 'ready').length },
    { id: 'waiting', label: 'Waiting for reply', icon: MessageCircle, count: leads.filter(lead => folderFor(lead) === 'waiting').length },
    { id: 'followup', label: 'Follow-up due', icon: Clock3, count: leads.filter(lead => folderFor(lead) === 'followup').length },
  ]), [leads]);
  const visible = useMemo(
    () => leads.filter(lead => folderFor(lead) === folder),
    [folder, leads],
  );
  const selected = visible.find(lead => lead.id === selectedId) || visible[0] || null;
  const projectCommunications = selected
    ? communications.filter(item => item.project_id === selected.project_id)
    : [];
  const suppressed = Boolean(selected?.recipient_email
    && suppressionEmails.has(selected.recipient_email.toLowerCase()));
  const selectedMailbox = mailboxes.find(mailbox => mailbox.mailbox_email === senderEmail) || null;

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setSubject(selected.email_subject || `Painting and spray support for ${selected.project_name}`);
    setBody((selected.email_body || `Hi ${selected.recipient_name?.split(' ')[0] || 'there'},\n\nI came across ${selected.project_name} and wanted to introduce GSD Decorating.\n\nWe are a specialist painting, decorating and spray contractor supporting main contractors across London and the South. We would welcome the opportunity to price the relevant packages for this project.\n\nWould it be useful if I sent over a short capability summary and examples of similar work?\n\nKind regards,\nSam Ward\nGSD Decorating`).replaceAll('\\n', '\n'));
    setEditing(false);
    const assignedMailbox = mailboxes.find(mailbox => mailbox.mailbox_email === selected.sender_email);
    setSenderEmail(assignedMailbox?.mailbox_email || mailboxes[0]?.mailbox_email || '');
    setNotice('');
    setNoticeKind('success');
  }, [selected?.id, mailboxes]);

  const saveLead = async changes => {
    if (!selected) return;
    setSaving(true);
    const ok = await updateLead(selected, changes);
    setSaving(false);
    return ok;
  };

  const approve = async () => {
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
        <nav>
          {folders.map(item => {
            const Icon = item.icon;
            return <button key={item.id} className={folder === item.id ? 'active' : ''} onClick={() => { setFolder(item.id); setSelectedId(null); }}>
              <Icon size={19}/><span>{item.label}</span><b>{item.count}</b>
            </button>;
          })}
        </nav>
        <div className="conversation-label">Projects</div>
        <div className="conversation-list">
          {visible.length === 0
            ? <p>No projects in this folder.</p>
            : visible.map(lead => <button key={lead.id} className={selected?.id === lead.id ? 'active' : ''} onClick={() => setSelectedId(lead.id)}>
              <i/>
              <span><strong>{lead.company_name || lead.project_name}</strong><small>{lead.project_name}</small></span>
              <time>{new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(lead.updated_at || lead.created_at))}</time>
            </button>)}
        </div>
      </aside>

      <main className="outreach-detail">
        {!selected
          ? <div className="outreach-empty"><Mail/><h2>Nothing needs attention here</h2><p>New SiteFinder opportunities will appear automatically.</p></div>
          : <>
            <header className="outreach-project-head">
              <div><h2>{selected.company_name || selected.project_name}</h2><p>{selected.project_name} · CCS {selected.project_id.replace('site', '')}</p></div>
              <small>Updated {formatDate(selected.updated_at || selected.created_at)}</small>
            </header>

            <div className="outreach-timeline" aria-label="Outreach progress">
              {[
                ['New project found', selected.created_at],
                ['Research complete', selected.created_at],
                ['Project linked to Attio', selected.attio_synced_at],
                ['Email draft ready', selected.updated_at || selected.created_at],
              ].map(([label, date]) => <div key={label}><CheckCircle2 size={21}/><strong>{label}</strong><small>{date ? formatDate(date) : 'Ready for review'}</small></div>)}
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
                {!editing && <button onClick={() => setEditing(true)}><Pencil size={14}/> Edit</button>}
              </div>
              <div className="email-address-line">
                <label className="sender-picker">From:
                  <select value={senderEmail} onChange={event => setSenderEmail(event.target.value)} disabled={mailboxesLoading || mailboxes.length === 0 || Boolean(selected.gmail_message_id)}>
                    {mailboxes.length === 0
                      ? <option value="">No mailbox connected</option>
                      : mailboxes.map(mailbox => <option key={mailbox.mailbox_email} value={mailbox.mailbox_email}>{mailbox.display_name ? `${mailbox.display_name} — ` : ''}{mailbox.mailbox_email}</option>)}
                  </select>
                </label>
                <span>To: <strong>{selected.recipient_email || 'No verified email'}</strong></span>
                {selected.recipient_email && !suppressed && <em><ShieldCheck size={14}/> Verified</em>}
              </div>
              <label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} readOnly={!editing}/></label>
              <label>Message<textarea rows="10" value={body} onChange={event => setBody(event.target.value)} readOnly={!editing}/></label>
              {editing && <div className="edit-actions"><button onClick={() => setEditing(false)}>Done editing</button></div>}
              {suppressed && <div className="suppressed-warning"><ShieldX size={17}/><strong>This address is on the do-not-contact list.</strong></div>}
            </section>

            <section className="outreach-send-row">
              <label className="followup-setting">
                <input type="checkbox" checked={followUp} onChange={event => setFollowUp(event.target.checked)}/>
                <span><strong>If there is no reply, follow up in 5 days</strong><small>A final follow-up is due after 10 days. Any reply stops the chase.</small></span>
              </label>
              <button className="approve-send" disabled={saving || suppressed || !selected.recipient_email || !selectedMailbox || !subject.trim() || !body.trim()} onClick={approve}><Send size={17}/> Approve and send</button>
            </section>

            {notice && <div className={`outreach-success ${noticeKind === 'error' ? 'error' : ''}`}>{noticeKind === 'error' ? <ShieldX size={17}/> : <Check size={17}/>}<span>{notice}</span></div>}

            <div className="next-step">
              <strong>What you need to do next:</strong>
              <span>Review the email above. If you are happy, approve it. Replies and follow-ups will be recorded in Attio.</span>
            </div>

            {projectCommunications.length > 0 && <section className="conversation-history"><h3>Conversation history</h3><CommunicationTimeline communications={projectCommunications}/></section>}
          </>}
      </main>
    </div>
  </section>;
}

export function CommunicationTimeline({ communications }) {
  if (!communications.length) return <p className="communication-empty">No communication recorded for this project yet.</p>;
  return <div className="communication-timeline">{communications
    .toSorted((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
    .map(item => <article key={item.id}>
      <div className="communication-icon">{item.channel === 'phone' ? <Phone size={15}/> : item.channel === 'email' ? <Mail size={15}/> : <MessageSquareText size={15}/>}</div>
      <div><strong>{item.subject || `${item.direction === 'inbound' ? 'Incoming' : 'Logged'} ${item.channel}`}</strong><p>{item.body || 'No notes added.'}</p><small>{formatDate(item.occurred_at)} · {statusLabel(item.status)}</small></div>
    </article>)}</div>;
}
