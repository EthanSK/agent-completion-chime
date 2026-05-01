#!/usr/bin/env node
/**
 * `chime` CLI — the thin command Claude Code / OpenClaw / anything else
 * shells out to from Stop / SubagentStop / on-exit hooks.
 *
 * Usage:
 *
 *   chime start <run_id> [--source <name>] [--label <text>]
 *   chime end   <run_id> [--source <name>] [--label <text>]
 *   chime end --from-claude-hook        # reads JSON on stdin (Claude Code hook payload)
 *   chime end --from-claude-stop        # alias of --from-claude-hook (parent Stop)
 *   chime end --from-claude-subagent    # alias (SubagentStop)
 *
 *   chime status
 *   chime sounds
 *   chime config get
 *   chime config set per_agent_sound Glass
 *   chime config set all_complete_sound Hero
 *   chime config set enabled true
 *   chime config set volume 0.7
 *   chime test per-agent
 *   chime test all-complete
 *   chime reset
 *
 * Exit code is 0 unless a hard error occurred — hooks should never block
 * the host on us. We swallow most errors and log them.
 */

import { readFileSync } from 'node:fs';
import {
  markStart,
  markEnd,
  resetActive,
  loadConfig,
  updateConfig,
  listSounds,
  statusSnapshot,
  playSound,
  logEvent,
  BUILTIN_SOUNDS,
} from '../src/state.js';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readStdinJson() {
  try {
    const data = readFileSync(0, 'utf8');
    if (!data) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of a stable run id + label from a Claude Code hook
 * payload. The official spec passes a JSON object on stdin; we accept any of
 * the common keys used in published hook examples.
 */
function runIdFromClaudePayload(payload, hookKind) {
  if (!payload || typeof payload !== 'object') return { id: `claude-${hookKind}-${Date.now()}`, label: hookKind };
  const id = payload.subagent_id
    || payload.subagent_session_id
    || payload.session_id
    || payload.transcript_path
    || payload.cwd
    || `claude-${hookKind}-${Date.now()}`;
  const label = payload.subagent_type
    || payload.tool_name
    || payload.task
    || hookKind;
  return { id: String(id), label: String(label) };
}

function formatJson(obj) {
  return JSON.stringify(obj, null, 2);
}

function cmdStart(args) {
  const { positional, flags } = parseFlags(args);
  const run_id = positional[0];
  if (!run_id) die('chime start <run_id> required');
  const state = markStart({ run_id, source: flags.source || 'cli', label: flags.label });
  if (!flags.quiet) console.log(formatJson({ ok: true, active: Object.keys(state.active).length }));
}

function cmdEnd(args) {
  const { positional, flags } = parseFlags(args);

  let run_id = positional[0];
  let source = flags.source || 'cli';
  let label = flags.label;

  // Hook adapters — read payload from stdin and derive run_id.
  if (flags['from-claude-hook'] || flags['from-claude-stop']) {
    const payload = readStdinJson();
    const { id, label: l } = runIdFromClaudePayload(payload, 'stop');
    run_id = id; source = 'claude-code'; label = l;
  } else if (flags['from-claude-subagent']) {
    const payload = readStdinJson();
    const { id, label: l } = runIdFromClaudePayload(payload, 'subagent_stop');
    run_id = id; source = 'claude-code-subagent'; label = l;
  }

  if (!run_id) die('chime end <run_id> required (or pass --from-claude-hook / --from-claude-subagent)');
  const { state, played } = markEnd({ run_id, source, label });
  if (!flags.quiet) console.log(formatJson({ ok: true, active: Object.keys(state.active).length, played }));
}

function cmdStatus() {
  console.log(formatJson(statusSnapshot()));
}

function cmdSounds() {
  console.log(formatJson(listSounds()));
}

function cmdConfig(args) {
  const [sub, key, ...rest] = args;
  if (sub === 'get' || !sub) {
    console.log(formatJson(loadConfig()));
    return;
  }
  if (sub === 'set') {
    if (!key) die('chime config set <key> <value>');
    let value = rest.join(' ');
    if (key === 'enabled') value = (value === 'true' || value === '1');
    else if (key === 'volume') value = Number(value);
    else if (key === 'stale_run_seconds' || key === 'all_complete_cooldown') value = Number(value);
    else if (key === 'per_agent_sound' || key === 'all_complete_sound') {
      // Validate against built-ins unless an absolute path
      if (!value.startsWith('/') && !value.startsWith('~') && !BUILTIN_SOUNDS.includes(value)) {
        die(`unknown sound "${value}". Try one of: ${BUILTIN_SOUNDS.join(', ')}, or pass an absolute path.`);
      }
    }
    const next = updateConfig({ [key]: value });
    console.log(formatJson(next));
    return;
  }
  die(`unknown config subcommand: ${sub}`);
}

function cmdTest(args) {
  const which = args[0];
  const cfg = loadConfig();
  if (which === 'per-agent' || which === 'per_agent') {
    playSound(cfg.per_agent_sound, cfg.volume);
    console.log(`Played per-agent: ${cfg.per_agent_sound}`);
  } else if (which === 'all-complete' || which === 'all_complete') {
    playSound(cfg.all_complete_sound, cfg.volume);
    console.log(`Played all-complete: ${cfg.all_complete_sound}`);
  } else {
    die('chime test <per-agent|all-complete>');
  }
}

function cmdReset() {
  const state = resetActive();
  console.log(formatJson({ ok: true, active: Object.keys(state.active).length }));
}

function cmdEnable(on) {
  const next = updateConfig({ enabled: on });
  console.log(formatJson({ enabled: next.enabled }));
}

function cmdHelp() {
  console.log(`agent-completion-chime — chime CLI

Commands:
  chime start <run_id> [--source <name>] [--label <text>]
  chime end   <run_id> [--source <name>] [--label <text>]
  chime end   --from-claude-hook       (reads Claude Code Stop payload on stdin)
  chime end   --from-claude-subagent   (reads SubagentStop payload on stdin)
  chime status
  chime sounds
  chime config get
  chime config set <key> <value>       (per_agent_sound, all_complete_sound, enabled, volume)
  chime test per-agent | all-complete
  chime enable | disable
  chime reset                          (clears active runs)

State:    ~/.agent-completion-chime/state.json
Config:   ~/.agent-completion-chime/config.json
Log:      ~/.agent-completion-chime/chime.log
`);
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

const [, , cmd, ...rest] = process.argv;

try {
  switch (cmd) {
    case 'start':           cmdStart(rest); break;
    case 'end':             cmdEnd(rest); break;
    case 'status':          cmdStatus(); break;
    case 'sounds':          cmdSounds(); break;
    case 'config':          cmdConfig(rest); break;
    case 'test':            cmdTest(rest); break;
    case 'reset':           cmdReset(); break;
    case 'enable':          cmdEnable(true); break;
    case 'disable':         cmdEnable(false); break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:         cmdHelp(); break;
    default:                die(`unknown command: ${cmd}. Try \`chime help\`.`);
  }
} catch (e) {
  logEvent({ ts: Date.now(), event: 'cli_error', cmd, error: String(e) });
  console.error(`error: ${e.message || e}`);
  // Hooks should not block the host — exit 0 on internal errors so a
  // failed chime never makes Claude Code think a turn errored out.
  process.exit(0);
}
