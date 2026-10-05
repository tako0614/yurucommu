# Recoverable Story video export

An export owns a single lease from admission through preparation, encoding and
cleanup. A second export fails promptly rather than sharing fixed filesystem
paths. One four-minute deadline covers shared initialization, metadata, canvas
conversion, file reads and writes, encoding, output retrieval and deletion of
all three work files. Successful exports keep the cached worker reusable.

Cancellation while waiting for shared initialization leaves that initialization
available to its other waiters. After acquiring a worker, timeout, cancellation
or operation failure retires that worker once and clears only its matching cache
entry. Late operations cannot continue a retired pipeline or reset a new worker.
Nonzero encoder exit codes, empty output and nonbinary output fail before media
upload. Cleanup failure retires the worker instead of making stale files reusable.

The mounted composer binds export to its original principal, backend, transport
and authentication lifetime. Retirement aborts export and clears its busy state;
late progress/error/finally work cannot update the retired draft. The draft stays
available on ordinary export failure for an explicit retry. This is not server
idempotency or automatic publication retry.

Qualification uses isolated tests of the actual export utility and built-client
Chrome fixtures with real FFmpeg Worker/WASM bytes and locally pinned codec
assets. HTTP APIs in the export fixture are synthetic and deadlines are scaled.
Public CDN availability, all codec/device combinations, real issuer integration,
existing-data update/restore and public deployments remain separate requirements.
Yurucommu remains individually deployed single-owner software. Shared Core,
Yurumeet, schemas, dependency pins and the immutable v2.3.0 release are unchanged.
