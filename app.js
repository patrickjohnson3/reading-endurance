import { CUES, OUTCOMES, STORAGE_KEY, LocalStore, emptyData, validateData, newSession,
  ReadingClock, recoverSession, completeSession, recommend, statistics, ordered } from './core.js';

const $ = selector => document.querySelector(selector);
const main = $('#main');
const dialog = $('#dialog');
const supportedBrowser = !!navigator.locks && typeof globalThis.crypto?.randomUUID === 'function';
const owner = supportedBrowser ? crypto.randomUUID() : null;
// The lock and data share origin-wide scope, including installations at different paths.
const lockName = STORAGE_KEY;
const vibrationAvailable = typeof navigator.vibrate === 'function';
const Audio = window.AudioContext || window.webkitAudioContext;
const modeNames = { start: 'Two-minute start', train: 'Train', free: 'Just read' };
const outcomeNames = { comfortable: 'Comfortable', challenging: 'Challenging but engaged', lost: 'Lost the thread', external: 'Stopped for another reason' };
let db = emptyData();
let store;
let clock = null;
let view = 'read';
let mode = 'start';
let locked = false;
let acquiring = false;
let releaseLock;
let corrupt = false;
let storageFailed = false;
let needsRecovery = false;
let lastPersist = 0;
let audio = null;
const audioNodes = new Set();
let dialogReturnFocus;

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const minutes = ms => (ms / 60000).toLocaleString(undefined, { maximumFractionDigits: 1 });
const timestamp = time => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const readDescription = session => `${minutes(session.activeMs)} min · ${modeNames[session.mode]} · ${timestamp(session.finishedAt)}`;
const rec = () => recommend(db.settings.initialTarget, db.sessions, db.targetChanges).target;
function timerText(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function announce(message) {
  document.querySelectorAll('#notice, #dialog-notice').forEach(box => {
    box.textContent = message; box.hidden = !message;
  });
}
function showError(message) {
  document.querySelectorAll('#storage-error, #dialog-storage-error').forEach(box => {
    box.innerHTML = `<p>${escape(message)}</p><div class="row"><button type="button" data-action="retry-storage">Retry storage</button><button type="button" data-action="export">Export current data</button>${corrupt ? '<button type="button" class="danger" data-action="clear">Reset local data…</button>' : ''}</div>`;
    box.hidden = false;
  });
}
function clearError() {
  document.querySelectorAll('#storage-error, #dialog-storage-error').forEach(box => { box.hidden = true; });
  storageFailed = false;
}

function persist(next = db) {
  if (!locked || corrupt) return false;
  try {
    store.save(next);
    db = next;
    lastPersist = performance.now();
    clearError();
    return true;
  } catch {
    storageFailed = true;
    if (clock?.session.state === 'running') clock.pause(performance.now(), Date.now());
    showError('Local storage could not be written. This read is paused if it was running. Changes are not saved; retry or export before closing.');
    return false;
  }
}

function cueSelect(id, value) {
  return `<label class="field"><span>Reading cue</span><select id="${id}" name="cue">
    <option value="off" ${value === 'off' ? 'selected' : ''}>Off</option>
    <option value="vibration" ${!vibrationAvailable ? 'disabled' : ''} ${value === 'vibration' ? 'selected' : ''}>Subtle vibration</option>
    <option value="sound" ${!Audio ? 'disabled' : ''} ${value === 'sound' ? 'selected' : ''}>Brief sound</option>
  </select></label><p class="help">${vibrationAvailable ? 'Vibration is requested only where the browser supports it. Hardware and device settings may suppress it.' : 'Vibration is unavailable in this browser. The cue defaults to Off; sound is never substituted.'}</p>
  <button type="button" data-action="preview" data-select="${id}">Preview confidence cue</button>
  <p class="help">One short pulse or tone means “You've got this.” Preview does not start a read. Sound plays only if you explicitly select it.</p>`;
}

function renderSetup() {
  return `<p class="eyebrow">Make room for a few pages</p><h1>A little time to read.</h1>
    <p class="intro muted">Use any physical book or ebook reader. This app keeps time while you read elsewhere.</p>
    <form id="setup-form"><section class="panel"><h2>Start with two minutes</h2>
    <p>Two minutes meets the starting commitment. A single optional cue means “You've got this.” Keep reading until you choose to finish.</p>
    <p class="help">Two minutes is a design choice, not a measured threshold.</p>${cueSelect('setup-cue', vibrationAvailable ? 'vibration' : 'off')}
    <p class="help">For cues, keep this page visible and the screen unlocked. Background or locked-screen cues may be missed. The app will not keep your screen awake.</p></section>
    <section class="panel"><h2>For when you want to train</h2>
    <label class="field"><span>Initial training target</span><select name="initialTarget">
    ${[10,20,30,45,60].map(n => `<option value="${n}">${n} minutes</option>`).join('')}<option value="10">Not sure — start at 10 minutes</option></select></label>
    <p class="help">An honest starting point, adjustable later. You can always choose an untargeted read.</p></section>
    <button class="primary wide" type="submit">Use these settings</button></form>
    <p class="footer-note">Only stored on this device. No account, book entry, or questionnaire.</p>`;
}

function renderRead() {
  const target = rec();
  return `<p class="eyebrow">One read at a time</p><h1>Open your book.</h1>
    <p class="intro muted">Choose how to begin. Put your device down and read.</p>
    <form id="start-form"><fieldset class="modes"><legend>Choose a mode</legend>
    ${[['start','Two-minute start','Start with two minutes. Continue as long as you like.'],
      ['train','Train',`Recommended: ${target} minutes. Choose a target before you begin.`],
      ['free','Just read','An open-ended timer. No prescribed duration.']].map(([key,name,description]) =>
      `<label class="mode"><input type="radio" name="mode" value="${key}" ${mode === key ? 'checked' : ''}><span><strong>${name}</strong><small>${description}</small></span></label>`).join('')}</fieldset>
    <section id="train-controls" class="panel" ${mode !== 'train' ? 'hidden' : ''}>
    <label class="field"><span>Your target for this read</span><div class="row"><input name="target" id="session-target" type="number" min="2" max="60" step="1" value="${target}" ${mode !== 'train' ? 'disabled' : ''} required><span>minutes</span></div></label>
    <p class="help">Recommendation: ${target} minutes. An override is kept separately. Reaching your target never ends the read.</p>
    <label class="check"><input id="target-cue" name="targetCue" type="checkbox" ${db.settings.cue === 'off' ? 'disabled' : ''}><span>Optional target cue — two short pulses or tones</span></label>
    <p class="help" id="collision-note" hidden>At a two-minute target, only the confidence cue is used. Turn it off if you prefer the target cue.</p></section>
    <div class="panel"><p id="commitment">${mode === 'start' ? 'Two minutes counts. There is no longer target.' : mode === 'train' ? 'Read toward your chosen target; finish when you choose.' : 'Read for as long as you choose.'}</p>
    ${db.settings.cue !== 'off' ? `<label class="check"><input type="checkbox" name="confidence" id="confidence" checked><span>Confidence cue at two active minutes — “You've got this.”</span></label>
      <p class="help">Keep this page visible and the screen unlocked for cues. Browser or device settings may suppress them. Timing continues without a cue; the screen can sleep normally.</p>` : '<p class="help">Cues are off. You can choose a subtle vibration or brief sound in Settings.</p>'}</div>
    <button type="submit" class="primary wide">Start reading</button></form>`;
}

function renderActive() {
  const s = db.active;
  return `<p class="eyebrow">${modeNames[s.mode]}${s.state === 'paused' ? ' · Paused' : ''}</p>
    <h1 class="visually-title">${s.state === 'paused' ? 'Take your time.' : 'Time to read.'}</h1>
    <div class="timer" id="timer" role="timer" aria-label="Elapsed active reading time" aria-live="off">${timerText(s.activeMs)}</div>
    <p class="muted">Active reading time${s.mode === 'train' ? ` · Target ${s.targetMinutes} min` : ''}</p>
    <p class="help">${s.mode === 'start' ? 'Two minutes meets your commitment. Continue if you like.' : s.mode === 'train' ? 'Finish whenever you choose, including beyond the target.' : 'No target. Finish when you choose.'}</p>
    <div class="reading-controls"><button type="button" class="primary" data-action="finish">Finish</button>
    <button type="button" data-action="${s.state === 'paused' ? 'resume' : 'pause'}" ${storageFailed ? 'disabled' : ''}>${s.state === 'paused' ? 'Resume' : 'Pause'}</button></div>
    ${s.state === 'paused' ? '<p class="help">Paused time does not count. This read is marked interrupted.</p><button type="button" class="quiet" data-action="discard">Discard read…</button>' : ''}
    ${s.uncertain ? '<p class="help">Duration needs confirmation before saving. This read is excluded from training changes and longest engaged records.</p>' : ''}`;
}

function feedbackFields(session) {
  return `<fieldset class="feedback"><legend>How was your engagement? <span class="muted">Optional</span></legend>
    ${OUTCOMES.map(outcome => `<label><input type="radio" name="outcome" value="${outcome}" ${session.outcome === outcome ? 'checked' : ''}>${outcomeNames[outcome]}</label>`).join('')}</fieldset>
    <div class="estimate" ${session.outcome === 'lost' ? '' : 'hidden'}><label class="field"><span>Roughly how many active minutes were you still following the text? <span class="muted">Optional</span></span>
    <input type="number" name="estimate" min="0" max="${session.activeMs / 60000}" step="any" value="${session.engagedMinutes ?? ''}"></label>
    <p class="help">Between 0 and ${Math.floor(session.activeMs / 600) / 100} minutes. Leave blank if you do not know. Stopping when you lose the thread is appropriate.</p></div>`;
}

function renderFeedback() {
  const s = db.active;
  return `<p class="eyebrow">Read finished</p><h1>${minutes(s.activeMs)} minutes of reading.</h1>
    <p class="muted">${s.mode === 'start' && s.activeMs >= 120000 ? 'Your two-minute starting commitment is met.' : s.mode === 'train' && s.activeMs >= s.targetMinutes * 60000 ? 'Your chosen target is reached.' : 'This reading time can be saved.'} The timer is stopped.</p>
    ${s.interruptions ? '<p class="help">Interrupted read. Active segments are added for total time, not called continuous reading.</p>' : ''}
    <form id="feedback-form">${s.uncertain ? `<section class="panel"><p>Timing was interrupted or the device clock changed. Confirm or correct the active duration. This read will remain marked uncertain and interrupted.</p><label class="field"><span>Confirmed active minutes</span><input name="corrected" type="number" min="0" step="any" max="10080" value="${s.activeMs / 60000}" required></label></section>` : ''}
    ${feedbackFields(s)}<div class="actions"><button type="submit" class="primary">Save read</button><button type="submit" name="skip" value="yes" formnovalidate>Save without feedback</button></div></form>
    <p class="help">Your report describes engagement, not measured comprehension.</p><button class="quiet" type="button" data-action="discard">Discard read…</button>`;
}

function renderRecovery() {
  const s = db.active;
  return `<p class="eyebrow">A read was left open</p><h1>Pick up where you left off.</h1>
    <p>The last saved checkpoint has ${minutes(s.activeMs)} active minutes. Time since that checkpoint has not been added.</p>
    <p class="muted">Confirm or correct the duration you actually read. A recovered read is marked uncertain and interrupted; it will not change training or longest engaged records. Missed cues are never replayed.</p>
    <form id="recovery-form"><label class="field"><span>Active reading minutes so far</span><input type="number" name="duration" min="0" max="10080" step="any" value="${s.activeMs / 60000}" required></label>
    <div class="actions"><button type="submit" class="primary">Recover as paused</button><button type="button" data-action="discard">Discard read…</button></div></form>`;
}

function recordMarkers(s) {
  return [s.interruptions ? `∥ Interrupted (${s.interruptions})` : '', s.uncertain ? 'Uncertain duration' : ''].filter(Boolean).join(' · ');
}

function renderProgress() {
  const stats = statistics(db.sessions);
  const chronological = ordered(db.sessions);
  const shown = chronological.slice(-30);
  const max = Math.max(1, ...shown.map(s => s.activeMs));
  const continuation = stats.continuation;
  return `<p class="eyebrow">From your actual reads</p><h1>A little perspective.</h1>
    <div class="metrics"><div class="metric"><strong>${rec()} min</strong><span>Training recommendation</span></div>
    <div class="metric"><strong>${minutes(stats.weekMs)} min</strong><span>${stats.weekCount} ${stats.weekCount === 1 ? 'read' : 'reads'} this week · Monday onward</span></div>
    <div class="metric"><strong>${stats.comfortableMs ? `${minutes(stats.comfortableMs)} min` : '—'}</strong><span>Longest uninterrupted · Comfortable</span></div>
    <div class="metric"><strong>${stats.challengingMs ? `${minutes(stats.challengingMs)} min` : '—'}</strong><span>Longest uninterrupted · Challenging but engaged</span></div></div>
    <p class="help">An unpaused timer observes an uninterrupted interval, not uninterrupted attention. Longest engaged records use your feedback and exclude interrupted, uncertain, and unrated reads.</p>
    ${continuation.denominator >= 2 ? `<section class="panel"><h2>Observed continuation</h2><p>${continuation.numerator} of ${continuation.denominator} completed reads with at least two active minutes reached twelve active minutes${continuation.denominator >= 5 ? ` (${Math.round(100 * continuation.numerator / continuation.denominator)}%)` : ''}.</p><p class="help">Includes reads where a cue was off, unsupported, or missed. This does not show a cue's effectiveness or what caused you to continue.</p></section>` : ''}
    <section class="panel"><h2>Reading duration, in order</h2>${shown.length ? `<p class="help">${chronological.length > 30 ? 'Latest 30 reads. ' : ''}Bars show active time. Stripes and ∥ mark interruptions.</p>
      <ol class="chart" aria-hidden="true">${shown.map(s => `<li><div class="chart-label"><span>${timestamp(s.finishedAt)}</span><span>${minutes(s.activeMs)} min ${s.interruptions || s.uncertain ? '∥' : ''}</span></div><div class="bar ${s.outcome || 'unrated'} ${s.interruptions || s.uncertain ? 'interrupted' : ''}" style="width:${100 * s.activeMs / max}%"></div><div class="chart-label">${outcomeNames[s.outcome] || 'No feedback'}${recordMarkers(s) ? ` · ${recordMarkers(s)}` : ''}</div></li>`).join('')}</ol><p class="help">The readable history below contains every chart entry.</p>` : '<p class="muted">After your first saved read, its duration and your optional engagement report will appear here.</p>'}</section>
    <h2>History</h2>${chronological.length ? `<ol class="history">${[...chronological].reverse().map(s => `<li><div class="record-title"><strong>${minutes(s.activeMs)} min · ${modeNames[s.mode]}</strong><span>${timestamp(s.finishedAt)}</span></div>
      <p>${outcomeNames[s.outcome] || 'No feedback'}${recordMarkers(s) ? ` · ${recordMarkers(s)}` : ''}</p>
      ${s.targetMinutes !== null ? `<p>Chosen target ${s.targetMinutes} min · Prescribed ${s.prescribedTarget} min</p>` : ''}
      ${s.engagedMinutes !== null ? `<p>Following the text: about ${s.engagedMinutes} active minutes, self-reported</p>` : ''}
      <details><summary>Cue record</summary><p>Confidence deadline: ${s.confidence.passed ? 'passed' : 'not reached'}. Delivery: ${s.confidence.attempted ? 'attempted' : 'not attempted'}. ${s.targetCue ? `Target delivery: ${s.targetSignal.attempted ? 'attempted' : 'not attempted'}.` : ''} A request does not confirm that a cue was felt or heard.</p></details>
      <div class="actions"><button type="button" data-action="edit" data-id="${escape(s.id)}" aria-label="Edit feedback for ${escape(readDescription(s))}">Edit feedback</button><button type="button" data-action="delete" data-id="${escape(s.id)}" aria-label="Delete read: ${escape(readDescription(s))}">Delete…</button></div></li>`).join('')}</ol>` : '<p class="muted">No reads saved yet. Start with two minutes or simply read.</p>'}
    <details><summary>How training changes</summary><p>Two consecutive uninterrupted Comfortable reads reaching the same chosen target add two minutes, up to 60. Challenging but engaged holds that target. Early stops hold it and reset the count.</p>
    <p>Lost the thread uses an optional estimate rounded down, between two minutes and the chosen target. Without an estimate, the chosen target drops by two minutes, with a two-minute minimum.</p>
    <p>Interrupted or uncertain reads, other stopping reasons, skipped feedback, and untargeted modes leave the recommendation unchanged and break the success count. Overrides start a separate count. Rest days do not change anything.</p><p>This is a product heuristic, not an attention-span measurement.</p></details>`;
}

function renderSettings() {
  return `<p class="eyebrow">Make it work for you</p><h1>Settings.</h1>
    <form id="cue-form" class="panel"><h2>One quiet confidence cue</h2>${cueSelect('settings-cue', db.settings.cue)}
    <p class="help">Cues need this page visible and the screen unlocked. Sound, vibration, silent mode, and Do Not Disturb depend on your browser and device. A target cue is separate, default-off, and selected before a Train read.</p><button type="submit" class="primary">Save cue setting</button></form>
    <form id="target-form" class="panel"><h2>Training target</h2><p>Current recommendation: ${rec()} minutes.</p><label class="field"><span>Set a new recommendation</span><div class="row"><input type="number" name="target" min="2" max="60" step="1" value="${rec()}" required><span>minutes</span></div></label>
    <p class="help">A manual change is saved in order with your reads and resets the Comfortable count. You can keep reading beyond 60 minutes.</p><button type="submit">Set training target</button></form>
    <section class="panel"><h2>Your local data</h2><p>No sync, telemetry, or external transmission. Browser data can be cleared or evicted. Keep an export if your history matters to you.</p>
    <div class="actions"><button type="button" data-action="export">Export JSON</button><label class="file-label">Import JSON…<input class="file-input" type="file" id="import-file" accept="application/json,.json"></label></div>
    <p class="help">Versioned exports include settings, history, manual target changes, and any pending read. Import replaces local data after confirmation.</p>
    <button type="button" class="danger" data-action="clear">Clear all local data…</button></section>
    <section class="panel"><h2>Offline and installation</h2><p id="offline-status">${'serviceWorker' in navigator ? 'The app shell is cached after the first successful online visit. Offline readiness is checked below.' : 'Offline installation is unavailable in this browser.'}</p>
    <p class="help">Use your browser's Install app or Add to Home screen option if available. Updates wait until all app tabs close; they never reload a read or pending feedback.</p></section>`;
}

function render(focus = true) {
  const reading = !!db.active && !needsRecovery && ['running', 'paused'].includes(db.active.state);
  document.body.classList.toggle('reading', reading);
  $('#navigation').hidden = !!db.active || !db.settings.setup || !locked || corrupt;
  $('#navigation').querySelectorAll('button').forEach(button => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (!locked) main.innerHTML = `<h1>${supportedBrowser ? 'Open in another tab.' : 'A supported browser is needed.'}</h1><p>${supportedBrowser ? 'Only one tab can manage reading at a time. Close the other Reading Endurance tab, then try again.' : 'This browser cannot coordinate local reads safely across tabs. Use a current browser on HTTPS or localhost.'}</p><button type="button" data-action="retry-lock">Try again</button>`;
  else if (corrupt) main.innerHTML = '<h1>Local data needs attention.</h1><p>Saved data could not be read. Nothing has been overwritten. Export the original data before resetting it, or retry storage.</p>';
  else if (needsRecovery) main.innerHTML = renderRecovery();
  else if (db.active?.state === 'awaiting-feedback') main.innerHTML = renderFeedback();
  else if (reading) main.innerHTML = renderActive();
  else if (!db.settings.setup) main.innerHTML = renderSetup();
  else main.innerHTML = view === 'progress' ? renderProgress() : view === 'settings' ? renderSettings() : renderRead();
  if (focus) { main.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  if (view === 'settings') updateOfflineStatus();
  syncCollision();
}

function renderReadingInPlace(action = main.contains(document.activeElement) ? document.activeElement.dataset.action : null) {
  const { scrollX, scrollY } = window;
  render(false);
  window.scrollTo(scrollX, scrollY);
  if (action) {
    const control = main.querySelector(`[data-action="${action}"]`);
    // A storage failure disables Resume; keep Finish reachable instead.
    const available = control && !control.disabled ? control : main.querySelector('[data-action="finish"]');
    available?.focus({ preventScroll: true });
    available?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
}

function syncCollision() {
  const input = $('#session-target');
  if (!input) return;
  const collision = Number(input.value) === 2 && !!$('#confidence')?.checked;
  $('#collision-note').hidden = !collision;
  $('#target-cue').disabled = db.settings.cue === 'off' || collision;
  if (collision) $('#target-cue').checked = false;
}

function syncEstimate(form) {
  if (!form?.elements.corrected) return;
  const value = Number(form.elements.corrected.value);
  if (!Number.isFinite(value) || value < 0) return;
  form.elements.estimate.max = value;
  form.querySelector('.estimate .help').textContent = `Between 0 and ${Math.floor(value * 100) / 100} minutes. Leave blank if you do not know. Stopping when you lose the thread is appropriate.`;
}

async function prepareAudio() {
  if (!Audio) return false;
  try {
    audio ||= new Audio();
    if (audio.state === 'suspended') await audio.resume();
    return audio.state === 'running';
  } catch { return false; }
}

function deliverCue(type, selected) {
  if (document.visibilityState !== 'visible') return false;
  try {
    if (selected === 'vibration') return vibrationAvailable && navigator.vibrate(type === 'target' ? [45, 100, 45] : 45);
    if (selected !== 'sound' || audio?.state !== 'running') return false;
    const tone = offset => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = 620;
      gain.gain.setValueAtTime(0, audio.currentTime + offset);
      gain.gain.linearRampToValueAtTime(.045, audio.currentTime + offset + .015);
      gain.gain.linearRampToValueAtTime(0, audio.currentTime + offset + .12);
      oscillator.connect(gain).connect(audio.destination);
      const nodes = { oscillator, gain };
      audioNodes.add(nodes);
      oscillator.start(audio.currentTime + offset);
      oscillator.stop(audio.currentTime + offset + .13);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); audioNodes.delete(nodes); };
    };
    tone(0);
    if (type === 'target') tone(.23);
    return true;
  } catch { return false; }
}

function stopCue() {
  // No pending resume/play promises are created at a cue deadline.
  try { if (vibrationAvailable) navigator.vibrate(0); } catch { /* suppressed by browser */ }
  // Suspension alone freezes queued audio; stop/disconnect it so a later Resume cannot replay it.
  for (const { oscillator, gain } of audioNodes) {
    try { oscillator.stop(); oscillator.disconnect(); gain.disconnect(); } catch { /* already ended */ }
  }
  audioNodes.clear();
  if (audio?.state === 'running') audio.suspend().catch(() => {});
}

function openDialog(html) {
  dialogReturnFocus = document.activeElement;
  // Content outside this native dialog is inert, including the page's live regions.
  dialog.innerHTML = `${html}<div id="dialog-notice" role="status" class="notice" hidden></div><div id="dialog-storage-error" role="alert" class="notice error" hidden></div>`;
  dialog.showModal();
}
dialog.addEventListener('close', () => {
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  else main.focus({ preventScroll: true });
});
function confirmAction(title, explanation, label, action) {
  openDialog(`<h2 id="dialog-title">${escape(title)}</h2><p>${escape(explanation)}</p><form id="confirm-form"><div class="actions"><button type="button" data-action="close-dialog" autofocus>Cancel</button><button type="submit" class="danger">${escape(label)}</button></div></form>`);
  $('#confirm-form').addEventListener('submit', async event => {
    event.preventDefault();
    event.submitter.disabled = true;
    const result = await action();
    if (result !== false) dialog.close();
    else if (event.submitter.isConnected) event.submitter.disabled = false;
  });
}

function exportData() {
  try {
    const content = corrupt ? store.storage.getItem(STORAGE_KEY) : JSON.stringify(db, null, 2);
    const url = URL.createObjectURL(new Blob([content ?? ''], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `reading-endurance-${corrupt ? 'original-data' : 'v1'}.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch { announce('Data could not be exported because storage is inaccessible. Keep this page open and retry storage.'); }
}

async function startRead(form) {
  if (!locked || storageFailed || needsRecovery) return;
  if (db.active) {
    confirmAction('Replace the current read?', 'The current read or pending feedback will be discarded. Only one read can be active.', 'Discard and replace', () => {
      const next = structuredClone(db); next.active = null;
      if (!persist(next)) return false;
      clock = null; return startRead(form);
    });
    return;
  }
  const selectedMode = new FormData(form).get('mode');
  const chosen = Number(form.elements.target.value);
  if (selectedMode === 'train' && (!Number.isInteger(chosen) || chosen < 2 || chosen > 60)) return;
  // Call resume synchronously within the Start user gesture, before any asynchronous work.
  const audioReady = db.settings.cue === 'sound' ? prepareAudio() : Promise.resolve(true);
  const submit = form.querySelector('[type=submit]');
  if (submit.disabled) return;
  submit.disabled = true;
  const ready = await audioReady;
  if (!locked || db.active || !form.isConnected) return;
  if (!ready) announce('Sound is unavailable for this read. Timing will work without a cue.');
  const next = structuredClone(db);
  next.active = newSession({ id: crypto.randomUUID(), owner, mode: selectedMode,
    target: chosen, prescribed: rec(), cue: ready ? db.settings.cue : 'off',
    confidenceEnabled: !!form.elements.confidence?.checked,
    targetCue: !!form.elements.targetCue?.checked, wall: Date.now() });
  if (!persist(next)) { submit.disabled = false; return; }
  clock = new ReadingClock(db.active, performance.now(), Date.now());
  if (ready) announce('');
  render();
}

function saveFeedback(form, skip, editedId) {
  // Skipping feedback bypasses an irrelevant estimate, but duration confirmation stays required.
  if (form.elements.corrected && !form.elements.corrected.reportValidity()) return;
  const formData = new FormData(form);
  const outcome = skip ? null : (formData.get('outcome') || null);
  const estimateText = formData.get('estimate');
  const estimate = outcome === 'lost' && estimateText !== '' ? Number(estimateText) : null;
  try {
    let next;
    if (editedId) {
      next = structuredClone(db);
      const record = next.sessions.find(s => s.id === editedId);
      if (!record) return;
      record.outcome = outcome; record.engagedMinutes = estimate;
      validateData(next);
    } else {
      const data = structuredClone(db);
      if (data.active?.uncertain) {
        data.active.activeMs = Number(formData.get('corrected')) * 60000;
        data.active.interruptions = Math.max(1, data.active.interruptions);
        data.active.confidence.passed ||= data.active.activeMs >= 120000;
        data.active.targetSignal.passed ||= data.active.targetMinutes !== null && data.active.activeMs >= data.active.targetMinutes * 60000;
      }
      next = completeSession(data, outcome, estimate);
    }
    if (!next || !persist(next)) return;
    clock = null;
    if (editedId) dialog.close(); else view = 'read';
    render();
    announce(`${editedId ? 'Feedback updated' : 'Read saved'}. Training recommendation: ${rec()} minutes.`);
  } catch (error) { announce(error.message); }
}

document.addEventListener('submit', event => {
  const form = event.target;
  if (!['setup-form', 'start-form', 'cue-form', 'target-form', 'feedback-form', 'recovery-form', 'edit-form'].includes(form.id)) return;
  event.preventDefault();
  if (!locked || corrupt) return;
  const values = new FormData(form);
  if (form.id === 'setup-form' || form.id === 'cue-form') {
    const next = structuredClone(db);
    next.settings.cue = values.get('cue');
    if (!CUES.includes(next.settings.cue)) return;
    if (form.id === 'setup-form') { next.settings.setup = true; next.settings.initialTarget = Number(values.get('initialTarget')); }
    if (persist(next)) { render(); announce(form.id === 'cue-form' ? 'Cue setting saved.' : 'Ready when you are.'); }
  } else if (form.id === 'target-form') {
    const next = structuredClone(db);
    next.targetChanges.push({ kind: 'target', id: crypto.randomUUID(), at: Date.now(), order: next.nextOrder++, target: Number(values.get('target')) });
    if (persist(next)) { render(); announce('Training target saved.'); }
  } else if (form.id === 'start-form') startRead(form);
  else if (form.id === 'feedback-form' || form.id === 'edit-form') saveFeedback(form, event.submitter?.name === 'skip', form.dataset.id);
  else if (form.id === 'recovery-form') {
    const next = structuredClone(db);
    next.active = recoverSession(db.active, Number(values.get('duration')) * 60000, owner, Date.now());
    if (persist(next)) {
      needsRecovery = false; clock = new ReadingClock(db.active, performance.now(), Date.now()); render();
    }
  }
});

document.addEventListener('change', async event => {
  if (event.target.name === 'mode') {
    mode = event.target.value;
    $('#train-controls').hidden = mode !== 'train';
    $('#session-target').disabled = mode !== 'train';
    $('#commitment').textContent = mode === 'start' ? 'Two minutes counts. There is no longer target.'
      : mode === 'train' ? 'Read toward your chosen target; finish when you choose.' : 'Read for as long as you choose.';
    $('#target-cue').checked = false;
  }
  if (event.target.name === 'outcome') {
    const estimate = event.target.closest('form').querySelector('.estimate');
    estimate.hidden = event.target.value !== 'lost';
    estimate.querySelector('input').disabled = estimate.hidden;
  }
  syncCollision();
  if (event.target.name === 'corrected') syncEstimate(event.target.form);
  if (event.target.id !== 'import-file') return;
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 20000000) throw new Error('This file is too large. Choose a Reading Endurance export smaller than 20 MB.');
    const imported = validateData(JSON.parse(await file.text()));
    confirmAction('Replace local data?', `Import ${imported.sessions.length} saved reads, settings, and any pending read. Your current local data will be replaced. Export it first if you want to keep it.`, 'Replace local data', () => {
      if (!persist(imported)) return false;
      clock = null; needsRecovery = !!db.active && db.active.state !== 'awaiting-feedback';
      view = 'read'; normalizeCue(); render(); announce('Data imported.');
    });
  } catch (error) { announce(error.message || 'The JSON file could not be read. Existing data has been kept.'); }
});

document.addEventListener('input', event => {
  if (event.target.id === 'session-target') syncCollision();
  if (event.target.name === 'corrected') syncEstimate(event.target.form);
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const action = button.dataset.action;
  if (button.dataset.view && !db.active && locked && !corrupt) {
    view = button.dataset.view; announce(''); render(); return;
  }
  if (action === 'close-dialog') { dialog.close(); return; }
  if (action === 'retry-lock') { acquire(); return; }
  if (action === 'retry-storage') {
    if (corrupt) load();
    else if (persist()) {
      // Preserve unsaved form values. A failed form transaction must be submitted again.
      if (db.active && ['running', 'paused'].includes(db.active.state)) render();
      if (dialog.open && dialog.contains(button)) dialog.querySelector('[data-action="close-dialog"]').focus();
      announce('Local storage is working. Retry saving any unsaved changes.');
    }
    return;
  }
  if (action === 'export') { exportData(); return; }
  if (!locked) return;
  if (action === 'preview') {
    const selected = $(`#${button.dataset.select}`).value;
    if (selected === 'off') { announce('Cue is Off. Select vibration or sound to preview.'); return; }
    if (selected === 'sound' && !await prepareAudio()) { announce('Sound could not be enabled. Check your browser and device settings.'); return; }
    if (db.active || !button.isConnected) return;
    const requested = deliverCue('confidence', selected);
    announce(requested ? 'Preview requested. Your browser and device may suppress it.' : 'Preview could not be requested. The app still works with cues off.');
  } else if (action === 'pause' && clock) {
    clock.pause(performance.now(), Date.now()); stopCue();
    if (persist()) renderReadingInPlace('resume');
    else render();
  } else if (action === 'resume' && clock && !storageFailed) {
    const pendingClock = clock;
    if (db.active.cue === 'sound') await prepareAudio();
    if (!locked || clock !== pendingClock || db.active?.state !== 'paused') return;
    clock.resume(performance.now(), Date.now());
    if (persist()) renderReadingInPlace('pause');
    else render();
  } else if (action === 'finish' && clock) {
    clock.finish(performance.now(), Date.now()); stopCue(); persist(); render();
  } else if (action === 'discard') {
    confirmAction('Discard this read?', 'This read and its pending feedback will not be saved.', 'Discard read', () => {
      const next = structuredClone(db); next.active = null;
      if (!persist(next)) return false;
      clock = null; needsRecovery = false; stopCue(); render(); announce('Read discarded.');
    });
  } else if (action === 'edit') {
    const record = db.sessions.find(s => s.id === button.dataset.id);
    if (!record) return;
    openDialog(`<h2 id="dialog-title">Edit feedback</h2><p>${minutes(record.activeMs)} active minutes · ${timestamp(record.finishedAt)}</p>
      <form id="edit-form" data-id="${escape(record.id)}">${feedbackFields(record)}<div class="actions"><button type="button" data-action="close-dialog">Cancel</button><button type="submit" class="primary">Save feedback</button><button type="submit" name="skip" value="yes" formnovalidate>Remove feedback</button></div></form>`);
  } else if (action === 'delete') {
    const record = db.sessions.find(s => s.id === button.dataset.id);
    if (!record) return;
    confirmAction('Delete this read?', `${readDescription(record)}. The read will be removed and training will be recalculated from the remaining history.`, 'Delete read', () => {
      const next = structuredClone(db); next.sessions = next.sessions.filter(s => s.id !== record.id);
      if (!persist(next)) return false;
      render(); announce('Read deleted.');
    });
  } else if (action === 'clear') {
    confirmAction('Clear all local data?', 'All local reads, settings, pending feedback, and manual target changes will be removed. Export first if you want to keep them.', 'Clear all data', () => {
      if (!locked) return false;
      // An explicit reset is the only write allowed over unreadable data.
      try {
        const fresh = store.save(emptyData());
        db = fresh; corrupt = false; clearError(); clock = null; needsRecovery = false; mode = 'start'; view = 'read';
        stopCue(); render(); announce('Local data cleared.');
      } catch { showError('Storage is inaccessible. Local data could not be cleared.'); return false; }
    });
  }
});

function tick({ resumed = false, allowCue = true } = {}) {
  if (!locked || storageFailed || !clock || !['running', 'paused'].includes(db.active?.state)) return;
  const wasUncertain = db.active.uncertain;
  const oldPassed = `${db.active.confidence.passed}:${db.active.targetSignal.passed}`;
  const due = clock.sample(performance.now(), Date.now(), { visible: document.visibilityState === 'visible', resumed, allowCue });
  if (!wasUncertain && db.active.uncertain) announce('Duration needs confirmation before saving. This read is excluded from training changes and longest engaged records.');
  const crossed = oldPassed !== `${db.active.confidence.passed}:${db.active.targetSignal.passed}`;
  // Record attempts before delivery. A failed write suppresses delivery and pauses the read.
  const needsWrite = crossed || performance.now() - lastPersist >= 5000 || wasUncertain !== db.active.uncertain;
  if (needsWrite && !persist()) {
    // No delivery was attempted if storage prevented it. The deadline remains passed.
    due.forEach(type => { db.active[type === 'confidence' ? 'confidence' : 'targetSignal'].attempted = false; });
    renderReadingInPlace(); return;
  }
  if (allowCue && !resumed) due.forEach(type => deliverCue(type, db.active.cue));
  if ($('#timer')) $('#timer').textContent = timerText(db.active.activeMs);
  if (!wasUncertain && db.active.uncertain) renderReadingInPlace();
}
setInterval(() => tick(), 250);
document.addEventListener('visibilitychange', () => {
  tick({ resumed: true, allowCue: false });
  if (locked && db.active && !needsRecovery && !storageFailed) persist();
  if (document.visibilityState !== 'visible') stopCue();
  // Do not resume audio on return: no delayed cue can be queued by autoplay handling.
});
document.addEventListener('freeze', () => { tick({ resumed: true, allowCue: false }); if (locked && db.active && !storageFailed) persist(); stopCue(); });
document.addEventListener('resume', () => tick({ resumed: true, allowCue: false }));
window.addEventListener('pagehide', () => {
  tick({ resumed: true, allowCue: false });
  if (locked && db.active && !storageFailed) persist();
  if (dialog.open) dialog.close();
  stopCue(); clock = null; locked = false; releaseLock?.(); releaseLock = null;
});
window.addEventListener('pageshow', event => { if (event.persisted) acquire(); });

function normalizeCue() {
  if (db.settings.cue === 'vibration' && !vibrationAvailable || db.settings.cue === 'sound' && !Audio) {
    const next = structuredClone(db); next.settings.cue = 'off';
    if (persist(next)) announce('The selected cue is unavailable in this browser and has been set to Off.');
  }
}
function load() {
  try {
    store = new LocalStore(window.localStorage);
    db = store.load();
    corrupt = false; clearError(); normalizeCue();
    needsRecovery = !!db.active && db.active.state !== 'awaiting-feedback';
    clock = null; render();
  } catch {
    corrupt = true;
    showError('Local storage is blocked or contains unreadable data. Nothing has been overwritten. Retry, export the original data, or explicitly reset it.');
    render();
  }
}
function acquire() {
  if (locked || acquiring) return;
  if (!supportedBrowser) { render(); return; }
  acquiring = true;
  navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
    acquiring = false;
    if (!lock) { locked = false; render(); return; }
    locked = true;
    load();
    await new Promise(resolve => { releaseLock = resolve; });
  }).catch(() => { acquiring = false; locked = false; render(); });
}

async function updateOfflineStatus() {
  if (!$('#offline-status') || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('./');
    if (!$('#offline-status')) return;
    $('#offline-status').textContent = registration?.waiting ? 'An update is ready. It will take effect after all app tabs close. Your local data is retained.'
      : registration?.active ? 'Offline app shell is ready. Your data stays in local storage.'
      : 'Offline app shell is not ready yet. Visit once online on HTTPS or localhost.';
  } catch { if ($('#offline-status')) $('#offline-status').textContent = 'Offline app shell could not be checked.'; }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').then(registration => {
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', updateOfflineStatus);
  });
  updateOfflineStatus();
}).catch(() => announce('Offline app shell could not be installed. Reading and local history still work while this page is available.'));
acquire();
