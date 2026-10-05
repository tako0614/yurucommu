# Recoverable Story video preparation

Selecting a video must not leave the composer permanently busy when browser
metadata or FFmpeg worker initialization never responds. Metadata inspection
has a15-second deadline and can be cancelled when the composer closes or its
editing scope is retired. Its temporary object URL and handlers are released
once; late events do not change a settled result. Valid durations are capped at
60 seconds, while unusable metadata retains the existing five-second fallback.

All callers joining an FFmpeg initialization share a60-second deadline covering
downloads and worker startup. Failure terminates that attempt's worker, releases
its downloaded Blob URLs and permits a fresh initialization. A late result from
an earlier attempt cannot replace or reset the new instance. Settled timeout
timers are cleared. Successful initialization remains a shared module cache.

The composer reports preparation failure and permits selection again. It keeps
caption and restores the preceding canvas background after FFmpeg failure,
including when one video replaces another during startup. The mounted preview
passes its DOM reference through a callback rather than assigning read-only
Solid props; this prevents a render exception from discarding the composer.
Metadata selection applies only to its original mounted canvas/editing scope;
closing cancels inspection rather than adopting a late preview into disposed
state. These controls concern preparation. They do not promise that a timed-out
video export was cancelled or qualify all codec/device combinations.

Native release-browser qualification exposed a competing focus restoration:
the result surface received focus, then the dialog restored the now-inert
editor's fallback root. The shared dialog now resolves the settled result after
DOM updates and owns that transition. A reopened or hydrated result uses the
same target; safe return to editing keeps its captured editor. Qualification
retains the lost-ACK focus assertion and checks reopened/reloaded result focus,
Tab confinement, Escape from a retry confirmation, and safe editor restoration.

Regression tests exercise the real utility in isolated child processes with
scaled timers and controlled browser/FFmpeg boundaries. Built-app qualification
uses actual MP4 decoding and FFmpeg WASM with public pinned package bytes served
from a private loopback fixture; HTTP API responses remain synthetic. Neither
fixture qualifies public CDN availability, real authentication, live Worker/D1/R2,
existing-data update/restore, mobile devices or full GA.

Yurucommu remains individually deployed single-owner software. This product
change does not alter shared Core, server schema, package pins, Yurumeet's
ownership model or the immutable v2.3.0 release.
