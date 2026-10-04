# Staged feed attachments

The feed composer retains the selected original File only in memory, alongside
its uploaded reference and optional server-advertised `expires_at`. It displays
that deadline and blocks posting once it elapses. It never infers a deadline for
older servers or malformed values. API4.1.11 forwards upload JSON and error codes;
its older type declaration is extended only for this optional response field.
Core/API dependency versions and schema bundles stay unchanged.

An explicit 409/MEDIA_EXPIRED response is a rejected post, with the text, CW,
audience and original attachments retained. The response does not identify a
key, so all submitted references require explicit re-upload or removal. Renewal
uploads original bytes and replaces only that attachment's remote reference;
newer alt-text edits, local preview, draft fields and other attachments survive.
It does not post or automatically retry. Other conflicts, timeouts, 5xx, network
and malformed acknowledgements keep their existing outcome treatment.

An upload is owned by its principal, auth epoch, hosted-user identity, instance,
strategy and public SDK transport/URLs. Check scope after reading a File before
the SDK resolves its mutable transport, and again before adopting a response.
Login/sign-out of the same actor invalidates the earlier epoch. Removal or
replacement during renewal wins; an alt edit does not change logical attachment
identity. Same-user metadata refresh preserves bytes. The composer releases
foreign-scope Files/previews after auth/instance changes. This client fence does
not prove HttpOnly token rotation or revocation held outside the browser.

Reload retains the existing text/CW/audience draft but loses attachment Files.
The composer says this explicitly. Nothing serializes source bytes, auth
strategies or transport objects into draft storage or a post request.

Yurucommu remains individually deployed single-owner software, with personas and
external communication peers separate from instance ownership. This feed UX is
not a new Yurumeet/Core owner model. Story intent expiry and Yurumeet Talk's
immutable outgoing journal require separate recovery changes: Talk's local intent
ID is not a server idempotency key, and uncertain sends may already be accepted.

Qualification records belong in the integration handoff. Atom tests, browser
fixtures with synthetic HTTP, disposable Worker/D1 and live/operator evidence
are distinct. Core integration/publication, real existing-data update/restore,
real issuer/client custody and exact public app/provider/host qualification remain
GA dependencies. There is no production deploy or live schema/data change here.
