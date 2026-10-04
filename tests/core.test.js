import test from 'node:test';
import assert from 'node:assert/strict';
import { newSession, ReadingClock, recoverSession, completeSession, recommend, statistics,
  emptyData, validateData, LocalStore, STORAGE_KEY } from '../core.js';

function live(options = {}) {
  const session = newSession({ id: 'active', owner: 'tab-a', mode: 'train', target: 10,
    prescribed: 10, cue: 'vibration', confidenceEnabled: true, targetCue: false, wall: 1000000, ...options });
  return { session, clock: new ReadingClock(session, 0, 1000000) };
}
function record(options = {}) {
  const data = emptyData();
  const { session, clock } = live({ cue: 'off' });
  clock.finish(600000, 1600000);
  data.active = session;
  return { ...completeSession(data, 'comfortable', null).sessions[0], ...options };
}
function records(list) {
  return list.map((options, index) => record({ id: `session-${index}`, order: index + 1,
    finishedAt: 1600000 + index * 1000000, ...options }));
}

test('timestamp arithmetic excludes pauses, can finish paused, and freezes immediately', () => {
  const { session, clock } = live();
  clock.sample(15000, 1015000);
  clock.pause(25000, 1025000);
  clock.pause(30000, 1030000); // double tap
  clock.sample(90000, 1090000);
  assert.equal(session.activeMs, 25000);
  assert.equal(session.interruptions, 1);
  clock.resume(100000, 1100000);
  clock.sample(130000, 1130000);
  clock.pause(135000, 1135000);
  clock.finish(200000, 1200000);
  clock.finish(300000, 1300000);
  clock.sample(400000, 1400000);
  assert.equal(session.activeMs, 60000);
  assert.equal(session.finishedAt, 1200000);
  assert.equal(session.state, 'awaiting-feedback');
});

test('one confidence attempt at active deadline; target never ends a session', () => {
  const { session, clock } = live({ target: 2, targetCue: true });
  clock.sample(119000, 1119000); // delayed callback before deadline
  assert.deepEqual(clock.sample(120000, 1120000), ['confidence']);
  assert.deepEqual(clock.sample(121000, 1121000), []);
  assert.equal(session.confidence.passed, true);
  assert.equal(session.confidence.attempted, true);
  assert.equal(session.targetSignal.passed, true);
  assert.equal(session.targetSignal.attempted, false);
  assert.equal(session.state, 'running');
});

test('target signal can replace confidence at two minutes, or occur separately later', () => {
  const targetOnly = live({ target: 2, targetCue: true, confidenceEnabled: false });
  targetOnly.clock.sample(119000, 1119000);
  assert.deepEqual(targetOnly.clock.sample(120000, 1120000), ['target']);
  assert.equal(targetOnly.session.confidence.attempted, false);
  const later = live({ target: 3, targetCue: true });
  later.clock.sample(119000, 1119000);
  assert.deepEqual(later.clock.sample(120000, 1120000), ['confidence']);
  later.clock.sample(179000, 1179000);
  assert.deepEqual(later.clock.sample(180000, 1180000), ['target']);
  assert.deepEqual(later.clock.sample(181000, 1181000), []);
});

test('deadline and delivery attempt are distinct when off, hidden, resumed, late or finishing', () => {
  for (const kind of ['off', 'hidden', 'resumed', 'late', 'finish']) {
    const { session, clock } = live({ cue: kind === 'off' ? 'off' : 'vibration' });
    clock.sample(119000, 1119000);
    if (kind === 'finish') clock.finish(120000, 1120000);
    else assert.deepEqual(clock.sample(kind === 'late' ? 130000 : 120000, kind === 'late' ? 1130000 : 1120000,
      { visible: kind !== 'hidden', resumed: kind === 'resumed' }), []);
    assert.equal(session.confidence.passed, true, kind);
    assert.equal(session.confidence.attempted, false, kind);
    assert.deepEqual(clock.sample(131000, 1131000), [], kind);
  }
});

test('paused time cannot cross the confidence deadline', () => {
  const { session, clock } = live();
  clock.pause(119000, 1119000);
  assert.deepEqual(clock.sample(500000, 1500000), []);
  assert.equal(session.confidence.passed, false);
  clock.resume(600000, 1600000);
  assert.deepEqual(clock.sample(601000, 1601000), ['confidence']);
});

