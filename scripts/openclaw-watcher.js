#!/usr/bin/env node
/**
 * Optional OpenClaw integration: watches `~/.openclaw/subagents/runs.json`
 * (the OpenClaw subagent run registry) and translates state transitions
 * into `chime start` / `chime end` calls.
 *
 * Run it as a small background process (e.g. via launchd or just
 * `nohup node scripts/openclaw-watcher.js &`).
 *
 * v0.1: simple polling every 1s. fsevents/chokidar can be added in v0.2.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { markStart, markEnd } from '../src/state.js';

const RUNS_PATH = process.env.OPENCLAW_RUNS_PATH
  || join(homedir(), '.openclaw', 'subagents', 'runs.json');

const POLL_MS = Number(process.env.OPENCLAW_WATCHER_POLL_MS || 1000);

let lastSig = '';
let knownActive = new Set();

function readRuns() {
  if (!existsSync(RUNS_PATH)) return null;
  try {
    const raw = readFileSync(RUNS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isActive(run) {
  // OpenClaw run shape: status field varies, but anything not in
  // {done, completed, finished, failed, error, cancelled, killed} is treated
  // as active.
  const status = String(run?.status || run?.state || '').toLowerCase();
  if (!status) return true;
  return !/(done|complete|finish|fail|error|cancel|kill|aborted)/.test(status);
}

function tick() {
  let stamp;
  try {
    stamp = statSync(RUNS_PATH).mtimeMs;
  } catch {
    stamp = 0;
  }
  const sig = String(stamp);
  if (sig === lastSig) return;
  lastSig = sig;

  const data = readRuns();
  const runs = (data && data.runs) || {};
  const nowActive = new Set();
  for (const [id, run] of Object.entries(runs)) {
    if (isActive(run)) nowActive.add(id);
  }
  // New starts.
  for (const id of nowActive) {
    if (!knownActive.has(id)) {
      markStart({ run_id: `openclaw:${id}`, source: 'openclaw', label: runs[id]?.task || runs[id]?.title });
    }
  }
  // Completions.
  for (const id of knownActive) {
    if (!nowActive.has(id)) {
      markEnd({ run_id: `openclaw:${id}`, source: 'openclaw', label: runs[id]?.task || runs[id]?.title });
    }
  }
  knownActive = nowActive;
}

function loop() {
  try { tick(); } catch (e) {
    process.stderr.write(`openclaw-watcher tick error: ${e.message}\n`);
  }
  setTimeout(loop, POLL_MS);
}

process.stderr.write(`openclaw-watcher: watching ${RUNS_PATH} every ${POLL_MS}ms\n`);
loop();
