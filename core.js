// Pure product rules, state transitions and validation. All durations are milliseconds.
export const VERSION = 1;
export const MODES = ['start', 'train', 'free'];
export const OUTCOMES = ['comfortable', 'challenging', 'lost', 'external'];
export const CUES = ['off', 'vibration', 'sound'];
export const STORAGE_KEY = 'reading-endurance-v1';
export const boundTarget = value => Math.max(2, Math.min(60, Math.floor(value)));
export const ordered = events => [...events].sort((a, b) =>
  (a.finishedAt ?? a.at) - (b.finishedAt ?? b.at) || a.order - b.order || a.id.localeCompare(b.id));

export function emptyData() {
  return { version: VERSION, nextOrder: 1, settings: { setup: false, initialTarget: 10, cue: 'off' },
    sessions: [], targetChanges: [], active: null };
}

export function recommend(initialTarget, sessions, targetChanges = []) {
  let target = boundTarget(initialTarget);
  let count = 0;
  let countTarget = null;
  for (const event of ordered([...sessions, ...targetChanges])) {
    if (event.kind === 'target') {
      target = event.target;
      count = 0;
      countTarget = null;
      continue;
    }
    if (event.mode !== 'train' || event.interruptions || event.uncertain || !event.outcome || event.outcome === 'external') {
      count = 0;
      countTarget = null;
      continue;
    }
    const chosen = event.targetMinutes;
    if (countTarget !== chosen) count = 0;
    countTarget = chosen;
    target = chosen;
    if (event.outcome === 'lost') {
      target = event.engagedMinutes === null ? boundTarget(chosen - 2)
        : Math.max(2, Math.min(chosen, Math.floor(event.engagedMinutes)));
      count = 0;
    } else if (event.activeMs < chosen * 60000 || event.outcome === 'challenging') {
      count = 0;
    } else if (++count === 2) {
      target = boundTarget(chosen + 2);
      count = 0;
      countTarget = null;
    }
  }
  return { target, comfortableCount: count, countTarget };
}

export function statistics(sessions, now = new Date()) {
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
  const weekStartMs = +weekStart;
  const nowMs = +now;
  const result = { weekMs: 0, weekCount: 0, comfortableMs: 0, challengingMs: 0,
    continuation: { numerator: 0, denominator: 0 } };
  for (const s of sessions) {
    if (s.finishedAt >= weekStartMs && s.finishedAt <= nowMs) {
      result.weekMs += s.activeMs;
      result.weekCount++;
    }
    if (!s.interruptions && !s.uncertain) {
      if (s.outcome === 'comfortable') result.comfortableMs = Math.max(result.comfortableMs, s.activeMs);
      else if (s.outcome === 'challenging') result.challengingMs = Math.max(result.challengingMs, s.activeMs);
    }
    if (s.activeMs >= 120000) {
      result.continuation.denominator++;
      if (s.activeMs >= 720000) result.continuation.numerator++;
    }
  }
  return result;
}

export function newSession({ id, owner, mode, target, prescribed, cue, confidenceEnabled = true, targetCue = false, wall }) {
  return { id, owner, mode, state: 'running', startedAt: wall, checkpointAt: wall,
    finishedAt: null, activeMs: 0, interruptions: 0, uncertain: false,
    prescribedTarget: mode === 'train' ? prescribed : null,
    targetMinutes: mode === 'train' ? target : null, cue, confidenceEnabled, targetCue: mode === 'train' && targetCue,
    confidence: { passed: false, attempted: false, suppressed: false },
    targetSignal: { passed: false, attempted: false, suppressed: false } };
}

