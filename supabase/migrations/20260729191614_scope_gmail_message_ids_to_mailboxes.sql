-- Gmail message identifiers are stable only within a mailbox. Scope replay
-- protection to the actual sender/recipient pair so multiple connected GSD
-- mailboxes cannot suppress one another's communication history.
drop index if exists public.outreach_communications_provider_message_idx;

create unique index outreach_communications_provider_message_mailbox_idx
  on public.outreach_communications (
    provider,
    provider_message_id,
    lower(sender_email),
    lower(recipient_email)
  )
  where provider_message_id is not null
    and sender_email is not null
    and recipient_email is not null;

comment on index public.outreach_communications_provider_message_mailbox_idx is
  'Idempotency key for provider messages, scoped to the sending and receiving mailboxes.';
