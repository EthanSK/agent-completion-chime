#!/usr/bin/env node
/**
 * agent-completion-chime — MCP server (stdio).
 *
 * Exposes a small toolset so any agent ("talking to an agent") can configure
 * the chime, list available sounds, and trigger test playback.
 *
 * Tools registered:
 *   - chime_status              — current config + active runs.
 *   - chime_list_sounds         — all 14 macOS built-in sounds.
 *   - chime_set_per_agent_sound { name }
 *   - chime_set_all_complete_sound { name }
 *   - chime_set_volume          { volume: 0..1 }
 *   - chime_enable / chime_disable
 *   - chime_test                { which: "per-agent" | "all-complete" }
 *   - chime_reset_active        — clear the active set (useful if hooks missed)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  loadConfig,
  updateConfig,
  listSounds,
  statusSnapshot,
  playSound,
  resetActive,
  BUILTIN_SOUNDS,
  logEvent,
} from '../src/state.js';

const server = new McpServer({
  name: 'agent-completion-chime',
  version: '0.1.0',
});

const SOUND_SCHEMA = z
  .string()
  .describe(`Sound name. One of the 14 built-in macOS sounds (${BUILTIN_SOUNDS.join(', ')}) or an absolute path to a .aiff/.wav/.mp3 file.`);

function asText(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

server.registerTool(
  'chime_status',
  {
    title: 'Chime — Status',
    description: 'Show the current chime configuration and how many agents are currently considered active.',
  },
  async () => asText(statusSnapshot()),
);

server.registerTool(
  'chime_list_sounds',
  {
    title: 'Chime — List built-in macOS sounds',
    description: 'Lists the 14 built-in macOS sounds (the contents of /System/Library/Sounds). Use the returned `name` with chime_set_per_agent_sound or chime_set_all_complete_sound.',
  },
  async () => asText(listSounds()),
);

server.registerTool(
  'chime_set_per_agent_sound',
  {
    title: 'Chime — Set per-agent sound',
    description: 'Choose the sound played each time an individual agent finishes. Defaults to Glass. Pick something short and gentle so parallel agents are not annoying.',
    inputSchema: { name: SOUND_SCHEMA },
  },
  async ({ name }) => {
    if (!name.startsWith('/') && !name.startsWith('~') && !BUILTIN_SOUNDS.includes(name)) {
      return asText({ ok: false, error: `unknown sound "${name}"`, available: BUILTIN_SOUNDS });
    }
    const next = updateConfig({ per_agent_sound: name });
    playSound(next.per_agent_sound, next.volume);
    return asText({ ok: true, per_agent_sound: next.per_agent_sound, played_preview: true });
  },
);

server.registerTool(
  'chime_set_all_complete_sound',
  {
    title: 'Chime — Set all-complete sound',
    description: 'Choose the sound played when ALL parallel agents have finished (active count drops to 0). Defaults to Hero. Pick something more triumphant than the per-agent sound.',
    inputSchema: { name: SOUND_SCHEMA },
  },
  async ({ name }) => {
    if (!name.startsWith('/') && !name.startsWith('~') && !BUILTIN_SOUNDS.includes(name)) {
      return asText({ ok: false, error: `unknown sound "${name}"`, available: BUILTIN_SOUNDS });
    }
    const next = updateConfig({ all_complete_sound: name });
    playSound(next.all_complete_sound, next.volume);
    return asText({ ok: true, all_complete_sound: next.all_complete_sound, played_preview: true });
  },
);

server.registerTool(
  'chime_set_volume',
  {
    title: 'Chime — Set volume',
    description: 'Set playback volume (0.0 silent, 1.0 full). Passed straight to afplay -v.',
    inputSchema: {
      volume: z.number().min(0).max(1).describe('0.0 (silent) to 1.0 (full).'),
    },
  },
  async ({ volume }) => {
    const next = updateConfig({ volume });
    return asText({ ok: true, volume: next.volume });
  },
);

server.registerTool(
  'chime_enable',
  {
    title: 'Chime — Enable',
    description: 'Enable chime playback (sounds will play on agent completion events).',
  },
  async () => asText(updateConfig({ enabled: true })),
);

server.registerTool(
  'chime_disable',
  {
    title: 'Chime — Disable',
    description: 'Disable chime playback. Hooks will still run and update state, but no sound will play.',
  },
  async () => asText(updateConfig({ enabled: false })),
);

server.registerTool(
  'chime_test',
  {
    title: 'Chime — Test playback',
    description: 'Plays one of the configured sounds without affecting state, so you can preview your settings.',
    inputSchema: {
      which: z.enum(['per-agent', 'all-complete']).describe('Which configured sound to preview.'),
    },
  },
  async ({ which }) => {
    const cfg = loadConfig();
    const name = which === 'per-agent' ? cfg.per_agent_sound : cfg.all_complete_sound;
    playSound(name, cfg.volume);
    return asText({ ok: true, played: name, which });
  },
);

server.registerTool(
  'chime_reset_active',
  {
    title: 'Chime — Reset active runs',
    description: 'Clear the active-runs set. Use if some hook missed an `end` event and the all-complete chime never fired.',
  },
  async () => {
    const state = resetActive();
    return asText({ ok: true, active: Object.keys(state.active).length });
  },
);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  logEvent({ ts: Date.now(), event: 'mcp_started', pid: process.pid });
}).catch((err) => {
  logEvent({ ts: Date.now(), event: 'mcp_failed_to_start', error: String(err) });
  process.exit(1);
});
