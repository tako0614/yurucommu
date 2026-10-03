# Release browser pending logout clock — 2026-10-03

During v2.3.0 preparation, PR79 CI37136350111 passed the complete owner gate
but failed the AppMenu pending-Escape browser assertion. The immutable-v2.2.0
update step was not run. Publication and merge stayed stopped.

The canonical local browser then recorded a still-visible, disabled confirmation
but zero intercepted POSTs after Escape. The fixture had returned the
`fixed503Entered` resolver function instead of its `fixed503Request` Promise.
`Promise.race` therefore advanced before the route was entered. The return
value now exposes the Promise, so the pending assertions wait for actual POST
interception. The original CI's combined assertion did not record which
predicate failed, so its exact cause remains unmeasured.

The release edits did not change the Worker bytes. A focused diagnostic of the
same local artifact passed normally. Injecting a 16-second driver delay after
observing disabled confirmation buttons reproduced the same assertion failure
twice: the application's 15-second request deadline elapsed, authentication was
observed again, both controls became enabled, and Escape legitimately closed
the confirmation. The document listener trace showed the parent menu ignoring
Escape and the confirmation handling it; one logout POST remained. This proves
a harness mechanism, not the unrecorded timing of the original CI failure.

The held-503 browser cases now install Playwright's clock before application
timers exist, pause it after observing the intercepted logout request, and
advance only 200ms while asserting pending Escape behavior. DOM observation
uses bounded driver-side polling because browser rAF/timers are paused. The
assertion still requires a visible confirmation, exactly one POST and disabled
confirm/cancel controls after a real Escape key. Clock resume runs in `finally`;
the subsequent 503, visible error and explicit retry use the running clock.
The committed-response-loss case keeps its normal clock. No application timeout,
auth code, source dependency or Worker bytes change.

A probe with the driver deadline extended to 30s (only the private probe) keeps
the application deadline at 15s and delays the driver for 16s. The old fixture
fails; the clock-controlled fixture retains the pending UI and completes the
real 503/explicit-retry flow. A first probe also exposed the independent 15s
driver response deadline; that failed diagnostic is retained. The shipped
fixture's driver deadline remains 15s. Final full owner/browser and exact-tree CI
results belong to the release handoff; a successful rerun alone is not causal
proof of the original runner failure. Live/GA dependencies remain separate.
