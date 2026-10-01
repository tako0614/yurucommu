# Local browser feed, story and profile — 2026-10-01

Task GA-20261001-yuru-feed-media-browser, Yurucommu only, after #48.
Parent owns package.json/CI, README.md/README.en.md and this ledger;
bounded workers own scripts/smoke-release-browser.mjs and
scripts/release-browser-feed.mjs separately. Product media adapter/caller
ownership was assigned after an actual old-artifact reproduction: a bounded
worker owns src/lib/media-upload.ts and its SDK contract tests, plus only the
imports/calls in atoms/timeline.ts, story/composer/useStoryPost.ts,
profile/ProfileEditModal.tsx and CommunityProfilePage.tsx.
No shared Core/schema/other-worktree changes, real credential/data operation,
new auth permission, publication or deploy. Preserve original dirty work.

The user requires personal self-deployment by one human owner. The browser
journey must begin with migrations only and no actor/session seed, prove real
first password login and one persisted owner, then use only that owner for
feed, story and profile operations. No synthetic participant or additional
owning user is required. Yurumeet's product premise remains unspecified.

Source mapping identifies a published API4.1.11 ASCII filename restriction:
feed and profile pass original Files, whereas image stories export story.jpg
from their canvas. Confirm the distinct actual UI behavior before changing
product transport naming. Retain MIME/size checks and original File metadata;
do not change the shared SDK/server validation or create a compatibility retry.

Require actual Chrome UI contact with the built artifact through disposable
local HTTP and native D1/KV/R2, correlated post/story/profile DB effects,
attachment storage and HTTP bytes, refresh and a 390px populated layout.
Generated story JPEG is compared with its submitted composition, rather than
the input PNG. Add the browser check as a required separate CI step after the
complete portable gate; installed Chrome is mandatory and never auto-downloaded.

Source, mocked plans, native/local browser and CI are separate evidence from
published app+Provider+Host install, public TLS/OIDC/native clients, actual
cross-server communication and update/restore. Atomic OIDC owner claim and
unattached media lifecycle remain principal/Core proposals; do not use these
new checks to close those dependencies. Complete independent review, read-only
bun run check with source fingerprints, artifact regressions and exact-head CI
before integration return. Serialize heavy builds behind principal work.

Old artifact 321fb54 / sha256:5c0bb2ee1a02f6056df550ece237c30d412d4fc709f9942ba436612711c46627
was probed with real Chrome149 and native stores after actual first password
login. ASCII PNG uploads200; the identical Japanese PNG is refused before HTTP
in both post and profile UI, with their existing localized errors. Only one
actor/owner/session exists and no page error is raised. The first profile
attempt used an incorrect button selector for a file-picker label and timed
out; only the corrected label/filechooser run is counted. Diagnostic evidence:
operator-runs/yurucommu-ga-feed-browser-20261001/browser-old-result.json.

The product adapter now validates a name-only SDK view before any byte read or
new File, then copies unchanged bytes/type/time to a concrete File with an
ASCII MIME-derived basename and calls the published uploadMedia once. Feed,
Story, own-profile and community icon callers retain their prior UI validations
and errors. Focused SDK checks: 4 pass / 24 assertions. Community/header/video
callers are source/portable coverage in this unit, not separate browser proof.
All bounded workers have returned their files; the parent owns final integration.
The new gate also reproduces the old Japanese post-upload refusal after actual
root login, text posting and a successful ASCII PNG upload. Test implementation
fixes (response method calls, selectors, transport names, precise private cache/
403 body and guarded secondary wait rejection) are verifier corrections and do
not constitute product fixes or actual public-environment evidence.

Empty StoryBar source omitted the add-action accessible label; actual old Chrome
reported its name as the avatar initial plus “あなたのストーリー”. Add the same
“ストーリーを追加” aria-label used in the populated/error branches, and require it
in the new gate. The browser also waits for the selected photo's actual canvas
pixel and checks its pixel/dimensions after generated-JPEG reload. Story's API
response uses Document/mediaType, whereas the persisted/request attachment uses
content_type; preserve and verify both shapes. Public Note media is private-cache
for its author and public-cache for anonymous readers; profile icons are public
for both. Do not change Core to match a verifier's incorrect assumptions.

An operator-only old-artifact diagnostic uses ASCII fixtures and the old Story
button name to check the remaining selectors/contracts while the principal
heavy gate runs. Its final 16 checks pass, but it cannot qualify Japanese upload
or the new accessible name; earlier selector/cache/response-shape attempts are
excluded. Only the unchanged committed verifier on the newly built artifact,
plus exact-head CI, qualifies this change. Digest mismatch and invalid Chrome
preflight both refuse with exit1. No browser download, skipped qualification,
seeded actor/session, HTTP success stub or real cloud mutation is permitted.
