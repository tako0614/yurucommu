# Yurucommu overlapping head poll order — 2026-10-05

The Home interval and visibility-return refresh can overlap within one feed
generation. Their 20-entry windows can partially overlap. Prepending the last
response's unseen entries to the staged buffer puts an older snapshot before
newer entries and advances the applied watermark from the wrong first entry.
The watermark update itself is monotonic; this issue under-advances it.

Keep the accepted fresh-entry union and sort it descending by the existing
`postKey` (boost publication time when present, then canonical object AP ID)
before the 100-entry staged cap. Retiring an older poll solely because a later
poll started would discard valid entries outside the later 20-entry window.
Entry identity remains `feedItemKey`, so boosts and originals remain distinct.
Reload, scope, bookmark ACK and deletion fences remain in force. This is a
Yurucommu-only transient feed change; no Core/API or ownership policy changes.

Actual Jotai/SDK deferred-fetch regressions cover both completion orders of
partially overlapping 20-entry windows, applied ordering and newest watermark,
repeat-poll deduplication, equal timestamps, distinct boosts and the newest
100-entry cap. Baseline failed three of four tests; the first focused repair
passed all 89 tests across the new file and related pagination, bookmark
lifetime, deletion and feed ACK suites. Final owner gate and browser/CI
qualification are still pending; these tests do not prove live feed behavior.

Yurucommu remains software each person deploys for their own use. Communities,
remote participants and the owner's personas do not add deployment owners.
