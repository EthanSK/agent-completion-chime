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

// -- Mini-as-master peer-mode tests (2026-05-04) -----------------------------

test('roleForLocal returns master when local machine matches master_machine', async () => {
  process.env.AGENT_BRIDGE_MACHINE_NAME = 'Ethans-Mac-mini';
  const { roleForLocal } = await import('../src/state.js');
  const role = roleForLocal({ master_machine: 'Ethans-Mac-mini' });
  assert.equal(role, 'master');
  delete process.env.AGENT_BRIDGE_MACHINE_NAME;
});

test('roleForLocal returns peer when local machine differs from master_machine', async () => {
  process.env.AGENT_BRIDGE_MACHINE_NAME = 'MacBookPro';
  const { roleForLocal } = await import('../src/state.js');
  const role = roleForLocal({ master_machine: 'Ethans-Mac-mini' });
  assert.equal(role, 'peer');
  delete process.env.AGENT_BRIDGE_MACHINE_NAME;
});

test('roleForLocal returns standalone when master_machine is null', async () => {
  process.env.AGENT_BRIDGE_MACHINE_NAME = 'MacBookPro';
  const { roleForLocal } = await import('../src/state.js');
  assert.equal(roleForLocal({ master_machine: null }), 'standalone');
  delete process.env.AGENT_BRIDGE_MACHINE_NAME;
});

test('peer-mode markEnd does NOT play locally and skips state.last_per_agent_ts', async () => {
  process.env.AGENT_BRIDGE_MACHINE_NAME = 'MacBookPro';
  // Point agent_bridge_path at a non-existent path so forwardEndEventToMaster
  // returns delivered=none WITHOUT actually trying SSH.
  updateConfig({ master_machine: 'Ethans-Mac-mini', agent_bridge_path: '/nonexistent-path' });
  // Clear any state mutations from earlier tests in the file.
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(tmpHome, 'state.json'), JSON.stringify({
    active: {}, last_all_done_ts: 0, last_per_agent_ts: 0, history: [],
  }));
  markStart({ run_id: 'p1', source: 'test' });
  const tsBefore = loadState().last_per_agent_ts || 0;
  const r = markEnd({ run_id: 'p1', source: 'test' });
  // played.per_agent is FALSE because peer-mode skips local play
  assert.equal(r.played.per_agent, false, 'peer-mode does not play locally');
  assert.equal(r.played.all_complete, false);
  assert.equal(r.forwarded.role, 'peer');
  // last_per_agent_ts is NOT bumped on peer (only master mutates it)
  const tsAfter = loadState().last_per_agent_ts || 0;
  assert.equal(tsAfter, tsBefore, 'peer-mode must not mutate last_per_agent_ts');
  // Restore for subsequent tests
  updateConfig({ master_machine: 'Ethans-Mac-mini', agent_bridge_path: undefined });
  delete process.env.AGENT_BRIDGE_MACHINE_NAME;
});

test('master-mode markEnd plays locally as before', async () => {
  process.env.AGENT_BRIDGE_MACHINE_NAME = 'Ethans-Mac-mini';
  updateConfig({ master_machine: 'Ethans-Mac-mini' });
  resetActive();
  markStart({ run_id: 'm1', source: 'test' });
  const r = markEnd({ run_id: 'm1', source: 'test' });
  assert.equal(r.played.per_agent, true, 'master-mode plays locally');
  delete process.env.AGENT_BRIDGE_MACHINE_NAME;
});

test('standalone-mode (master_machine=null) plays locally', async () => {
  process.env.AGENT_BRIDGE_MACHINE_NAME = 'MacBookPro';
  updateConfig({ master_machine: null });
  resetActive();
  markStart({ run_id: 's1', source: 'test' });
  const r = markEnd({ run_id: 's1', source: 'test' });
  assert.equal(r.played.per_agent, true, 'standalone-mode plays locally');
  // Restore
  updateConfig({ master_machine: 'Ethans-Mac-mini' });
  delete process.env.AGENT_BRIDGE_MACHINE_NAME;
});

test.after?.(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});
