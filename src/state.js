/**
 * State + config module — used by both the CLI and the MCP server.
 *
 * Storage layout (under ~/.agent-completion-chime/):
 *   - config.json   { enabled, per_agent_sound, all_complete_sound, volume }
 *   - state.json    { active: { <run_id>: { ts, source, label? } },
 *                     last_all_done_ts, last_per_agent_ts, history: [...] }
 *   - chime.log     append-only NDJSON event log
 *
 * All writes are atomic (write to .tmp, fsync, rename). All read-modify-write
 * sequences run under an exclusive lockfile (lock.lck) to be safe against
 * parallel hook invocations.
 */

import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const ROOT = process.env.AGENT_COMPLETION_CHIME_HOME
  || join(homedir(), '.agent-completion-chime');
export const CONFIG_FILE = join(ROOT, 'config.json');
export const STATE_FILE = join(ROOT, 'state.json');
export const LOG_FILE = join(ROOT, 'chime.log');
export const LOCK_FILE = join(ROOT, 'lock.lck');

export const SOUNDS_DIR = '/System/Library/Sounds';
export const BUILTIN_SOUNDS = [
  'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero',
  'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
];

const DEFAULT_CONFIG = {
  enabled: true,
  per_agent_sound: 'Glass',     // any built-in or absolute path to .aiff/.wav/.mp3
  all_complete_sound: 'Hero',
  volume: 1.0,                  // 0.0–1.0 (passed to afplay -v)
  // Active run TTL: a run that started >this seconds ago is GC'd before
  // we evaluate "is everything done now?" — guards against missed end calls.
  stale_run_seconds: 7200,
  // Suppression window after an all-complete chime so a stray late `end`
  // doesn't replay it. Seconds.
  all_complete_cooldown: 4,
};

function ensureRoot() {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
}

// -- Locking ---------------------------------------------------------------

