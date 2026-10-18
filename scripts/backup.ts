import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('DATABASE_URL is required.');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL URL.');
const database = decodeURIComponent(url.pathname.slice(1));
if (!database || database.includes('/')) throw new Error('DATABASE_URL must name one database.');
const bundled = resolve('node_modules/@embedded-postgres/windows-x64/native/bin/pg_dump.exe');
const executable = process.env.PG_DUMP_PATH || (process.platform === 'win32' && existsSync(bundled) ? bundled : 'pg_dump');
const directory = resolve('.data/backups');
if (process.platform !== 'win32') process.umask(0o077);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const destination = resolve(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.dump`);
const sslMode = url.searchParams.get('sslmode');
const result = spawnSync(executable, ['--format=custom', '--no-owner', '--no-acl', '--file', destination], {
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
  encoding: 'utf8',
  env: {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: '15',
    ...(sslMode ? { PGSSLMODE: sslMode } : {}),
  },
});
if (result.error || result.status !== 0) {
  // Do not echo command/environment or driver messages containing connection secrets.
  throw new Error(`Backup failed (${result.error ? 'pg_dump could not start' : `exit ${result.status}`}). Check pg_dump version, connection and permissions. An incomplete archive may remain in .data/backups.`);
}
if (statSync(destination).size === 0) throw new Error('Backup archive is empty.');
console.log(`Backup created: ${destination}`);
