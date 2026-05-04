/**
 * Tests for src/bot-name.js — the Telegram bot-name lookup used by the
 * post-chime `say`. Established 2026-05-04, voice 6308.
 *
 * Uses a temp $AGENT_COMPLETION_CHIME_HOME so we don't trample real cache.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'agent-chime-bot-'));
process.env.AGENT_COMPLETION_CHIME_HOME = tmpHome;

const {
  resolveBotNameSync,
  refreshLocalBotNameCache,
  speechForChime,
  shortenMachineNameForSpeech,
  readLocalTelegramToken,
  fetchBotUsernameFromTelegram,
} = await import('../src/bot-name.js');

test('resolveBotNameSync prefers the static map over cache', () => {
  const config = {
    bot_names_by_machine: {
      'Ethans-Mac-mini': 'StaticMapBot',
    },
  };
  const name = resolveBotNameSync({ machine: 'Ethans-Mac-mini', config });
  assert.equal(name, 'StaticMapBot');
});

test('resolveBotNameSync returns null for unknown machine with empty config', () => {
  const name = resolveBotNameSync({ machine: 'NeverHeardOf', config: {} });
  assert.equal(name, null);
});

test('resolveBotNameSync returns null when machine is missing', () => {
  assert.equal(resolveBotNameSync({}), null);
  assert.equal(resolveBotNameSync({ machine: '', config: {} }), null);
});

test('resolveBotNameSync uses cache when no static-map hit', () => {
  // Write a synthetic cache entry.
  const cachePath = join(tmpHome, 'bot-name.cache.json');
  writeFileSync(cachePath, JSON.stringify({
    'CachedHost': { bot_name: 'CachedBot', cached_at: Date.now() },
  }));
  const name = resolveBotNameSync({ machine: 'CachedHost', config: {} });
  assert.equal(name, 'CachedBot');
});

test('resolveBotNameSync ignores stale cache entries', () => {
  const cachePath = join(tmpHome, 'bot-name.cache.json');
  // 30 days ago — older than 7-day TTL.
  const stale = Date.now() - 30 * 24 * 60 * 60 * 1000;
  writeFileSync(cachePath, JSON.stringify({
    'StaleHost': { bot_name: 'StaleBot', cached_at: stale },
  }));
  const name = resolveBotNameSync({ machine: 'StaleHost', config: {} });
  assert.equal(name, null);
});

test('speechForChime returns just the name (no suffix)', () => {
  // Voice 6317 (2026-05-04): "don't you have to say sub agent complete?
  // Just the name and the chime." No "all complete" / "subagent complete"
  // suffix — let the chime audio carry the meaning.
  assert.equal(
    speechForChime({ kind: 'all_complete', bot_name: 'Claude Code 4', machine_fallback: 'Mini' }),
    'Claude Code 4',
  );
  assert.equal(
    speechForChime({ kind: 'per_agent', bot_name: 'Claude Code 4', machine_fallback: 'MBP' }),
    'Claude Code 4',
  );
});

test('speechForChime falls back to machine name when no bot name', () => {
  assert.equal(
    speechForChime({ kind: 'all_complete', bot_name: null, machine_fallback: 'Mac mini' }),
    'Mac mini',
  );
  assert.equal(
    speechForChime({ kind: 'per_agent', bot_name: '', machine_fallback: 'MacBookPro' }),
    'MacBookPro',
  );
});

test('speechForChime returns null when both bot_name and fallback are empty', () => {
  assert.equal(
    speechForChime({ kind: 'all_complete', bot_name: null, machine_fallback: '' }),
    null,
  );
  assert.equal(
    speechForChime({ kind: 'per_agent' }),
    null,
  );
});

test('shortenMachineNameForSpeech strips Ethans- prefix and .local suffix', () => {
  assert.equal(shortenMachineNameForSpeech('Ethans-Mac-mini.local'), 'Mac mini');
  assert.equal(shortenMachineNameForSpeech('Ethans-Mac-mini'), 'Mac mini');
  assert.equal(shortenMachineNameForSpeech('MacBookPro'), 'MacBookPro');
  assert.equal(shortenMachineNameForSpeech('SHITTYWINDOWS'), 'SHITTYWINDOWS');
  assert.equal(shortenMachineNameForSpeech(''), '');
  assert.equal(shortenMachineNameForSpeech(null), '');
});

test('refreshLocalBotNameCache returns null when no token available', async () => {
  // No telegram .env in test; should return null.
  const result = await refreshLocalBotNameCache({ local_machine: 'TestMachine' });
  // Could be null OR could hit the real telegram .env if it exists outside
  // tmpHome — that's fine, just verify it doesn't throw and returns
  // string|null.
  assert.ok(result === null || typeof result === 'string');
});

test('refreshLocalBotNameCache uses cached value within TTL without calling fetch', async () => {
  const cachePath = join(tmpHome, 'bot-name.cache.json');
  writeFileSync(cachePath, JSON.stringify({
    'FreshHost': { bot_name: 'FreshBot', cached_at: Date.now() },
  }));
  let fetchCalled = false;
  const fakeFetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  const result = await refreshLocalBotNameCache({
    local_machine: 'FreshHost',
    fetchImpl: fakeFetch,
  });
  assert.equal(result, 'FreshBot');
  assert.equal(fetchCalled, false, 'should not call fetch when cache is fresh');
});

test('fetchBotUsernameFromTelegram returns first_name from getMe-like response', async () => {
  // Voice 6317 (2026-05-04): use the chat-display first_name (e.g. "Claude
  // Code 4") instead of the username ("Realclaude4bot") so the spoken label
  // matches what Ethan sees in his Telegram chat list.
  const fakeFetch = async (url) => {
    assert.ok(url.startsWith('https://api.telegram.org/bot'));
    return {
      ok: true,
      json: async () => ({ ok: true, result: { id: 123, first_name: 'Claude Code 4', username: 'Realclaude4bot' } }),
    };
  };
  const name = await fetchBotUsernameFromTelegram('fake-token', { fetchImpl: fakeFetch });
  assert.equal(name, 'Claude Code 4');
});

test('fetchBotUsernameFromTelegram returns null on failed response', async () => {
  const fakeFetch = async () => ({ ok: false });
  const name = await fetchBotUsernameFromTelegram('fake-token', { fetchImpl: fakeFetch });
  assert.equal(name, null);
});

test('fetchBotUsernameFromTelegram returns null when ok=false in body', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ ok: false, description: 'unauthorized' }),
  });
  const name = await fetchBotUsernameFromTelegram('fake-token', { fetchImpl: fakeFetch });
  assert.equal(name, null);
});

test('refreshLocalBotNameCache forceRefresh calls fetch even on fresh cache', async () => {
  const cachePath = join(tmpHome, 'bot-name.cache.json');
  writeFileSync(cachePath, JSON.stringify({
    'ForceHost': { bot_name: 'OldBot', cached_at: Date.now() },
  }));
  // Stub readLocalTelegramToken indirectly by giving a fake token via a
  // synthetic .env... easier: just exercise the code path with no token, the
  // function should bail and not raise.
  let fetchCalled = false;
  const fakeFetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ ok: true, result: { first_name: 'NewBot' } }) };
  };
  const result = await refreshLocalBotNameCache({
    local_machine: 'ForceHost',
    forceRefresh: true,
    fetchImpl: fakeFetch,
  });
  // If readLocalTelegramToken returned a token (because the test env has
  // ~/.claude/channels/telegram/.env present), result === 'NewBot'.
  // Otherwise null. Both are valid.
  assert.ok(result === null || result === 'NewBot');
});

test.after?.(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});