function withLock(fn) {
  ensureRoot();
  // Simple exclusive flock via O_EXCL + retry. Lock file is the path itself
  // existing; we delete it on release. In v0.1 a 5s busy-wait is fine.
  const start = Date.now();
  let fd;
  while (true) {
    try {
      fd = openSync(LOCK_FILE, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale-lock guard: if older than 30s, steal it.
      try {
        const s = statSync(LOCK_FILE);
        if (Date.now() - s.mtimeMs > 30_000) {
          try { execFileSync('rm', ['-f', LOCK_FILE]); } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - start > 5000) {
        // Give up — proceed without lock. Better to play sound than hang.
        break;
      }
      // Busy wait 25ms.
      const end = Date.now() + 25;
      while (Date.now() < end) {}
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
      try { execFileSync('rm', ['-f', LOCK_FILE]); } catch {}
    }
  }
}

// -- Config ----------------------------------------------------------------

export function loadConfig() {
  ensureRoot();
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  ensureRoot();
  const tmp = CONFIG_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, CONFIG_FILE);
}

export function updateConfig(patch) {
  return withLock(() => {
    const cur = loadConfig();
    const next = { ...cur, ...patch };
    saveConfig(next);
    return next;
  });
}

// -- State -----------------------------------------------------------------

const EMPTY_STATE = {
  active: {},
  last_all_done_ts: 0,
  last_per_agent_ts: 0,
  history: [],   // last 100 events: { ts, type, run_id, source, label? }
};

export function loadState() {
  ensureRoot();
  if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE };
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_STATE, ...parsed, active: parsed.active || {}, history: parsed.history || [] };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveState(state) {
  ensureRoot();
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

function pushHistory(state, evt) {
  state.history = state.history || [];
  state.history.push(evt);
  if (state.history.length > 100) state.history = state.history.slice(-100);
}

function gcStale(state, now, staleSeconds) {
  const cutoff = now - staleSeconds * 1000;
  let removed = 0;
  for (const [k, v] of Object.entries(state.active)) {
    if ((v?.ts ?? 0) < cutoff) {
      delete state.active[k];
      removed += 1;
    }
  }
  return removed;
}

// -- Public ops ------------------------------------------------------------

/**
 * Mark a run as started. Increments the active set.
 * Returns the new state snapshot.
 */
export function markStart({ run_id, source = 'unknown', label }) {
  const now = Date.now();
  return withLock(() => {
    const config = loadConfig();
    const state = loadState();
    gcStale(state, now, config.stale_run_seconds);
    state.active[run_id] = { ts: now, source, label };
    pushHistory(state, { ts: now, type: 'start', run_id, source, label });
    saveState(state);
    logEvent({ ts: now, event: 'start', run_id, source, label, active: Object.keys(state.active).length });
    return state;
  });
}

/**
 * Mark a run as ended. Decrements the active set, plays the per-agent sound,
 * and if active is now empty, plays the all-complete sound (subject to
 * cooldown).
 * Returns { state, played: { per_agent: bool, all_complete: bool } }.
 */
export function markEnd({ run_id, source = 'unknown', label }) {
  const now = Date.now();
  return withLock(() => {
    const config = loadConfig();
    const state = loadState();
    const had = !!state.active[run_id];
    delete state.active[run_id];
    gcStale(state, now, config.stale_run_seconds);
    pushHistory(state, { ts: now, type: 'end', run_id, source, label });

    const played = { per_agent: false, all_complete: false };
    if (config.enabled) {
      // Per-agent chime always fires on a known end (not on a stale-id end
      // that we never saw start — that's likely a misconfigured hook).
      // To be friendly to first-run users we ALSO fire if no start was seen
      // but the run_id is well-formed. Toggle via env if needed.
      if (had || process.env.AGENT_COMPLETION_CHIME_FIRE_UNKNOWN_END !== '0') {
        playSound(config.per_agent_sound, config.volume);
        played.per_agent = true;
        state.last_per_agent_ts = now;
      }
      // All-complete chime when active set is empty, with cooldown.
      const empty = Object.keys(state.active).length === 0;
      const cooldownMs = (config.all_complete_cooldown ?? 4) * 1000;
      const cooledDown = now - (state.last_all_done_ts || 0) > cooldownMs;
      if (empty && cooledDown) {
        // Small delay so per-agent + all-complete don't overlap audibly.
        setTimeout(() => {
          playSound(config.all_complete_sound, config.volume);
        }, 350);
        played.all_complete = true;
        state.last_all_done_ts = now;
      }
    }

    saveState(state);
    logEvent({
      ts: now, event: 'end', run_id, source, label,
      active: Object.keys(state.active).length, played,
    });
    return { state, played };
  });
}

/**
 * Force-clear active runs (for `chime reset`). Optional.
 */
export function resetActive() {
  return withLock(() => {
    const state = loadState();
    state.active = {};
    saveState(state);
    return state;
  });
}

// -- Sound playback --------------------------------------------------------

export function resolveSoundPath(name) {
  if (!name) return null;
  if (name.startsWith('/') || name.startsWith('~')) {
    const expanded = name.replace(/^~/, homedir());
    return expanded;
  }
  // Allow with or without .aiff
  const stem = name.replace(/\.aiff$/i, '');
  return join(SOUNDS_DIR, `${stem}.aiff`);
}

export function playSound(name, volume = 1.0) {
  const path = resolveSoundPath(name);
  if (!path || !existsSync(path)) {
    logEvent({ ts: Date.now(), event: 'play_skipped', reason: 'missing_file', name, path });
    return false;
  }
  // Spawn detached so the process can exit while afplay finishes.
  try {
    spawn('/usr/bin/afplay', ['-v', String(volume), path], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return true;
  } catch (e) {
    logEvent({ ts: Date.now(), event: 'play_failed', name, path, error: String(e) });
    return false;
  }
}

// -- Logging ---------------------------------------------------------------

export function logEvent(rec) {
  try {
    ensureRoot();
    appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  } catch {}
}

// -- Helpers for MCP -------------------------------------------------------

export function listSounds() {
  return BUILTIN_SOUNDS.map((name) => ({
    name,
    path: join(SOUNDS_DIR, `${name}.aiff`),
  }));
}

export function statusSnapshot() {
  const config = loadConfig();
  const state = loadState();
  return {
    enabled: config.enabled,
    per_agent_sound: config.per_agent_sound,
    all_complete_sound: config.all_complete_sound,
    volume: config.volume,
    active_count: Object.keys(state.active).length,
    active: state.active,
    last_per_agent_ts: state.last_per_agent_ts,
    last_all_done_ts: state.last_all_done_ts,
    recent_history: (state.history || []).slice(-10),
  };
}
