# Explicit sign-out in OIDC-only deployments

Yurucommu product unit after qualified PR69. Settings called the API logout
directly, while AppMenu used the auth action that suppresses the tab's automatic
OIDC start before asynchronous sign-out. A fresh authenticated tab has no
auto-start key: after Settings revokes the session and navigates home, the login
form can immediately start OIDC again. The product must preserve the owner's
explicit sign-out and keep the visible provider link as a manual sign-in path.

Route Settings through the existing logout action, which owns suppression,
push cleanup, auth-strategy logout and transient actor/scope reset. Preserve
confirmation, duplicate-click guard and navigation. Do not add another auth
policy or change shared session revocation. Failed network logout behavior is
a separate condition; this unit qualifies successful revocation.

The AppMenu control also exposed its existing confirmation behind the menu's
z-index 60 backdrop: the portal used the default z-index 50, so a real pointer
click was intercepted. Set that caller's confirmation z-index to 70 using the
existing component option. Preserve the actual pointer interaction in the
browser fixture; forced clicks do not qualify a usable confirmation.

Require actual Chrome on the immutable PR69 Worker with a genuine session
obtained through a signed synthetic OIDC callback on fresh native D1. A fresh
independent browser context starts authenticated without the auto-start key.
Invoke Settings' real confirmation, observe successful logout and cookie
clearing, prove the old cookie is rejected and the native session removed,
and keep owner identity unchanged. The baseline must emit an unwanted real
automatic login start; bound the redirect locally rather than following it
to an external issuer. The candidate must emit none after sign-out/reload,
retain manual sign-in, and preserve AppMenu sign-out as a control path.

Retain the prior 126 ordered browser checks, run the complete product gate,
qualify the exact PR/CI tree and obtain independent source/oracle/evidence
review. Serialize test/build/native/browser launches after a fresh scan.
Preserve the original install/TCS and message-search differences and all
previous receipts. Common Core/API/schema contracts remain at their owner.

Yurucommu is a personal single-human-owner deployment; personas, community
roles and external participants are distinct. This does not define Yurumeet's
ownership model. Signed synthetic callbacks prove local session behavior,
not real issuer credential custody, token use/refresh, public installation
or live GA. Existing-data update/rollback/closed restore, initial-owner claim
atomicity, durable lost-ACK replay and deployed federation/Queue/Cron remain
separate conditions. No publication, merge, deploy, live D1 apply, new billing
or auth permissions, real-data deletion or other-worktree changes are part
of this unit. Track the work in Control TASK-0056.
