import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The caller owns this directory and removes it after its child exits.
export async function isolatedEnvironment(directory, inherited = process.env) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) {
    if (/^npm_config_/i.test(name)) delete env[name];
  }
  const paths = {
    HOME: 'home', XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: 'runtime',
    TMPDIR: 'tmp', NPM_CONFIG_CACHE: 'npm-cache', NODE_COMPILE_CACHE: 'node-cache'
  };
  for (const [name, path] of Object.entries(paths)) {
    env[name] = join(directory, path);
    await mkdir(env[name], { mode: 0o700 });
  }
  env.TMP = env.TEMP = env.TMPDIR;
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(env.XDG_RUNTIME_DIR, 'unavailable-bus')}`;
  env.NPM_CONFIG_LOGS_DIR = join(env.NPM_CONFIG_CACHE, '_logs');
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  env.NPM_CONFIG_USERCONFIG = join(directory, 'user.npmrc');
  env.NPM_CONFIG_GLOBALCONFIG = join(directory, 'global.npmrc');
  await writeFile(env.NPM_CONFIG_USERCONFIG, '', { flag: 'wx' });
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '', { flag: 'wx' });
  return env;
}
