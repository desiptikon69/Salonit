import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// This suite truncates tables. Never infer its destination from DATABASE_URL.
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw new Error('TEST_DATABASE_URL is required; no production fallback is allowed.');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname) !== '/salonit_test') {
  throw new Error('Integration tests require the dedicated salonit_test database.');
}
const env = { ...process.env, DATABASE_URL: raw, APP_MODE: 'demo' };
const migrate = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/migrate.ts')], { env, stdio: 'inherit', windowsHide: true });
if (migrate.error) throw migrate.error;
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
const tests = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/integration', ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
if (tests.error) throw tests.error;
process.exitCode = tests.status ?? 1;
