# Yurucommu profile edit acknowledgements — 2026-10-02

Product-only candidate stacked after #63/1761d928. Source edits stay in the
dedicated Yurucommu worktree. Preserve original install/message-search changes,
the clean Yurumeet #36 and all prior evidence. No shared Core, schema, auth
permission, publication, deploy, new resources/billing or real-data deletion.
Yurucommu remains one human owner per personal instance; personas and remote
communication partners are distinct. No Yurumeet ownership premise is added.

Source gap: ProfilePage sends a profile snapshot, then reads editor signals
again after awaiting PUT. Name/bio and other controls remain editable during
the request. A successful response can therefore display unsaved B values when
native storage contains submitted A. A response after route navigation can also
modify the newly viewed profile. Profile image uploads likewise apply their
response after the editor closes and reopens, without identifying the editor
session that selected the file.

Acceptance: send one fixed profile snapshot, including deliberate empty
name/bio clears. While awaiting that PUT, disable edits and closing through the
button, Escape and backdrop; keep keyboard focus in the busy dialog. Apply
success/error UI effects only to the same loaded target and mounted page.
Closing during an upload remains possible; invalidate its local result/error
on close, hidden state and unmount, so reopening permits a new upload and never
inherits the prior result. This does not cancel remotely stored uploads or
change shared reference-safe cleanup contracts.

Required evidence: immutable #63 actual Chrome red with a real local Worker
commit held before acknowledgement; native A versus displayed B. Green uses
the same real route, checks all disabled controls and close methods, exact
native/request values, reload, late ACK after SPA navigation, old upload ACK
after same-page close/reopen, and a fresh upload/save. Run the owner check and
existing browser suite on the changed source, collect exact-head/tree CI and
independent review. Full gate/CI qualification is returned separately. Heavy jobs run serially
after fresh best-effort occupancy checks; a scan is not a slot reservation.

Observed red at 11:31 UTC: frozen #63 Worker
`f867594492861501d148ea85b118bb8c01c126f56d61e99c96e8b2f82555819e`
with source map `8ff3cc7d79f575eebd954d472b786714ebd1e475734ff5b584e0d3dcf591a219`.
Chrome 149 and real local Worker/native D1 proved submitted name/bio A versus
displayed B after ACK. A separate same-wildcard-route test loaded a synthetic
remote profile before releasing the real owner PUT response; the old client
replaced that visible profile with the owner's submitted name. Both terminal
results were expected-red, with one owner/session and zero Worker outbound
attempts. The remote GET is an explicitly synthetic UI fixture, not federation.
Earlier occupied-slot refusals launched no runtime; one harness JSONC parsing
failure and one overlength test-name assertion are not product red evidence.

Independent source review additionally required a same-Route navigation case,
post-response settling and absence of a stale success toast. The fixture binds
real request/native data, then awaits response completion and browser frames;
the immutable navigation red checks that this oracle observes the old late ACK
defect. Saving failure is separately injected before Worker arrival, so native
data must remain unchanged while input/controls recover for explicit retry.

The first full check stopped at 550 pass/1 fail when the existing generated
native fixture exceeded its 120-second deadline starting the fourth fresh
onboarding runtime. That generated fixture embeds only an empty root/title and
does not include the changed profile UI. Its unchanged single test subsequently
passed in 4.6 seconds, without changing source or widening a deadline. The
startup timeout's cause is not established; retain the failed full check and do
not call it a green run. The changed profile fixture passed all four cases on
Chrome 149/native D1 at 11:39 UTC, with one owner/session and zero outbound
attempts. The final whole owner check and full browser remain required.

These are local/native/browser and CI conditions. They do not qualify an
existing public installation, production D1 update, real issuer/token
use/refresh, public app+Provider+Host installation, deployed federation/Queue/
Cron, owner-creation atomicity or shared per-intent replay. Full family GA
remains incomplete.
