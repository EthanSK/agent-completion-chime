# agent-completion-chime — Architecture

**Project name:** `agent-completion-chime` (npm package + GitHub repo).

**Goal:** Make a macOS sound when (a) any one agent run finishes; (b) ALL parallel agents have finished. Two distinct, configurable built-in macOS sounds. Hooks into Claude Code, OpenClaw, and (optionally) anything else that can call a CLI on exit.

## Top-level design — daemon + thin hooks + MCP config

```
   ┌─────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
   │  Claude Code Stop / │    │ OpenClaw subagent    │    │ Anything else (CI,   │
   │  SubagentStop hooks │    │ exit hook (or poll   │    │ gh workflows, etc.)  │
   │  (settings.json)    │    │ runs.json watcher)   │    │ via `chime end`      │
   └──────────┬──────────┘    └──────────┬───────────┘    └──────────┬───────────┘
              │                          │                            │
              ▼                          ▼                            ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  chime CLI  (Node, ~50 LOC)                                                  │
   │     `chime start <run_id>`   — bumps active count, writes state              │
   │     `chime end   <run_id>`   — decrements, plays per-agent sound,            │
   │                                if active==0, plays all-complete sound       │
   │     `chime status` / `chime config` / `chime sounds`                         │
   └──────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  ~/.agent-completion-chime/                                                  │
   │     state.json     { active: { <run_id>: { ts, source } }, last_all_done }  │
   │     config.json    { per_agent_sound, all_complete_sound, enabled, ... }    │
   │     chime.log                                                                │
   └──────────────────────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  MCP server (stdio)  agent-completion-chime-mcp                              │
   │     set_per_agent_sound, set_all_complete_sound,                             │
   │     list_sounds, status, enable, disable, test_per_agent, test_all_complete │
   │  — talks to the same state.json/config.json the CLI does.                    │
   └──────────────────────────────────────────────────────────────────────────────┘
```

Sound playback uses `afplay /System/Library/Sounds/<Name>.aiff` (no extra deps,
ships with macOS, instant launch). 14 built-ins are available: Basso, Blow,
Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine,
Tink. Defaults: `per_agent = Glass`, `all_complete = Hero`.

## Why this shape (and not the alternatives)

