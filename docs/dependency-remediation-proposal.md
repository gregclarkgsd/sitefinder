# Scoped dependency proposal (not applied)

Evidence: CI audit logs from run 39507007308. Root findings match the reviewed
base; worker manifests and lockfile are unchanged. No package upgrade is included
in the Lemlist worker changes. Counts describe affected packages, not independent
exploits. Reachability and exploitability have not been established.

| Separate change | Exact audit-proposed upgrade | Risk and required checks |
| --- | --- | --- |
| Runtime MCP | `@modelcontextprotocol/sdk` 1.29.0  1.32.1 | Same major, minor update; authentication/session/HTTP behavior may tighten. Run MCP stdio and HTTP smoke tests plus auth/transport regression tests. |
| Worker HTTP | `undici` 7.29.0  7.30.1 | Same major; redirects, TLS, decompression, cookies and retry behavior may change. Run worker type/unit/build tests and mocked redirect/SSRF/size-limit cases. |
| Development command launcher | `concurrently` 10.0.4  10.0.6 | Patch update; verify Windows command quoting and process shutdown. Confirm resolved `shell-quote` leaves vulnerable range 1.8.4-1.10.0. |
| Development/build server | locked `vite` 8.1.5  8.3.4 | Same major, minor update; Windows editor launching and dev-server behavior change. Pin deliberately instead of relying on `latest`; test production build and local Windows dev start. |

Prioritize runtime fixes. Root server uses MCP HTTP transport and
`app.set('trust proxy', 1)`; worker HTTP imports Undici. The critical `proxy-addr`
finding therefore merits explicit trusted-proxy/address classification tests.
`concurrently`/`shell-quote` and Vite are used for development/build, although this
repository currently lists them as dependencies. Moving their classification is
a separate packaging decision, not a vulnerability fix.

The audit also requests targeted lockfile updates for transitive `proxy-addr`
(affected through 2.0.7), `fast-uri` (3.0.0-3.1.7), `hono` (through 4.13.10),
`ip-address` (through 10.7.0), `nanoid` (below 3.3.18), `postcss` (through 8.5.22),
`qs` (through 6.15.3), and `source-map-js` (1.0.0-1.2.1). Exact resolved replacement
versions for these were not provided in the retained audit output. Registry
lookups on Northy did not verify replacement metadata; do not guess versions or
force overrides. In a separate remediation branch, inspect a targeted lockfile
resolution/dry run and propose its exact version diff before applying it. Reject
unrelated upgrades or new major versions. Run both audits and all existing CI
checks after approved updates; an audit-only pass does not establish runtime
compatibility. Do not run broad `npm audit fix --force`.
