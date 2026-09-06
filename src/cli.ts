#!/usr/bin/env node
// ciurma init [dir] | ciurma hub [--port N] [--host H] [--dir D] [--no-worker] | ciurma worker --hub URL --token T [--name N]

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openDb } from './hub/db.js';
import { startHub } from './hub/server.js';
import { runWorker } from './worker/client.js';
import { loadDefaultRoles, DEFAULT_ROLES_DIR } from './core/roles.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type Args = { cmd: string; flags: Record<string, string | boolean>; rest: string[] };

function parse(argv: string[]): Args {
  const [cmd = 'help', ...tail] = argv;
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else rest.push(a);
  }
  return { cmd, flags, rest };
}

interface Config { token: string; port: number; host: string }

function configPath(dir: string): string { return join(dir, '.ciurma', 'config.json'); }
function dbPath(dir: string): string { return join(dir, '.ciurma', 'studio.db'); }
function rolesDir(dir: string): string { return join(dir, '.ciurma', 'roles'); }

function readConfig(dir: string): Config {
  const p = configPath(dir);
  if (!existsSync(p)) throw new Error(`no studio in ${dir}. Run: ciurma init`);
  return JSON.parse(readFileSync(p, 'utf8')) as Config;
}

function init(dir: string, flags: Args['flags']): void {
  const root = resolve(dir);
  const p = configPath(root);
  if (existsSync(p)) { console.log(`studio already exists: ${p}`); return; }
  mkdirSync(dirname(p), { recursive: true });
  const config: Config = { token: randomBytes(24).toString('hex'), port: Number(flags.port ?? 4177), host: String(flags.host ?? '127.0.0.1') };
  writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
  mkdirSync(rolesDir(root), { recursive: true });
  for (const f of readdirSync(DEFAULT_ROLES_DIR)) if (f.endsWith('.md')) copyFileSync(join(DEFAULT_ROLES_DIR, f), join(rolesDir(root), f));
  const db = openDb(dbPath(root));
  db.studio.create({ name: String(flags.name ?? basename(root)), goal: String(flags.goal ?? ''), roots: [root], budgetUsd: null });
  for (const r of loadDefaultRoles(rolesDir(root))) db.roles.upsert(r);
  db.close();
  console.log(`studio created in ${dirname(p)}; the role mandates are in ${rolesDir(root)}, edit them and restart the hub`);
  console.log(`token for remote workers and non-local browsers: ${config.token}`);
  console.log('next: ciurma hub');
}

async function hub(dir: string, flags: Args['flags']): Promise<void> {
  const root = resolve(dir);
  const config = readConfig(root);
  const port = Number(flags.port ?? config.port);
  const host = String(flags.host ?? config.host);
  const db = openDb(dbPath(root));
  // The mandates in .ciurma/roles are the product: re-read on every start so edits take effect.
  for (const r of loadDefaultRoles(existsSync(rolesDir(root)) ? rolesDir(root) : undefined)) db.roles.upsert(r);
  const uiDir = [join(HERE, 'ui'), join(HERE, '..', 'dist', 'ui')].find((d) => existsSync(join(d, 'index.html'))) ?? null;
  const h = await startHub({ db, port, host, token: config.token, uiDir });
  console.log(`ciurma hub at ${h.url}${uiDir ? '' : '  (UI not built)'}`);
  let worker: { close(): Promise<void> } | null = null;
  if (!flags['no-worker']) {
    worker = runWorker({ hubUrl: `ws://127.0.0.1:${port}/ws/worker`, token: config.token, machineName: String(flags.name ?? hostname()), log: (s) => console.log(`[worker] ${s}`) });
  }
  const stop = async () => { await worker?.close(); await h.close(); db.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function worker(flags: Args['flags']): void {
  const hubUrl = String(flags.hub ?? '');
  const token = String(flags.token ?? '');
  if (!hubUrl || !token) { console.error('usage: ciurma worker --hub ws://HOST:PORT/ws/worker --token TOKEN [--name NAME]'); process.exit(2); }
  const w = runWorker({ hubUrl, token, machineName: String(flags.name ?? hostname()), log: (s) => console.log(`[worker] ${s}`) });
  const stop = async () => { await w.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const args = parse(process.argv.slice(2));
switch (args.cmd) {
  case 'init': init(args.rest[0] ?? String(args.flags.dir ?? '.'), args.flags); break;
  case 'hub': hub(args.rest[0] ?? String(args.flags.dir ?? '.'), args.flags).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }); break;
  case 'worker': worker(args.flags); break;
  default:
    console.log('ciurma: run a crew of Claude Code agents as a research lab\n\n  ciurma init [dir]                 create a studio (roles, token, database)\n  ciurma hub [dir] [--port N]       start the hub with the UI and a local worker\n  ciurma worker --hub URL --token T attach this machine to a hub\n');
}
