# Reading Endurance

A small, mobile-first static PWA for reading physical books or using another ebook
reader. No backend, runtime packages, accounts, telemetry, text hosting, or sample
history. All data stays in the browser.

## Run and validate

From this directory, with Python 3 and Node 22.8+ (validated with Node 24):

```sh
npm start
# Open http://localhost:8000
npm run check
npm run test:ui
```

No `npm install` is needed. `npm run check` runs syntax checks and the pure-rule
tests using Node's built-in test runner. `test:ui` additionally requires Chrome
(`google-chrome` on PATH, or set `CHROME_BIN`). It starts a loopback-only server and
an isolated temporary headless browser, then removes the profile. It uses Node's
built-in WebSocket and the Chrome DevTools Protocol; no test packages are needed.
Set `SCREENSHOT_DIR=/tmp/reading-endurance-review` to retain screenshots.

Use HTTPS or localhost. Web Locks and service workers require a secure context.
The MVP requires Web Locks to manage local state safely across tabs. The app gives
a visible explanation on unsupported browsers instead of using a racy lock.
Opening `index.html` directly as a file is not a supported way to run it. To try
it on a phone, serve these static files over HTTPS using your normal development
setup. Nothing in this project publishes or deploys a site.

## First read

Choose a cue (or Off), optionally preview it, and pick an initial Train target.
“Not sure” uses 10 minutes. Save setup, leave Two-minute start selected, and press
**Start reading**. Put the device down and read your own book. Two active minutes
meets the starting commitment; keep reading until you press **Finish**. Choose an
optional engagement report or **Save without feedback**.

Train displays a recommendation and a 2–60 minute override before starting.
Just read has no target. Neither a target nor a cue stops any session. A target
cue is separately selected for each Train read and defaults off. Confidence is
one short pulse/tone; target is two short pulses/tones. At a two-minute target,
confidence takes precedence; disabling confidence permits the target cue instead.

## Implementation and state

- `index.html`, `style.css`, `app.js`: accessible forms, calm active timer, feedback,
  progress, local data tools, platform cue delivery, and browser lifecycle handling.
- `core.js`: small pure recommendation and statistics functions, timestamp clock,
  recovery/completion transitions, strict versioned schema, and storage boundary.
- `sw.js`, `manifest.webmanifest`, `icons/`: install metadata and offline shell.
- `tests/`: controlled clock tests and dependency-free browser checks.

State is `idle → running ↔ paused → awaiting-feedback → saved` (or explicitly
discarded). A saved record represents the terminal saved state; discarding clears
the active state. Only one active object exists. A Web Lock with the same
origin-wide scope as storage allows one editor tab at a time, including while
paused or awaiting feedback. The lock is released on page hide/close, and a page
restored from the back/forward cache reacquires it and requires recovery. A second
tab explains the lock and offers retry after the first closes.

Finishing freezes duration immediately, even if feedback is supplied later.
Double completion is idempotent by session ID. State transitions persist
immediately; running checkpoints persist every five seconds and on visibility,
freeze, and page-hide events. Rotation changes no timing state.

### Timing and recovery

Within one live document, elapsed time is the sum of monotonic `performance.now()`
differences during active intervals. Interval callbacks only repaint and
checkpoint; their count does not determine duration. Paused time is excluded.
Wall timestamps record calendar dates and checkpoints, not live elapsed seconds.

On reload/unclean close, the default recovery duration is **only the last saved
active duration**. Hours since a checkpoint are never added automatically. The
reader must explicitly recover or discard and can correct the duration. Recovery
starts paused, marks uncertainty and interruption, suppresses all later cues, and
excludes that read from progression and longest engaged records. A durably finished
read reloads into pending feedback with the same frozen duration.

On some platforms the monotonic clock does not advance through system sleep. A
wall/monotonic discrepancy over two seconds marks the interval uncertain, while
preserving monotonic arithmetic. The reader must confirm/correct duration before
saving. This also handles device wall-clock adjustments without inflating or
reversing duration. Remaining cues are suppressed because an apparent future
crossing could already be stale. Timing ambiguity is retained in history.

Confidence deadline crossing and delivery attempted are separate persisted flags.
A deadline can pass with cues off or with no delivery. A cue is attempted at most
once, only while visible/running on a punctual callback (gap ≤2 seconds and ≤1.5
seconds after deadline), after persisting its attempt. Finish, lifecycle return,
delayed callbacks, and recovery never replay a cue. The app does not infer that a
request was felt or heard. A failed checkpoint write pauses the read; retry is
explicit. Failed final saves keep pending feedback and do not claim success.

### Training replay

This deterministic product heuristic uses completed Train reads with feedback.
It does not measure attention capacity, comprehension, cognition, or health.

For an uninterrupted, certain read against its actual chosen target:

- Comfortable + reached target: first success holds; two consecutive successes
  at that target add two minutes, capped at 60.
- Challenging but engaged + reached target: hold chosen target, reset count.
- Comfortable/challenging + early stop: hold chosen target, reset count.
- Lost the thread: reset; use supplied engagement estimate floored to whole
  minutes, bounded to 2 and no more than chosen target. With no estimate, subtract
  two minutes from chosen target, bounded to 2.

