# Reading Endurance contributor guidance

This file governs the entire repository. There are no nested instruction files.
Use [README.md](README.md) for product rules, setup details, recovery semantics,
training replay, and platform limitations; keep those explanations there.

## Purpose and boundaries

Keep this a mobile-first static PWA that brackets reading a physical book or
using another ebook reader. Preserve the dependency-free runtime and local-only
data model. Do not introduce a backend, accounts, telemetry, text hosting, or
manufactured starter history as implementation conveniences. Do not describe
self-reported engagement as measured comprehension or cognitive/medical benefit.

| Location | Responsibility and constraint |
| --- | --- |
| `core.js` | Recommendation/statistics rules, clock transitions, schema validation, and the injected `LocalStore` boundary. Keep rules deterministic; do not import `app.js` or access browser globals here. Pass clocks/storage explicitly. |
| `app.js` | DOM rendering, delegated events, persistence orchestration, Web Locks, cue delivery, and browser lifecycle handling. Keep product calculations in `core.js`. |
| `index.html`, `style.css` | Static shell, accessible controls, responsive layout, and visual conventions. |
| `sw.js` | Scoped offline app-shell caching only; never use it to schedule reading cues or store reading history. |
| `manifest.webmanifest`, `icons/` | Install metadata and checked-in SVG/PNG assets. Preserve valid paths and the declared 192/512-pixel PNG dimensions. There is no tracked icon-generation script. |
| `tests/core.test.js` | Node built-in tests with explicit clocks and injected storage. |
| `tests/browser.mjs` | Dependency-free Chrome DevTools Protocol checks through the actual UI, using isolated browser contexts and a temporary profile. |
| `README.md` | Authoritative behavior, timing/schema explanations, run instructions, and device-verification limitations. |

There is no generated build-output directory. Serve the checked-in files directly;
do not treat the PNG assets as disposable build output.

## Commands and completion checks

Use Python 3 and Node 22.8+ as documented in the README (development was validated
with Node 24). No `npm install` is needed.

| Command | Use |
| --- | --- |
| `npm start` | Python static server on `127.0.0.1:8000`. Use HTTPS or localhost; `file://` and insecure phone LAN URLs do not provide the required secure browser context. |
| `npm test` | Pure-rule/clock/storage tests using Node's built-in runner; new unit tests must match `tests/*.test.js`. |
| `npm run check` | JavaScript syntax checks and unit tests; run after application JavaScript or unit-test changes. |
| `npm run test:ui` | Run after application behavior, HTML/CSS, service worker, manifest/assets, or browser-harness changes. Requires `google-chrome` on PATH or `CHROME_BIN`; uses a loopback server and temporary browser profile. |

No separate build, lint, format, type-check, packaging command, dependency lockfile,
or CI workflow exists. Do not invent such checks in completion reports.
For documentation-only changes, verify referenced paths, commands, and behavior
against their sources and run `git diff --check`; browser tests are not required.

When changing rules or transitions, extend controlled-clock tests for the changed
boundary and retain coverage for pause arithmetic, deadline crossing, duplicate
completion, recovery, storage failures, overrides, and edited/deleted history.
Browser changes must retain the start/finish/feedback/next-recommendation flow,
cross-tab exclusion, offline pending-feedback reload, and safe update checks.

For UI changes, inspect Android portrait/landscape and desktop layouts, keyboard
focus, accessible names, touch targets, and overflow. Keep the ticking timer's
`aria-live="off"`, readable history alongside the chart, and reduced-motion support.
Headless vibration/visibility simulations do not verify real cue sensation, silent
or DND behavior, screen lock, installation, or offline launch on a phone. Report
remaining device checks as described in the README.

## Coding and data conventions

- Use browser-native ES modules with relative imports, two-space JavaScript
  indentation, single-quoted strings, semicolons, camelCase functions/fields,
  PascalCase classes, and uppercase constants. Avoid unrelated formatting churn.