- **Why no long-running daemon process.** A persistent state file (`state.json`)
  + atomic file writes + exclusive `flock` is enough — there's nothing to "wait
  for." Each hook invocation is a fast Node script, runs and exits. No risk of
  zombie daemons (Ethan's CLAUDE.md explicitly warns against those). No
  launchctl plist.
- **Why hooks, not a watcher.** Claude Code's `Stop` and `SubagentStop` events
  fire deterministically when the harness considers a turn finished. Watching
  process trees is racy — hooks are the canonical event source. OpenClaw's
  subagent runtime writes to `~/.openclaw/subagents/runs.json`; we add a
  lightweight skill / hook that calls `chime end` when a run transitions to
  finished. (For machines without that wired up, a fsnotify watcher on
  `runs.json` is a fallback.)
- **Why MCP server.** Ethan wants to configure-by-talking ("set the all-done
  sound to Hero", "list sounds"). The natural surface for that is an MCP tool
  exposed to whichever agent he's chatting with. Same pattern as agent-bridge.
- **Why one repo, one package.** CLI + MCP server share the same state/config
  module. Single `npm install -g agent-completion-chime` ships both binaries
  (`chime` + `agent-completion-chime-mcp`).

## Detection details — "all parallel agents complete"

State is `{ active: { run_id: ts } }` keyed by a stable run identifier.
- Claude Code passes the session/agent identity into the hook's stdin (per
  the official hook spec) — we extract `session_id` for the parent and
  `subagent_id` for `SubagentStop` events.
- OpenClaw passes the subagent run id to the exit hook script.
- "All complete" = `active` is empty after a `chime end` decrement.
- Stale entries (>2h) are GC'd on every call so a missed `end` event doesn't
  permanently silence the all-complete chime.

## Configurable via "talking to an agent"

The MCP server exposes:

| Tool | Purpose |
| --- | --- |
| `list_sounds` | Returns the 14 macOS built-ins. |
| `set_per_agent_sound(name)` | Sets the sound for individual completions. |
| `set_all_complete_sound(name)` | Sets the sound for "all done." |
| `status` | Current config + active runs. |
| `enable` / `disable` | Master switch (writes config.enabled). |
| `test_per_agent` / `test_all_complete` | Plays the sound, no state change. |

## Open-source surface

- MIT license.
- README with single-line install + 3-line settings.json snippet for Claude
  Code, plus an OpenClaw skill.
- `site/index.html` — landing page in the agent-bridge minimal-distinctive
  aesthetic but visually distinct (different color story; bell/chime motif
  rather than peer-bridge motif). GitHub Pages-ready, not deployed by us.

## Trade-offs / known limits (v0.1)

- **OpenClaw integration** in v0.1 ships as a skill+CLI hook the user wires
  manually (drop a one-liner into the OpenClaw subagent finalizer script
  Ethan already uses). A fsnotify watcher on `runs.json` is a v0.2 follow-up.
- ~~**No cross-machine state**~~ — addressed in v0.3.0 via Mini-as-master
  forwarding (see "Mini-as-master architecture" below).
- **No volume control** beyond afplay's default — easy to add `-v 0..1` flag
  later.
- **macOS only** in v0.1 (afplay-dependent). Linux/Windows fallback to a tiny
  `node-speaker` or `aplay`/`powershell beep` as a v0.2 nice-to-have.

## Mini-as-master architecture (v0.3.0, 2026-05-04)

When running across multiple paired Macs, the chime fires on ONE machine only —
the designated "master". Peers forward their completion events to the master
via SFTP (powered by `EthanSK/agent-bridge`) instead of playing locally.

### Why

There's only one human at the desk. The pre-v0.3.0 model played a chime on
EVERY paired Mac when ANY agent finished on ANY of them — redundant and
annoying. The Mini-as-master model designates a single sole-player so the
audible feedback isn't fan-out spam.

Decision context: Ethan voice 6286, 2026-05-04. "the Mac Mini is like the one
playing it, so they all have to tell the Mac Mini or whatever the master one
is that they're done."

### How

```
   peer machine (e.g. MacBookPro)              master machine (Mini)
   ┌───────────────────────────┐               ┌───────────────────────────┐
   │ Claude Code Stop hook     │               │ ~/.agent-bridge/inbox/    │
   │   ↓                       │               │   agent-bridge/chime/     │
   │ chime.js end --from-...   │   SFTP ──→   │   <id>.json               │
   │   ↓ role=peer             │               │   ↓ daemon polls (2s)    │
   │ markEnd → forward         │               │ chime/service.mjs         │
   │ Skip local playback       │               │   processInboxOnce()      │
   └───────────────────────────┘               │   ↓ applyControlEvent     │
                                               │   ↓ playSound(Glass)      │
                                               │     [+ Hero on idle]      │
                                               └───────────────────────────┘
```

- `master_machine` in `~/.agent-completion-chime/config.json` selects the
  sole-player. Default `"Ethans-Mac-mini"`. Set to `null` for legacy local-play
  on every machine.
- `agent_bridge_path` points to a checkout of `EthanSK/agent-bridge`. Defaults
  to `~/Projects/agent-bridge`. The standalone CLI dynamically imports
  `chime/emitter.mjs` from that path to reuse the bridge's SFTP machinery.
- If forwarding fails (master unreachable, agent-bridge not installed), the
  CLI falls back to local play. Better to chime on the wrong machine than to
  drop the audio cue silently.
- The master's daemon (`agent-bridge/chime/service.mjs`) also keeps a peer
  registry at `~/.agent-bridge/chime/peers.json`. Peers send `chime.register`
  on daemon startup and refresh via heartbeats. Today the registry is
  informational (peers can forward without prior register) — useful for
  debugging fleet wiring.
- Bonus UX: the master plays peer-originated chimes at a slightly higher
  pitch (afplay `-r 1.05`) so Ethan can audibly distinguish "from the laptop"
  from "from the desk". Disable with `remotePitchRate: 1` in the bridge-side
  chime config.

## Risks the user flagged in the brief

- "macOS API requires SwiftUI which needs Xcode" — **avoided.** Pure Node +
  `afplay` shells out to a system-shipped binary. No Swift, no Electron, no
  GUI.
- "4-hour budget" — daemon-less design + reuse of agent-bridge patterns keeps
  the LOC small. Aiming for ~400 LOC total (CLI + MCP + state module).
