# Story media expiry and explicit renewal

Yurucommu is an individually deployed, single-owner product. This change stays
in its Story composer and uses the public Core/API package boundary; it does not
set Yurumeet's ownership model or publish a shared engine.

A received SDK `409 / MEDIA_EXPIRED` proves that the current Story attempt was
rejected before creation. A prior transport failure, malformed acknowledgement or
reloaded pending attempt remains uncertain even if a later retry receives that
rejection. Local intent UUIDs do not provide server idempotency. Uncertain writes
never permit replacement of their retained media. Legacy rejected records without
write history are conservatively treated as uncertain.

Only an optional server-advertised deadline is used. Missing deadlines support
older servers; malformed advertised values fail instead of becoming deadline-free
references. An elapsed deadline blocks submission and explicit retries. The
recovery screen updates when a deadline passes while it remains open.
Its viewport-bounded scroll surface is independent of the portrait editing canvas,
so retained text and explicit renewal controls remain reachable on short screens.

For an unsubmitted or definitely rejected expired intent, a deliberate renewal
uploads the complete rendered image/video again. The original mounted File stays
in memory. After reload, the user must choose a complete JPEG or MP4; the original
canvas, background and drawing are unavailable. Caption, overlays, duration and
community scope stay frozen. Renewal verifies the expected intent and exact
stored bytes, adopts a distinct media key and local UUID in one storage write,
then waits for a separate explicit publication action. It never posts a Story
automatically. File validation follows the public SDK limits: JPEG up to 20 MiB
and MP4 up to 40 MiB. Upload failure allows reselection and preserves the old
journal; a conflicting writer or failed readback locks the intent.

Browser sessionStorage offers an atomic replacement. A nonconforming storage
adapter that partially mutates bytes can lose recoverable durable content. The
coordinator retains the old record in memory, reports storage failure and refuses
publication; reload preserves corrupt bytes and remains blocked. It does not
blindly restore bytes over another writer.

Every asynchronous upload/send is tied to its mounted lifetime, actor, auth
epoch, logout state, selected instance, hosted user, strategy, transport and
resolved upload/Story endpoints. Changed identities cannot adopt old uploads or
redirect an old Story attempt. Complete media, canvas pixels and credentials are
never serialized into the intent journal.

The shared reference fence can reject an expired reference embedded in retained
caption/overlay strings as well as the main attachment. Its error does not identify
which reference failed. Replacing the main attachment alone therefore does not
guarantee success. The UI explains that limitation and retains text for checking
or rebuilding; a definitely rejected mounted draft can also return to editing.

Qualification must distinguish coordinator/actual SDK regressions, the owning
portable check, built-app browser cases using synthetic HTTP, native artifact
smoke and live service evidence. Local or CI results do not qualify real issuer
credentials, existing-data update/restore, public Host/TLS, Queue/Cron/federation
or physical-device behavior. Core integration/publication/adoption and those
operational checks remain separate GA dependencies. No production deploy or
live data mutation belongs to this source slice.
