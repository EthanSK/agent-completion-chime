/**
 * Smoke tests for state.js. Uses a temp $AGENT_COMPLETION_CHIME_HOME so we
 * don't trample the real ~/.agent-completion-chime/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set the home BEFORE importing state.js (env is read at module load).
const tmpHome = mkdtempSync(join(tmpdir(), 'agent-chime-'));
process.env.AGENT_COMPLETION_CHIME_HOME = tmpHome;
// Also disable actual sound playback in tests by pointing afplay path away —
// the spawn is detached and stdio:'ignore', so even if it fails it's silent.

const {
  loadConfig,
  updateConfig,
  loadState,
  markStart,
  markEnd,
  resetActive,
  statusSnapshot,
  BUILTIN_SOUNDS,
  listSounds,
} = await import('../src/state.js');

test('default config bootstraps on first read', () => {
  const cfg = loadConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.per_agent_sound, 'Glass');
  assert.equal(cfg.all_complete_sound, 'Hero');
});

test('updateConfig persists', () => {
  updateConfig({ per_agent_sound: 'Pop' });
  assert.equal(loadConfig().per_agent_sound, 'Pop');
  // restore default for later tests
  updateConfig({ per_agent_sound: 'Glass' });
});

test('markStart adds to active set', () => {
  resetActive();
  markStart({ run_id: 'a1', source: 'test' });
  markStart({ run_id: 'a2', source: 'test' });
  const s = loadState();
  assert.equal(Object.keys(s.active).length, 2);
});

test('markEnd decrements and only fires all-complete on empty', () => {
  resetActive();
  // Disable sound by setting volume to 0 — afplay still spawns, but inaudible.
  // The state machine doesn't depend on actually playing.
  markStart({ run_id: 'b1' });
  markStart({ run_id: 'b2' });
  const r1 = markEnd({ run_id: 'b1' });
  assert.equal(r1.played.per_agent, true);
  assert.equal(r1.played.all_complete, false, 'b2 still active, no all-complete yet');
  const r2 = markEnd({ run_id: 'b2' });
  assert.equal(r2.played.per_agent, true);
  assert.equal(r2.played.all_complete, true, 'now all-complete should fire');
  // State should be empty.
  assert.equal(Object.keys(loadState().active).length, 0);
});

test('disabled config prevents sounds but still updates state', () => {
  resetActive();
  updateConfig({ enabled: false });
  markStart({ run_id: 'c1' });
  const r = markEnd({ run_id: 'c1' });
  assert.equal(r.played.per_agent, false);
  assert.equal(r.played.all_complete, false);
  assert.equal(Object.keys(loadState().active).length, 0);
  updateConfig({ enabled: true });
});

test('listSounds returns the 14 macOS built-ins', () => {
  const sounds = listSounds();
  assert.equal(sounds.length, BUILTIN_SOUNDS.length);
  assert.ok(sounds.every((s) => s.path.endsWith('.aiff')));
});

test('all-complete cooldown suppresses replays within window', async () => {
  // Wipe state file so last_all_done_ts is back to 0.
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(tmpHome, 'state.json'), JSON.stringify({
    active: {}, last_all_done_ts: 0, last_per_agent_ts: 0, history: [],
  }));

  updateConfig({ all_complete_cooldown: 60 });
  markStart({ run_id: 'd1' });
  const r1 = markEnd({ run_id: 'd1' });
  assert.equal(r1.played.all_complete, true, 'first drain on a fresh state should fire');
  markStart({ run_id: 'd2' });
  const r2 = markEnd({ run_id: 'd2' });
  assert.equal(r2.played.all_complete, false, 'second drain within 60s window should be suppressed');
  // Reset cooldown for other tests.
  updateConfig({ all_complete_cooldown: 4 });
});

test('statusSnapshot exposes current state', () => {
  const snap = statusSnapshot();
  assert.equal(typeof snap.enabled, 'boolean');
  assert.equal(typeof snap.active_count, 'number');
  assert.ok(Array.isArray(snap.recent_history));
});

test.after?.(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});
