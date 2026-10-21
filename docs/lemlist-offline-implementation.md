# Offline connection implementation checkpoint

This local-only batch extends the previously tested draft PR #10. It has not been
published, deployed or connected to any account. All new runtime and provider
ports require explicit synthetic mode and are disabled by default. No credentials,
HTTP listener, scheduler or authenticated network transport are configured.

## Implemented

- `lemlist-offline-ports.js`: injected Lemlist and Attio request ports with bounded
  read retries, pagination, identity checks and campaign allowlisting. Enrollment
  is synthetic only and is never automatically retried. Pause requests are scoped
  to one campaign and require matching paused-state readback. History mappings
  require explicit coverage and canonical identities; unknown history holds work.
  Verified Woodpecker non-use is supported without requiring an integration.
- `lemlist-runtime.js`: dedicated serializable transaction connection, consistent
  SiteFinder snapshot reads and durable completed-sync review dispatch. A late
  sync remains discoverable. Claims and recovery use generations to reject stale
  workers. Dispatcher output is review-only; it does not enroll contacts.
- `lemlist-delivery.js`: documented webhook body-secret verification with bounded
  payloads and campaign/team checks; sanitized durable inbox with replay detection,
  quarantine and explicit recovery; durable campaign stop queue with retries,
  identity resolution, paused readback and quarantine on exhausted attempts.
- `lemlist-worker.js`: accepted reply, bounce and unsubscribe events atomically
  hold local work and enqueue provider stopping. Bounce/unsubscribe suppression
  remains in the same transaction. Failure to enqueue rolls back event application.
- `docs/lemlist-delivery.sql`: unapplied private inbox, dispatch and stop tables,
  with row security and public-role access revoked. It is outside migrations.

Lemlist's documented webhook secret is a shared password in the JSON body, not
an HMAC signature. The verifier strips it before persistence. Synthetic enrollment
does not rely on an undocumented `launch: false` API parameter. Pausing cannot
be represented as recalling an email already in flight.

## Validation and limits

Local `npm test`: 190 tests passed, followed by 22 focused in-memory PostgreSQL
checks. `npm run build` also passed. Tests include webhook-to-local-hold-to-confirmed-stop flow, conflicting
replays, uncertain processing recovery, stale-worker fencing, bounded retries,
late completed syncs and verified unused-source coverage. Test data is synthetic.

The full-schema runner now includes the fourth SQL design, but the new batch has
not run against the complete schema in a real concurrent PostgreSQL server.
Docker, Deno and psql are unavailable here. PGlite queue tests do not establish
real multi-connection locking behavior. Previous green CI applies to the earlier
published commit, not this batch. No live provider behavior was tested.

## Remaining work before a live connection

1. Review and publish this sanitized batch only after separate publication
   approval; run CI and complete real PostgreSQL queue concurrency/recovery tests.
2. Confirm exact runtime owner, database project and Lemlist account identity.
   Review least-privilege grants and server-only secret storage before separately
   approving any persistent access setup. No key should be pasted into chat.
3. Implement and review authenticated transport and production orchestration as a
   separate change. These ports intentionally reject production mode. Verify
   pagination consistency, rate limits, campaign settings, actual stop behavior
   and webhook delivery/retry semantics against the authorized account.
4. Complete source-specific history/suppression joins and campaign enumeration.
   Normalized mappings are not evidence of complete account history. Confirm
   which providers are actually used; unknown usage holds eligibility. Resolve
   canonical company aliases and Sam/Greg ownership with fresh approvals.
5. Approve SQL installation separately, reconcile any pre-existing event rows
   lacking stop-outbox entries, and establish monitoring, retention, recovery and
   an emergency stop procedure. No schema has been applied by this work.
6. Review a small read-only sample with `projectName` from the eligible SiteFinder
   project name and verified `firstName`. Independently approve any owned-contact
   enrollment test only after manual/paused state is read back. Sending and launch
   remain separate approvals. Set an explicit future go-live boundary, distinct
   from the first database baseline, before considering new-project activation.

The immediate approval boundary is publication of these local sanitized changes
to the existing draft PR and CI execution. It does not include merging, deploying,
configuring credentials, creating services, importing contacts or sending.

## API references used for offline request shapes

- [Lemlist create lead](https://developer.lemlist.com/api-reference/endpoints/leads/create-lead-in-campaign)
- [Lemlist campaign leads](https://developer.lemlist.com/api-reference/endpoints/leads/get-campaign-leads)
- [Lemlist lead lookup](https://developer.lemlist.com/api-reference/endpoints/leads/get-lead-by-email-or-id)
- [Lemlist pause lead](https://developer.lemlist.com/api-reference/endpoints/leads/pause-lead)
- [Lemlist webhooks](https://developer.lemlist.com/api-reference/endpoints/webhooks/add-webhook)
- [Attio record queries](https://docs.attio.com/rest-api/endpoint-reference/records/list-records)
