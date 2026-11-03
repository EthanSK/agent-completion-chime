# agent-completion-chime

**Make a sound when AI agents finish.** One chime per agent. A different chime when ALL parallel agents are done.

Plays macOS built-in sounds via `afplay`. Hooks into Claude Code, OpenClaw, or anything else that can run a shell command on exit. Configurable by talking to an agent (MCP server included).

```
npm install -g agent-completion-chime
chime test per-agent       # → Glass.aiff
chime test all-complete    # → Hero.aiff
```

## Why

When you run several Claude Code subagents in parallel and walk away, you want to know:

1. **One agent finished** — did the small one wrap up while you were getting coffee?
2. **They're ALL done** — can I come back to the desk?

Two distinct sounds. No notification spam, no Electron, no menubar app. Just a chime.

## Install

### One-shot install (recommended)

Clone the repo somewhere, then:

```
bash scripts/install.sh
```

This wires the plugin into:

- **Claude Code** — registers as a directory-source plugin marketplace + enabled plugin in `~/.claude/settings.json`. Adds `Stop` and `SubagentStop` hooks that call `chime end --from-claude-stop` / `chime end --from-claude-subagent`. The MCP server (9 config tools) loads on next session start.
- **OpenClaw** — registers `plugins.entries.agent-completion-chime` and adds the repo path to `plugins.load.paths` in `~/.openclaw/openclaw.json`.
- **launchd** — installs `~/Library/LaunchAgents/com.ethansk.agent-completion-chime.watcher.plist`, a `KeepAlive` LaunchAgent that runs `scripts/openclaw-watcher.js`. The watcher tails `~/.openclaw/subagents/runs.json` and translates OpenClaw run state changes into chime start/end events.

Idempotent. Safe to re-run. Backs up touched files to `*.bak.<unix-ts>` first. Run `bash scripts/install.sh --dry-run` to preview, `--uninstall` to remove. Verify with:

```
node bin/chime.js install-status
```

After install you must **fully restart Claude Code** to load the new MCP server (per the `~/.claude/CLAUDE.md` `/reload-plugins is NOT a hot-reload` rule).

### npm-only install (no harness wiring)

```
npm install -g agent-completion-chime
```

This installs two binaries — `chime` (CLI) and `agent-completion-chime-mcp` (MCP stdio server) — but does NOT wire them into Claude Code or OpenClaw. State and config live in `~/.agent-completion-chime/`.

## Hook into Claude Code

Add `Stop` and `SubagentStop` entries to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "chime end --from-claude-hook --quiet" }]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "chime end --from-claude-subagent --quiet" }]
      }
    ]
  }
}
```

Optional but recommended — also fire `chime start` on `UserPromptSubmit` (parent) and `SubagentStart` so the active-runs counter is accurate. If you skip the start hooks, the per-agent chime still works on every Stop, and the all-complete chime fires whenever the active set drains to zero.

## Hook into OpenClaw

Two options:

1. **Watcher (zero-edit):** run the bundled watcher in the background. It tails `~/.openclaw/subagents/runs.json` and translates run-state transitions into chime events.

   ```
   nohup node $(npm root -g)/agent-completion-chime/scripts/openclaw-watcher.js > /tmp/chime-openclaw.log 2>&1 &
   ```

2. **Direct hook:** if you have a custom OpenClaw subagent finalizer, drop in:

   ```bash
   chime end "openclaw:$RUN_ID" --source openclaw --quiet
   ```

## Hook into anything else

```bash
chime start "ci-build-$BUILD_ID" --source github-actions
# ... do work ...
chime end "ci-build-$BUILD_ID" --source github-actions
```

## Configure by talking to an agent

Add the MCP server to your Claude Code or any MCP-aware host:

```json
{
  "mcpServers": {
    "agent-completion-chime": {
      "command": "agent-completion-chime-mcp"
    }
  }
}
```

Then, in chat:

> "Set the per-agent chime to Pop and the all-complete chime to Submarine."
> "List the available sounds."
> "Disable the chime for an hour."

The MCP server exposes:

| Tool | Purpose |
| --- | --- |
| `chime_status` | Current config + active runs. |
| `chime_list_sounds` | All 14 macOS built-ins. |
| `chime_set_per_agent_sound` | Set the per-agent sound (plays a preview). |
| `chime_set_all_complete_sound` | Set the all-complete sound (plays a preview). |
| `chime_set_volume` | 0.0 silent → 1.0 full. |
| `chime_enable` / `chime_disable` | Master switch. |
| `chime_test` | Preview a configured sound without changing state. |
| `chime_reset_active` | Clear stuck active runs. |

## Sounds

The 14 macOS built-ins live in `/System/Library/Sounds/`:

```
Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink
```

Defaults: `per_agent_sound=Glass`, `all_complete_sound=Hero`. You can also pass an absolute path to any `.aiff/.wav/.mp3` for custom chimes.

## CLI reference

```
chime start <run_id> [--source name] [--label text]
chime end   <run_id> [--source name] [--label text]
chime end   --from-claude-hook        (Stop event, payload on stdin)
chime end   --from-claude-subagent    (SubagentStop event, payload on stdin)

chime status
chime sounds
chime config get
chime config set per_agent_sound Glass
chime config set all_complete_sound Hero
chime config set volume 0.7
chime test per-agent | all-complete
chime enable | disable
chime reset                            # clears active runs
chime install-status [--json]          # Y/N truth-table of CC + OC + watcher wiring
```

## State

- `~/.agent-completion-chime/config.json` — persistent config.
- `~/.agent-completion-chime/state.json` — active runs + last-fired timestamps + 100-event ring buffer.
- `~/.agent-completion-chime/chime.log` — append-only NDJSON event log.

## How "all parallel agents complete" detection works

State holds an `active` set keyed by run id (Claude session id, OpenClaw run id, or whatever you pass). Every `chime start` adds; every `chime end` removes. When the set drains to empty, the all-complete sound plays — once per drain (4 s cooldown, configurable).

Stale entries (>2 h) are GC'd automatically before each evaluation, so a missed `end` doesn't permanently silence the all-complete chime.

## Tests

```
node --test test/*.test.js
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design + trade-off notes.

## License

MIT — see [LICENSE](./LICENSE).
