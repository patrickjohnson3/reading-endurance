import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '..');
const directoryVariables = ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'NPM_CONFIG_CACHE', 'NODE_COMPILE_CACHE'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reading-endurance-isolation-test-'));
  const scratch = join(root, 'scratch');
  const screenshots = join(root, 'screenshots');
  await mkdir(scratch); await mkdir(screenshots);
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    SCREENSHOT_DIR: screenshots, ISOLATION_PROBE_FILE: join(root, 'probe.json'),
    // Keep the Node driver from populating a cache before the entry point runs.
    NODE_DISABLE_COMPILE_CACHE: '1' };
  for (const name of directoryVariables) {
    env[name] = join(root, name);
    await mkdir(env[name]);
    await writeFile(join(env[name], 'keep.txt'), 'user-owned sentinel');
  }
  for (const name of ['NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG']) {
    env[name] = join(root, name);
    await writeFile(env[name], 'user-owned configuration');
  }
  env.npm_config_userconfig = env.NPM_CONFIG_USERCONFIG;
  env.NPM_CONFIG_UPDATE_NOTIFIER = env.npm_config_update_notifier = 'true';
  const executable = join(root, 'npm');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const names = ${JSON.stringify(directoryVariables.concat('TMPDIR'))};
const directories = Object.fromEntries(names.map(name => [name, process.env[name]]));
const configuration = Object.fromEntries(['NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG'].map(name =>
  [name, {path: process.env[name], contents: fs.readFileSync(process.env[name], 'utf8')}]));
for (const directory of Object.values(directories)) {
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'probe.txt'), 'launcher side effect');
}
fs.writeFileSync(process.env.ISOLATION_PROBE_FILE, JSON.stringify({directories, configuration,
  inheritedUserconfig: process.env.npm_config_userconfig,
  updateNotifier: process.env.NPM_CONFIG_UPDATE_NOTIFIER, args: process.argv.slice(2)}));
process.exit(process.argv.includes('about:blank') ? 1 : Number(process.env.ISOLATION_PROBE_EXIT || 0));
`, { mode: 0o700 });
  env.CHROME_BIN = executable;
  env.PATH = root + ':' + process.env.PATH;
  return { root, scratch, screenshots, env };
}

async function assertContained(f) {
  const probe = JSON.parse(await readFile(f.env.ISOLATION_PROBE_FILE, 'utf8'));
  for (const [name, directory] of Object.entries(probe.directories)) {
    assert.ok(directory.startsWith(f.scratch + '/'), `${name} must use owned temporary state`);
  }
  for (const name of directoryVariables) {
    assert.deepEqual(await readdir(f.env[name]), ['keep.txt'], `${name} must preserve ambient state`);
  }
  for (const [name, file] of Object.entries(probe.configuration)) {
    assert.ok(file.path.startsWith(f.scratch + '/'), `${name} must not read ambient configuration`);
    assert.equal(file.contents, '');
    assert.equal(await readFile(f.env[name], 'utf8'), 'user-owned configuration');
  }
  assert.equal(probe.inheritedUserconfig, undefined, 'Lowercase npm settings must not override isolation');
  assert.deepEqual(await readdir(f.scratch), [], 'Cleanup must include launcher state outside the browser profile');
  assert.deepEqual(await readdir(f.screenshots), [], 'Explicit screenshot output remains available');
  return probe;
}

test('browser startup isolates inherited home/configuration and cleans failed-launch writes', async () => {
  const f = await fixture();
  try {
    const result = spawnSync(process.execPath, [join(repository, 'tests/browser.mjs')], {
      env: f.env, encoding: 'utf8', timeout: 20000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Chrome exited 1/);
    await assertContained(f);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('validation isolates state before npm starts and cleans its writes', async () => {
  const f = await fixture();
  try {
    const result = spawnSync(process.execPath, [join(repository, 'tests/validate.mjs'), 'check'], {
      env: f.env, encoding: 'utf8', timeout: 20000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const probe = await assertContained(f);
    assert.deepEqual(probe.args, ['run', 'check'], 'The isolated entry must run the canonical npm check');
    assert.equal(probe.updateNotifier, 'false', 'Validation must disable npm registry update checks');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('validation preserves npm failure status and cleans failed-command writes', async () => {
  const f = await fixture();
  try {
    const result = spawnSync(process.execPath, [join(repository, 'tests/validate.mjs'), 'test'], {
      env: { ...f.env, ISOLATION_PROBE_EXIT: '7' }, encoding: 'utf8', timeout: 20000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    const probe = await assertContained(f);
    assert.deepEqual(probe.args, ['test']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
