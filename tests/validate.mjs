import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedEnvironment } from './environment.mjs';

const command = process.argv[2];
if (!['test', 'check', 'test:ui'].includes(command) || process.argv.length !== 3) {
  console.error('Usage: node tests/validate.mjs <test|check|test:ui>');
  process.exitCode = 2;
} else {
  const directory = await mkdtemp(join(tmpdir(), 're-validation-'));
  try {
    const env = await isolatedEnvironment(directory);
    const child = spawn('npm', command === 'test' ? ['test'] : ['run', command], {
      cwd: resolve(import.meta.dirname, '..'), env, stdio: 'inherit'
    });
    const [code] = await once(child, 'close');
    process.exitCode = code ?? 1;
  } catch (error) {
    console.error('Validation failed:', error.message);
    process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