// The live clock integrates monotonic timestamp differences, never callback counts.
export class ReadingClock {
  constructor(session, mono, wall) {
    this.session = session;
    this.mono = mono;
    this.wall = wall;
  }
  sample(mono, wall, { visible = true, resumed = false, allowCue = true } = {}) {
    const s = this.session;
    const delta = Math.max(0, mono - this.mono);
    const wallDelta = wall - this.wall;
    const clockChanged = Math.abs(wallDelta - delta) > 2000;
    if (s.state === 'running') {
      s.activeMs += delta;
      // Sleep/clock ambiguity is never silently promoted to continuous engagement.
      if (clockChanged) {
        s.uncertain = true;
        // If sleep lost monotonic time, even a later apparent crossing could be stale.
        s.confidence.suppressed = true;
        s.targetSignal.suppressed = true;
      }
    }
    this.mono = mono;
    this.wall = wall;
    s.checkpointAt = wall;
    const due = [];
    const punctual = visible && !resumed && allowCue && !clockChanged && delta <= 2000 && s.state === 'running';
    const cross = (flag, deadline, enabled, type) => {
      if (flag.passed || s.activeMs < deadline) return;
      flag.passed = true;
      if (enabled && !flag.suppressed && punctual && s.activeMs - deadline <= 1500) {
        flag.attempted = true;
        due.push(type);
      }
    };
    cross(s.confidence, 120000, s.confidenceEnabled && s.cue !== 'off', 'confidence');
    // At a two-minute target the confidence signal takes precedence, even when suppressed.
    if (s.targetMinutes !== null) cross(s.targetSignal, s.targetMinutes * 60000,
      s.targetCue && s.cue !== 'off' && !(s.targetMinutes === 2 && s.confidenceEnabled), 'target');
    return due;
  }
  isCuePunctual(type, mono, wall) {
    const s = this.session;
    const delta = Math.max(0, mono - this.mono);
    const signal = type === 'confidence' ? s.confidence : s.targetSignal;
    const deadline = type === 'confidence' ? 120000 : s.targetMinutes * 60000;
    return s.state === 'running' && signal.passed && signal.attempted && !signal.suppressed &&
      Math.abs(wall - this.wall - delta) <= 2000 && s.activeMs + delta - deadline <= 1500;
  }
  pause(mono, wall) {
    if (this.session.state !== 'running') return;
    this.sample(mono, wall, { allowCue: false });
    this.session.state = 'paused';
    this.session.interruptions++;
  }
  resume(mono, wall) {
    if (this.session.state !== 'paused') return;
    this.mono = mono;
    this.wall = wall;
    this.session.state = 'running';
    this.session.checkpointAt = wall;
  }
  finish(mono, wall) {
    if (!['running', 'paused'].includes(this.session.state)) return;
    this.sample(mono, wall, { allowCue: false });
    this.session.state = 'awaiting-feedback';
    this.session.finishedAt = wall;
  }
}

export function recoverSession(session, activeMs, owner, wall) {
  return { ...structuredClone(session), activeMs, owner, checkpointAt: wall, state: 'paused',
    uncertain: true, interruptions: Math.max(1, session.interruptions),
    confidence: { ...session.confidence, passed: session.confidence.passed || activeMs >= 120000, suppressed: true },
    targetSignal: { ...session.targetSignal, passed: session.targetSignal.passed ||
      (session.targetMinutes !== null && activeMs >= session.targetMinutes * 60000), suppressed: true } };
}

export function completeSession(data, outcome, engagedMinutes) {
  const s = data.active;
  if (!s || s.state !== 'awaiting-feedback' || data.sessions.some(saved => saved.id === s.id)) return null;
  if (outcome !== null && !OUTCOMES.includes(outcome)) throw new Error('Choose a valid outcome.');
  const estimate = outcome === 'lost' ? engagedMinutes : null;
  if (estimate !== null && (!Number.isFinite(estimate) || estimate < 0 || estimate * 60000 > s.activeMs + 0.001))
    throw new Error('The estimate must fit within the recorded reading time.');
  const copy = structuredClone(data);
  const { owner, checkpointAt, state, ...record } = copy.active;
  copy.sessions.push({ ...record, kind: 'session', order: copy.nextOrder++, outcome, engagedMinutes: estimate });
  copy.active = null;
  return copy;
}