- Extend the existing forms and `data-action`/`data-view` event delegation. When
  changing IDs or selectors, update the browser harness together with the UI.
- Use milliseconds for `activeMs` and clock arithmetic; minute-valued targets and
  engagement estimates are separate fields. Preserve persisted enum values in
  `MODES`, `OUTCOMES`, and `CUES`; they are schema values, not display copy.
- Escape imported or user-controlled strings before inserting them into HTML
  templates. Validate and normalize imported JSON before any replacement write.
- Coordinate schema changes across `VERSION`, `STORAGE_KEY`, `validateData()`,
  import/export handling, tests, and README documentation. Preserve old/unreadable
  data with an explicit unsupported-data path rather than silently resetting it.

## Critical invariants

- Keep one active session, including paused reads and pending feedback. Keep the
  Web Lock's scope identical to the origin-wide storage key; do not replace it
  with a racy cross-tab flag. Persist transitions promptly and complete by ID
  without duplicate records. Confirm before replacing/discarding active state.
- Derive active duration from monotonic timestamp differences, excluding pauses;
  interval callbacks only refresh/checkpoint. Finish must freeze time immediately
  and remain available while paused. Recovery must require duration confirmation,
  never add time since a crash automatically, and retain uncertainty/interruption.
- Attempt the confidence cue at most once at 120 active seconds. Keep deadline
  passed separate from delivery attempted. Never replay missed cues after finish,
  recovery, suspension, or clock ambiguity. Preview must not start a session.
- Sound requires explicit selection and a user gesture; unavailable vibration
  falls back to Off, never to sound. Target cues default off and must not collide
  with confidence at a two-minute target. Cancel queued audio before suspension
  so a later Resume cannot replay it. Do not promise exact background/locked-screen
  delivery or keep the screen awake by default.
- Two-minute start has no longer hidden target; reaching any target never ends
  reading automatically. Keep Train recommendations bounded to whole 2–60 minutes
  without capping the reader's session duration.
- Recompute recommendations through `recommend()` from chronological saved reads
  and explicit manual target changes. Preserve prescribed/chosen targets, stable
  timestamp/order tie handling, and separate override success counts. Untargeted,
  interrupted, uncertain, externally stopped, or unrated reads must leave the
  recommendation unchanged and break the success count. Follow the exact heuristic
  in the README rather than adding a second rule path or inferred attention-capacity
  model.
- Preserve honest statistics: paused segments are not continuous reading;
  unfinished reads are not totals. Longest-engaged records require certain,
  unpaused Comfortable or Challenging feedback. Continuation includes cues off or
  missed, shows counts, and uses no percentages below five eligible reads. Do not invent a skipped
  engagement estimate or infer cue effectiveness.
- Keep failed writes visible, pause an affected running read, retain pending
  feedback, and announce success only after persistence succeeds. Import replace,
  session deletion, and clear-data actions require confirmation; corrupt data
  must remain available until explicit reset.
- Cache only listed shell URLs and delete only caches bearing this application's
  scope prefix. Keep `SHELL`, relative imports, and manifest/icon paths in sync
  when adding or removing application assets. Never add `skipWaiting` or forced
  reloads that disrupt reading or pending feedback. Bump the cache version for
  releases with changed shell files;
  update the hardcoded old/new-version fixture and assertions in
  `tests/browser.mjs` when changing that version or its spelling.

## Repository hygiene and change scope

Keep credentials out of browser-served files and reading data local.
Do not use a reader's regular browser profile or real reading exports as test
fixtures. Keep profiles, downloads, screenshots, logs, `test-results/`, and
`node_modules/` out of commits; the UI harness cleans up its temporary profile.
Use `SCREENSHOT_DIR` outside the repository when retaining visual checks.

No repository-specific branch, commit-message, or release-automation convention
is established. Keep changes scoped to the task, preserve unrelated edits, and
update the README when documented behavior, schema, or commands change. Before
finishing, review the diff for timer/state regressions, misleading measurements,
and added machinery; report the checks actually run and any remaining limitations.