test('wall clock changes do not inflate or reverse active duration; uncertainty suppresses cue', () => {
  for (const wall of [1000, 99999999]) {
    const { session, clock } = live();
    clock.sample(119000, 1119000);
    assert.deepEqual(clock.sample(120000, wall), []);
    assert.equal(session.activeMs, 120000);
    assert.equal(session.uncertain, true);
  }
});

test('recovery uses confirmed duration, excludes downtime, and suppresses all remaining cues', () => {
  const { session } = live({ target: 5, targetCue: true });
  session.activeMs = 60000;
  const recovered = recoverSession(session, 90000, 'tab-b', 999999999);
  assert.equal(recovered.activeMs, 90000);
  assert.equal(recovered.interruptions, 1);
  assert.equal(recovered.uncertain, true);
  assert.equal(recovered.state, 'paused');
  const clock = new ReadingClock(recovered, 0, 999999999);
  clock.resume(100000, 1000099999);
  clock.sample(129000, 1000128999);
  assert.deepEqual(clock.sample(130000, 1000129999), []);
  clock.sample(309000, 1000308999);
  assert.deepEqual(clock.sample(310000, 1000309999), []);
  assert.equal(recovered.confidence.passed, true);
  assert.equal(recovered.targetSignal.passed, true);
});

test('sleep-clock ambiguity before the deadline suppresses later apparent crossings', () => {
  const { session, clock } = live({ target: 3, targetCue: true });
  clock.sample(60000, 1060000);
  clock.sample(60000, 2860000, { resumed: true }); // wall advances through sleep; monotonic does not
  assert.equal(session.activeMs, 60000);
  assert.equal(session.uncertain, true);
  clock.sample(119000, 2919000);
  assert.deepEqual(clock.sample(120000, 2920000), []);
  clock.sample(179000, 2979000);
  assert.deepEqual(clock.sample(180000, 2980000), []);
  assert.equal(session.confidence.attempted, false);
  assert.equal(session.targetSignal.attempted, false);
});

test('duplicate completion cannot duplicate records, feedback estimates are optional and constrained', () => {
  const data = emptyData();
  const { session, clock } = live();
  data.active = session;
  assert.equal(completeSession(data, null, null), null);
  clock.finish(121000, 1121000);
  assert.throws(() => completeSession(data, 'lost', 3));
  assert.throws(() => completeSession(data, 'lost', -1));
  const saved = completeSession(data, 'lost', null);
  assert.equal(saved.sessions[0].engagedMinutes, null);
  assert.equal(saved.sessions[0].activeMs, 121000);
  assert.equal(completeSession(saved, 'lost', null), null);
  assert.equal(completeSession({ ...saved, active: session }, 'lost', null), null);
});

test('two comfortable successes at a chosen target add two minutes with ceiling', () => {
  assert.equal(recommend(10, records([{}])).target, 10);
  assert.equal(recommend(10, records([{}, {}])).target, 12);
  assert.equal(recommend(10, records([{}, {}, { targetMinutes: 12, activeMs: 720000 }])).target, 12);
  assert.equal(recommend(59, records([{ targetMinutes: 59, activeMs: 3600000 }, { targetMinutes: 59, activeMs: 3600000 }])).target, 60);
  assert.equal(recommend(60, records([{ targetMinutes: 60, activeMs: 3600000 }, { targetMinutes: 60, activeMs: 3700000 }])).target, 60);
});

test('challenging and early outcomes hold the chosen target and reset the comfortable count', () => {
  for (const middle of [{ outcome: 'challenging' }, { activeMs: 599999 }, { outcome: 'challenging', activeMs: 10000 }]) {
    const result = recommend(10, records([{}, middle, {}]));
    assert.equal(result.target, 10);
    assert.equal(result.comfortableCount, 1);
  }
});

test('lost thread uses floor of supplied estimate, bounds at two and chosen target', () => {
  for (const [estimate, expected] of [[null,8], [7.9,7], [0,2], [1.9,2], [15,10]]) {
    const result = recommend(10, records([{}, { outcome: 'lost', engagedMinutes: estimate, activeMs: 1000000 }]));
    assert.equal(result.target, expected);
    assert.equal(result.comfortableCount, 0);
  }
  assert.equal(recommend(2, records([{ targetMinutes: 2, outcome: 'lost' }])).target, 2);
});

