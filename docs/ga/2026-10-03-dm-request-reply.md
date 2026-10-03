# DM requests stay pending until a reply — 2026-10-03

Yurucommu owns this UI change. One human owns each personal deployment; the
regression uses only a password-created owner and that owner’s API-created
persona. It does not establish a shared multi-owner service or define Yurumeet’s
ownership model. No shared Core/API, authentication policy or schema changes.

The installed Core 4.1.11 treats an incoming DM as a request until the recipient
sends a first reply. Its separate accept endpoint returns 501. Opening a request
must therefore keep its pending row and the API-provided request count; returning
without replying must show the same pending conversation. The action should say
“Open to reply” and explain that sending a reply resolves the request.

A confirmed user-DM reply refreshes the Requests list and contacts/count through
public GETs, including when the sender has already switched conversations. GETs
started before that refresh must not publish stale rows, errors or loading state.
A refused or unconfirmed send must not optimistically remove the request based
only on that response and must not trigger an automatic retry. A reply may have
committed despite an unconfirmed response; subsequent successful GETs own that
truth. Returning to the Requests tab refreshes it even if
query-only navigation preserves the page instance. The request count comes from
the contacts endpoint, not the bounded Requests list length.

Qualification requires a frozen pre-change Worker to reproduce the UI/API
mismatch and the candidate to pass the same native Chrome fixture; complete
owner gate and exact-head CI follow. Results belong to the integration handoff.
These local/native/Chrome/CI checks do not qualify actual operator data upgrades,
public TLS, real OIDC custody, live federation or managed installation lifecycle.
The existing page identity snapshot still relies on remount for actor changes;
direct persona changes without remount are outside this unit's qualification.