const finite = n => typeof n === 'number' && Number.isFinite(n);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const target = n => integer(n) && n >= 2 && n <= 60;
const timestamp = n => finite(n) && n >= 0 && n <= 8640000000000000;
const textId = s => typeof s === 'string' && s.length > 0 && s.length <= 120;
const signal = s => s && ['passed', 'attempted', 'suppressed'].every(k => typeof s[k] === 'boolean') && (!s.attempted || s.passed);
function checkSession(s, completed) {
  if (!s || !textId(s.id) || !MODES.includes(s.mode) || !timestamp(s.startedAt) ||
    !finite(s.activeMs) || s.activeMs < 0 || s.activeMs > Number.MAX_SAFE_INTEGER ||
    !integer(s.interruptions) || typeof s.uncertain !== 'boolean' || !CUES.includes(s.cue) ||
    typeof s.targetCue !== 'boolean' || typeof s.confidenceEnabled !== 'boolean' || !signal(s.confidence) || !signal(s.targetSignal) ||
    (s.mode === 'train' ? !target(s.targetMinutes) || !target(s.prescribedTarget)
      : s.targetMinutes !== null || s.prescribedTarget !== null || s.targetCue)) return false;
  if (completed) return s.kind === 'session' && timestamp(s.finishedAt) && integer(s.order) && s.order > 0 &&
    (s.outcome === null || OUTCOMES.includes(s.outcome)) &&
    (s.engagedMinutes === null || (s.outcome === 'lost' && finite(s.engagedMinutes) &&
      s.engagedMinutes >= 0 && s.engagedMinutes * 60000 <= s.activeMs + 0.001));
  return ['running', 'paused', 'awaiting-feedback'].includes(s.state) && textId(s.owner) &&
    timestamp(s.checkpointAt) && (s.state === 'awaiting-feedback' ? timestamp(s.finishedAt) : s.finishedAt === null);
}

// Normalize known fields only: imported unknown keys are never injected into app state.
export function validateData(value) {
  const fail = () => { throw new Error('This is not a valid Reading Endurance v1 file. Existing data has been kept.'); };
  if (!value || value.version !== VERSION || !integer(value.nextOrder) || value.nextOrder < 1 ||
    !value.settings || typeof value.settings.setup !== 'boolean' || !target(value.settings.initialTarget) ||
    !CUES.includes(value.settings.cue) || !Array.isArray(value.sessions) || !Array.isArray(value.targetChanges) ||
    value.sessions.length > 50000 || value.targetChanges.length > 50000 ||
    !value.sessions.every(s => checkSession(s, true)) ||
    !value.targetChanges.every(t => t && t.kind === 'target' && textId(t.id) && timestamp(t.at) && target(t.target) && integer(t.order) && t.order > 0) ||
    !(value.active === null || checkSession(value.active, false))) fail();
  const events = [...value.sessions, ...value.targetChanges];
  if (new Set(events.map(e => e.id)).size !== events.length || new Set(events.map(e => e.order)).size !== events.length ||
    events.some(e => e.order >= value.nextOrder) || (value.active && events.some(e => e.id === value.active.id))) fail();
  const fields = ['id', 'mode', 'startedAt', 'finishedAt', 'activeMs', 'interruptions', 'uncertain',
    'prescribedTarget', 'targetMinutes', 'cue', 'confidenceEnabled', 'targetCue', 'confidence', 'targetSignal'];
  const pick = (s, keys) => Object.fromEntries(keys.map(k => [k, k === 'confidence' || k === 'targetSignal'
    ? { passed: s[k].passed, attempted: s[k].attempted, suppressed: s[k].suppressed } : s[k]]));
  return { version: VERSION, nextOrder: value.nextOrder,
    settings: { setup: value.settings.setup, initialTarget: value.settings.initialTarget, cue: value.settings.cue },
    sessions: value.sessions.map(s => pick(s, [...fields, 'kind', 'order', 'outcome', 'engagedMinutes'])),
    targetChanges: value.targetChanges.map(t => pick(t, ['kind', 'id', 'at', 'order', 'target'])),
    active: value.active === null ? null : pick(value.active, [...fields, 'state', 'owner', 'checkpointAt']) };
}

export class LocalStore {
  constructor(storage) { this.storage = storage; }
  load() {
    const raw = this.storage.getItem(STORAGE_KEY);
    return raw === null ? emptyData() : validateData(JSON.parse(raw));
  }
  save(data) {
    const normalized = validateData(data);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }
}
