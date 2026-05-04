/**
 * bot-name.js — resolve the Telegram bot name bound to a given machine, so
 * the post-chime `say` can speak the bot username Ethan sees in his Telegram
 * chat list (e.g. "Realclaude4bot all complete") instead of the agent task
 * description (which was meaningless to him).
 *
 * Established 2026-05-04 (Ethan voice 6308):
 *   "I wanted to try and be the Telegram name that I'm communicating with,
 *    because that's the one I see, right? The name of the bot."
 *
 * ===========================================================================
 * Resolution order
 * ===========================================================================
 *
 *   1. Static map in chime config: `bot_names_by_machine[<machine>]`. Ethan
 *      can hand-edit this to be authoritative.
 *   2. AUTO-DERIVE fallback (LOCAL machine only). We can't auto-derive a
 *      peer's bot name because we don't have its bot token — only the local
 *      Telegram plugin's .env has it.
 *      a. If a cached value exists in `~/.agent-completion-chime/bot-name.cache.json`
 *         AND is fresh (< 7 days old), use it.
 *      b. Otherwise, read `~/.claude/channels/telegram/.env` for
 *         `TELEGRAM_BOT_TOKEN`, call Telegram's `getMe` API once, cache the
 *         resulting `result.username`, and return it.
 *      c. If the token isn't there or the API call fails, return null.
 *   3. Fall back to machine name (caller's responsibility) — e.g. "Mini all
 *      complete" / "MacBookPro subagent complete".
 *
 * The cache TTL is 7 days because bot usernames are basically permanent —
 * Ethan would only ever change one if he re-pairs to a new bot. A weekly
 * refresh is plenty.
 *
 * The auto-derive HTTP call is intentionally synchronous-only-when-cached.
 * The first-ever call goes async (returns null, populates cache for next
 * time). This keeps the chime hook latency bounded — we never block on a
 * network call inside the Stop / SubagentStop hook handler.
 * ===========================================================================
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function chimeRoot() {
  return process.env.AGENT_COMPLETION_CHIME_HOME || join(homedir(), '.agent-completion-chime');
}

function botNameCachePath() {
  return join(chimeRoot(), 'bot-name.cache.json');
}

function telegramEnvPath() {
  return join(homedir(), '.claude', 'channels', 'telegram', '.env');
}

function loadCache() {
  const path = botNameCachePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  const path = botNameCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch {}
}

/**
 * Read TELEGRAM_BOT_TOKEN from ~/.claude/channels/telegram/.env. Returns
 * the token string or null.
 */
export function readLocalTelegramToken() {
  const path = telegramEnvPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return null;
}

/**
 * Async — call Telegram's `getMe` API and return `result.username`. Used
 * once per cache miss to populate the cache. Never throws; returns null on
 * any failure.
 */
export async function fetchBotUsernameFromTelegram(token, { fetchImpl = globalThis.fetch } = {}) {
  if (!token || !fetchImpl) return null;
  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    let resp;
    try {
      resp = await fetchImpl(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    if (data && data.ok === true && data.result && typeof data.result.first_name === 'string') {
      // Use first_name (the chat-display label Ethan sees in his Telegram
      // chat list, e.g. "Real Claude 4") instead of username ("Realclaude4bot").
      // Voice 6317 (2026-05-04): "don't use the Telegram bot name, use the
      // actual chat name if possible because they're different".
      return data.result.first_name;
    }
  } catch {}
  return null;
}

/**
 * SYNC lookup, cache-only. Returns the bot name for `machine` or null.
 * Never blocks on the network — that's the job of `refreshLocalBotNameCache`.
 *
 * `config` should have `bot_names_by_machine` (map of machine -> bot username).
 * `local_machine` is the machine name we're running on; only used so the cache
 * key matches what `refreshLocalBotNameCache` writes.
 */
export function resolveBotNameSync({ machine, config, local_machine } = {}) {
  if (!machine) return null;
  const map = (config && typeof config.bot_names_by_machine === 'object' && config.bot_names_by_machine) || {};
  if (typeof map[machine] === 'string' && map[machine].trim()) return map[machine].trim();

  // Cache fallback — auto-derived for local machine only. (Peer entries can
  // be present if the peer pre-populated them, but typically the static map
  // is the only source for non-local machines.)
  const cache = loadCache();
  const entry = cache[machine];
  if (entry && typeof entry.bot_name === 'string' && entry.bot_name.trim()) {
    const ts = Number(entry.cached_at ?? 0);
    if (Date.now() - ts < CACHE_TTL_MS) {
      return entry.bot_name.trim();
    }
  }
  return null;
}

/**
 * ASYNC — refresh the local-machine cache by calling Telegram's `getMe`.
 * Idempotent and rate-limited via the cache TTL — won't make the network
 * call if the cache entry is fresh. Best-effort, never throws.
 *
 * `local_machine` is the machine name to use as the cache key.
 *
 * Returns the bot username (string) or null.
 */
export async function refreshLocalBotNameCache({
  local_machine,
  fetchImpl = globalThis.fetch,
  forceRefresh = false,
} = {}) {
  if (!local_machine) return null;
  const cache = loadCache();
  const entry = cache[local_machine];
  if (!forceRefresh && entry && typeof entry.bot_name === 'string') {
    const ts = Number(entry.cached_at ?? 0);
    if (Date.now() - ts < CACHE_TTL_MS) return entry.bot_name;
  }
  const token = readLocalTelegramToken();
  if (!token) return null;
  const name = await fetchBotUsernameFromTelegram(token, { fetchImpl });
  if (!name) return null;
  cache[local_machine] = { bot_name: name, cached_at: Date.now() };
  saveCache(cache);
  return name;
}

/**
 * Build the spoken phrase for a chime event.
 *
 *   kind = 'all_complete' | 'per_agent'
 *   bot_name = resolved bot username, or null
 *   machine_fallback = a short machine name to use when bot_name is null
 *                      (e.g. "Mini" / "MacBookPro")
 *
 * Returns null when there's nothing to say (e.g. say feature disabled).
 */
export function speechForChime({ kind, bot_name, machine_fallback }) {
  const name = (bot_name && bot_name.trim()) || (machine_fallback && machine_fallback.trim()) || '';
  if (!name) return null;
  // Just speak the name — let the chime audio carry the per-agent vs
  // all-complete meaning. Voice 6317 (2026-05-04): "don't you have to say
  // sub agent complete? Just the name and the chime."
  return name;
}

/**
 * Short machine name for fallback speech. Strips ".local" suffix and
 * common prefixes like "Ethans-" so "Ethans-Mac-mini" speaks as "Mac mini".
 */
export function shortenMachineNameForSpeech(machine) {
  if (!machine || typeof machine !== 'string') return '';
  let s = machine.trim().replace(/\.local$/i, '');
  // Strip leading "Ethans-" / "Ethan-" / "Ethans " etc.
  s = s.replace(/^Ethans?[- _]+/i, '');
  // Replace dashes/underscores with spaces for natural prosody.
  s = s.replace(/[-_]+/g, ' ');
  return s.trim();
}