Interrupted, uncertain, externally stopped, unrated, and untargeted reads hold the
existing recommendation and break the success count. An eligible override holds
its chosen target and begins its own count; it never borrows successes from a
different target. Prescribed and chosen targets are stored separately. Rest days
do nothing. Manual changes are explicit target-change events and reset the count.

Replay sorts completed reads by **frozen finish timestamp**, manual changes by
their timestamp, then by the persisted unique integer `order` for equal times
(and ID as a final stable tie-break). Edits keep timestamps/order; deletes leave
order gaps. Every recommendation is recomputed from remaining history and manual
changes. Clock-adjusted calendar ordering is deterministic, not an inferred
biological timeline.

### Honest progress

Weekly totals use local calendar weeks beginning Monday and include every saved
completed read, including unrated or interrupted ones. Unfinished reads do not
enter totals. Longest engaged intervals include only certain, unpaused reads
reported Comfortable or Challenging but engaged, with separate records for each.
An uninterrupted timed interval is not proof of uninterrupted attention.

The chart shows the latest 30 saved reads chronologically with outcome labels and
striped interruption markers. Accessible history contains every saved read.
Observed continuation appears once there are two eligible reads: numerator is
completed reads reaching 12 active minutes; denominator is completed reads
reaching two active minutes. It includes cues off, suppressed, or unavailable.
Percentages appear only for five or more eligible reads. It is not cue efficacy.

### Persistence and offline limits

The version-1 JSON schema includes settings, sessions, target changes, sequence
ordering, and recoverable active state. Import checks types, ranges, IDs, order,
feedback estimates, and version before asking for replace confirmation. Unknown
fields are removed. Imports replace, not merge. Delete recalculates recommendations;
clear requires confirmation. Unreadable data is preserved until explicit reset and
can be exported verbatim. Storage failures are visible and never labeled saved.

Local storage is origin/browser/profile-specific and can be lost to browser data
clearing, eviction, private browsing, uninstall behavior, or device loss. Offline
caching does not back up reading history. Export regularly if the data matters.
No persistent-storage guarantee or cloud backup is implied.

The service worker caches only the listed shell URLs. Cache names include the
application scope; cleanup never touches another application's caches. No
`skipWaiting`, forced reload, notifications, or timer worker is used. An update
waits until all controlled app tabs close; pending state stays in local storage.
Increment the cache version in `sw.js` when releasing changed shell files, so
installed clients receive a coherent new shell. Offline launch requires a
successful first installation online. No offline guarantee is made if storage is
cleared or installation fails.

## Platform findings and remaining checks

Validation performed in this workspace:

- `npm run check`: syntax checks and 18 controlled-clock/rule/storage tests passed.
- `npm run test:ui`: 19 browser cases passed in Chrome 154, including the actual
  start/finish/feedback/recommendation flow, pause/rotation, cross-tab exclusion,
  explicit recovery, duplicate saves, skipped/edited/deleted feedback, manual
  changes, duration correction, cue collisions/cancellation, unsupported cues,
  storage failures, real JSON download/import, offline reload with pending
  feedback, and update activation after closing tabs. Unrelated caches survived.
- Inspected portrait (390×844), landscape (844×390), and desktop (1280×900)
  screenshots; checked 320px overflow, accessible button names, keyboard focus,
  touch-control sizes, and primary text contrast (5.56:1 or better).
- A second full-source review fixed queued audio resuming after suspension,
  stale asynchronous actions, hidden-field validation, skipped-estimate handling,
  duration-correction bounds, and storage-retry messaging. Affected checks passed.

Official documentation checked October 4, 2026:

- [W3C Vibration API](https://www.w3.org/TR/vibration/): visible document and user
  activation are required; implementations/device settings may suppress requests.
  API presence or a true return value does not establish hardware delivery.
- [Chrome page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api):
  hidden pages can freeze or be discarded; timers stop while frozen. A web/PWA
  cannot promise precise background or locked-screen scheduling/vibration.
- [Chrome Web Audio autoplay](https://developer.chrome.com/blog/autoplay/#web-audio):
  audio needs user activation. This app creates/resumes audio only for explicitly
  selected sound via Start, Preview, or Resume. Deadline handlers never resume
  suspended audio or queue a late tone.
- [MDN performance.now](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now#ticking_during_sleep)
  explains sleep-clock differences; uncertainty requires correction.
- [MDN service worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
  explains update waiting. Service workers do not guarantee reading cues.

Vibration is preferred only when its API is exposed; otherwise the setting falls
back to Off. Sound is never substituted. The app keeps the screen awake only if
the reader independently configures their device; it requests no wake lock.
Reliable OS-managed background/locked-screen cue scheduling would require a
native implementation and platform-specific permissions/lifecycle handling, with
device policy and silent/DND behavior still requiring validation.

Desktop checks use controlled clocks and simulated vibration/visibility; they
verify logic, not sensation. Real Android device verification remains required
for vibration and sound, volume/silent/DND behavior, screen lock, actual background
and resume/sleep arithmetic, installation, offline launch, and data durability.
Also inspect TalkBack and browser text scaling on device. No real-device pass is
claimed.
