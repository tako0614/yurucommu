# Profile follow-list request ownership — 2026-10-04

A profile route load was fenced, but followers/following modal reads were not.
An old head or pagination response could replace a reopened list, switch its
profile/type, show a retired error, or clear the current loading indicator.
Comparing only the target ID/type does not handle A→B→A or close/reopen.

Give each opening/retry/pagination request an epoch tied to the current profile
load, captured actor ID and modal type. Close, profile reload and cleanup retire
that epoch. Guard success, failure and finally before updating list/error/busy
state. Reset list state on close/reload and forbid pagination during head loading.

The native Worker/Chrome fixture uses one local human owner and two native
owner-linked personas. Remote communication peers are seeded in actor_cache,
not local owners. It holds successful native GET bytes while the SPA changes
profile/type, closes and reopens the same modal, returns A→B→A, or starts a new
head and pagination while old pagination is pending. Per-fetch IDs, status and body hashes
observe exact response consumption; URL equality alone is insufficient for
same-URL retry. Two explicitly synthetic 503s exercise retired failure/finally
and ordinary retry, whose successful response comes from the native Worker.
The held-head navigation uses delegated anchor handling with a document marker;
settled list navigation also uses rendered profile links.

This slice changes no Core/API contract, dependency, schema, authentication or
single-owner policy. Native seeds use 108 accepted Follow edges, 106 cached
remote actors, one owner, two personas and one session. Browser proof is local
and disposable, not public federation, existing-data update or operator install
proof. Pending community mutations and other profile action races are separate
work. Core publication/adoption and Yurucommu's atomic single-owner opt-in,
operator update/restore, real issuer custody and public environment remain
family GA dependencies. No premise is extended to Yurumeet or generic Core.
