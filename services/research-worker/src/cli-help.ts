export const CLI_HELP_TEXT = `GSD Sales Enrichment (read-only)

Commands:
  snapshot-attio       Save private Attio company/person snapshots
  snapshot-pipedrive   Save private Pipedrive organisation/person snapshots
  reconcile            Compare private snapshots without writing to either CRM
  universe             Compile a safe multi-source company research list
  enrich               Crawl official sites and optional public/licensed sources

Examples:
  npm run snapshot:attio -- --output snapshots/attio
  npm run snapshot:pipedrive -- --output snapshots/pipedrive
  npm run reconcile -- --attio-people /private-data/snapshots/attio/people.json \\
    --pipedrive-people /private-data/snapshots/pipedrive/people.json
  npm run universe -- --attio-companies snapshots/attio/companies.json \\
    --sitefinder-projects snapshots/sitefinder/projects.json \\
    --identity-resolutions reviews/sitefinder-crm-identities.json \\
    --cleanup-decisions cleanup/decisions.jsonl \\
    --cleanup-manifest cleanup/approval-manifest.json
  npm run enrich -- --input universe/latest/companies.json \\
    --cleanup-decisions cleanup/decisions.jsonl \\
    --cleanup-manifest cleanup/approval-manifest.json \\
    --attio-people snapshots/attio-post-cleanup/people.json \\
    --attio-snapshot-manifest snapshots/attio-post-cleanup/completion-manifest.json \\
    --pipedrive-people snapshots/pipedrive/people.json \\
    --pipedrive-snapshot-manifest snapshots/pipedrive/completion-manifest.json \\
    --pilot-manifest pilots/reviewed-50.json
  npm run enrich -- --input universe/latest/companies.json \\
    --cleanup-decisions cleanup/decisions.jsonl \\
    --cleanup-manifest cleanup/approval-manifest.json \\
    --attio-people snapshots/attio-post-cleanup/people.json \\
    --attio-snapshot-manifest snapshots/attio-post-cleanup/completion-manifest.json \\
    --pipedrive-people snapshots/pipedrive/people.json \\
    --pipedrive-snapshot-manifest snapshots/pipedrive/completion-manifest.json \\
    --pilot-manifest pilots/reviewed-50.json \\
    --publish-progress --run-name "Daily company research"

RESEARCH_PRIVATE_DATA_DIRECTORY is required and must point to an absolute,
non-iCloud directory outside every Git repository. --output is always a
relative child directory beneath that boundary.
All snapshot and policy inputs must also resolve beneath that boundary.
The optional progress feed updates SiteFinder's Research Agent control room.
Apollo is opt-in with --with-apollo and requires APOLLO_API_KEY. Its licensed
business emails remain review-only until independently verified publicly.
CRM write flags are intentionally unsupported.`;
