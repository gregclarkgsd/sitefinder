# Design QA — Inbox-style Outreach

- Source visual truth: `/Users/gregclark/Documents/Health and safety/gsd-sitefinder/source-outreach-option-2.png`
- Implementation screenshot: `/Users/gregclark/Documents/Health and safety/gsd-sitefinder/implementation-outreach-final.jpg`
- Source pixels: 1487 × 1058
- Implementation pixels: 1280 × 720
- CSS viewport: 1280 × 720
- Device scale factor: 1
- State: Outreach → Needs review → Bowmer + Kirkland selected
- Density normalization: both images were rendered proportionally in one side-by-side browser comparison. The implementation was also inspected at its native 1280 × 720 viewport and scrolled to verify the lower send controls.

## Full-view comparison evidence

The implementation preserves the selected mock-up’s information architecture: four inbox folders, project conversations, a selected project timeline, essential project/contact/Attio facts, an editable email, follow-up control, a single primary approval action, contextual guidance, connected GSD mailbox, and a separate Woodpecker bulk-campaign link.

The implementation uses the existing SiteFinder navigation and tokens rather than recreating the generated mock’s approximated header. At the shorter 720 px viewport, the send controls sit below the initial fold; scrolling the central workspace exposes them without hiding or breaking persistent navigation.

## Focused region comparison evidence

- Header and folders: checked together in the full-view comparison; hierarchy, selected folder treatment, counts and Woodpecker link match the reference intent.
- Project timeline and facts: checked at native viewport; four completed stages, Attio project state and contact details remain readable.
- Draft and send controls: checked in a focused lower-page viewport after scrolling. Subject/message editing, follow-up checkbox, approval button, safe approval notice and next-step guidance are visible and aligned.

## Required fidelity surfaces

- Fonts and typography: Existing Inter/system stack, weights, hierarchy and readable UI sizes match SiteFinder and the selected mock-up. No actionable wrapping or truncation defects.
- Spacing and layout rhythm: Two-column inbox layout, grouped detail regions and restrained dividers match the source. The shorter verification viewport causes expected vertical scrolling but no control loss.
- Colors and visual tokens: Existing navy, orange, pale blue, green verification and neutral border tokens match both the source and current SiteFinder product.
- Image quality and assets: The design has no raster imagery. Existing Lucide iconography is used consistently with the current codebase and selected line-icon direction; no placeholder or CSS-drawn assets were introduced.
- Copy and content: Clear project-specific language, explicit mailbox, plain-English chase rules, Attio logging and the separate Woodpecker bulk path are present.

## Primary interactions tested

- Open Outreach from primary navigation.
- Switch among Needs review and Ready to send folders.
- Select projects in the conversation list.
- Enter edit mode, change subject/message, and finish editing.
- Confirm follow-up setting is enabled.
- Confirm approval is enabled only for an eligible contact.
- Approve locally and verify the safety message; no email is sent.
- Check a fresh page load for browser console errors.

## Comparison history

### Iteration 1

- P2: Demo email bodies displayed escaped newline characters in the rendered draft.
- Fix: Normalized stored escaped newlines before placing content in the editor.
- Post-fix evidence: Final implementation screenshot shows correctly formatted multi-paragraph email content.

- P2: Approval feedback could appear against the next automatically selected lead after the approved lead moved folders.
- Fix: Set feedback before the status transition so lead selection cleanup removes stale feedback.
- Post-fix evidence: Folder switching and selected-lead state were retested with no stale message attached to another lead.

## Residual P3 polish

- A future large-screen pass could keep the send control visible without scrolling at 900 px+ viewport heights.
- Real project types and “why this lead” explanations should replace demo values when the research pipeline supplies those fields.

## Final result

final result: passed