test('ineligible sessions hold recommendation, break success count, and do not regress', () => {
  for (const middle of [{ interruptions: 1 }, { uncertain: true }, { outcome: 'external' },
    { outcome: null }, { mode: 'start', targetMinutes: null }, { mode: 'free', targetMinutes: null }]) {
    const result = recommend(10, records([{}, { ...middle, activeMs: 10000, targetMinutes: middle.targetMinutes ?? 2 }, {}]));
    assert.equal(result.target, 10);
    assert.equal(result.comfortableCount, 1);
  }
});

test('override starts its own count without borrowing a shorter success', () => {
  const history = records([{}, { targetMinutes: 20, activeMs: 1200000 }]);
  assert.equal(recommend(10, history).target, 20);
  assert.equal(recommend(10, history).comfortableCount, 1);
  history.push(record({ id: 'third', order: 3, finishedAt: 3600000, targetMinutes: 20, activeMs: 1200000 }));
  assert.equal(recommend(10, history).target, 22);
});

test('edits, deletes and manual changes replay deterministically; timestamp ties use order', () => {
  const history = records([{}, {}]);
  assert.equal(recommend(10, history).target, 12);
  assert.equal(recommend(10, [{ ...history[0], outcome: 'challenging' }, history[1]]).target, 10);
  assert.equal(recommend(10, history.slice(1)).target, 10);
  const change = { kind: 'target', id: 'manual', at: history[1].finishedAt, order: 3, target: 30 };
  assert.equal(recommend(10, [...history].reverse(), [change]).target, 30);
  assert.equal(recommend(10, history, [{ ...change, at: history[0].finishedAt, order: 3 }]).target, 10);
  assert.equal(recommend(10, [], [change]).target, 30);
});

test('honest records exclude interrupted, uncertain and unrated reads; totals retain them', () => {
  const now = new Date(2026, 9, 4, 12);
  const history = records([
    { activeMs: 720000 }, { activeMs: 900000, outcome: 'challenging' },
    { activeMs: 9999999, interruptions: 1 }, { activeMs: 9999999, uncertain: true },
    { activeMs: 9999999, outcome: null }, { activeMs: 10000, outcome: 'external' }
  ]).map(s => ({ ...s, finishedAt: +now - 1000 }));
  const stats = statistics(history, now);
  assert.equal(stats.comfortableMs, 720000);
  assert.equal(stats.challengingMs, 900000);
  assert.equal(stats.weekCount, 6);
  assert.equal(stats.weekMs, 31629997);
  assert.deepEqual(stats.continuation, { numerator: 5, denominator: 5 });
  history[0].finishedAt = +new Date(2026, 8, 27, 23, 59);
  assert.equal(statistics(history, now).weekCount, 5);
  assert.deepEqual(statistics([], now).continuation, { numerator: 0, denominator: 0 });
});

test('versioned schema round trip, duplicate IDs/orders, unsupported version and invalid values', () => {
  const data = emptyData();
  data.sessions = records([{}, { outcome: 'lost', engagedMinutes: null }]);
  data.nextOrder = 3;
  assert.deepEqual(validateData(JSON.parse(JSON.stringify(data))), data);
  for (const mutate of [d => d.version = 2, d => d.sessions[0].activeMs = -1,
    d => d.sessions[1].id = d.sessions[0].id, d => d.sessions[1].order = d.sessions[0].order,
    d => d.sessions[0].engagedMinutes = 99, d => d.settings.cue = 'automatic',
    d => d.sessions[0].targetMinutes = 61, d => d.nextOrder = 1]) {
    const invalid = structuredClone(data); mutate(invalid);
    assert.throws(() => validateData(invalid));
  }
  const unknown = structuredClone(data); unknown.untrusted = '<script>'; unknown.settings.extra = true;
  assert.deepEqual(validateData(unknown), data);
});

test('blocked, unavailable, corrupt and failed storage never masquerade as a successful save', () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const store = new LocalStore(storage);
  assert.deepEqual(store.load(), emptyData());
  store.save(emptyData());
  assert.deepEqual(store.load(), emptyData());
  memory.set(STORAGE_KEY, '{broken');
  assert.throws(() => store.load());
  assert.equal(memory.get(STORAGE_KEY), '{broken');
  const blocked = new LocalStore({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } });
  assert.throws(() => blocked.load());
  assert.throws(() => blocked.save(emptyData()));
});
