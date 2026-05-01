#!/usr/bin/env bash
#
# agent-completion-chime/scripts/install.sh
# -----------------------------------------
# Wires agent-completion-chime into:
#   1. Claude Code  — registers as a directory-source plugin marketplace +
#                     enabled plugin in ~/.claude/settings.json. Adds Stop +
#                     SubagentStop hooks that fire `chime end --from-claude-*`.
#   2. OpenClaw     — registers plugin entry in ~/.openclaw/openclaw.json
#                     (plugins.entries + plugins.load.paths) so OC can see the
#                     plugin manifest.
#   3. launchd      — installs a LaunchAgent that keeps the OpenClaw runs
#                     watcher alive (translates OC subagent state changes
#                     into chime start/end events).
#
# Idempotent. Safe to run multiple times. Backs up touched files first to
# *.bak.<unix-ts> so a failed run can be rolled back.
#
# Usage:
#   scripts/install.sh                # full install
#   scripts/install.sh --dry-run      # show what would change, touch nothing
#   scripts/install.sh --skip-openclaw  # skip OpenClaw + watcher steps
#   scripts/install.sh --skip-watcher   # skip the launchd LaunchAgent only
#   scripts/install.sh --uninstall    # remove all wiring (best effort)

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=0
SKIP_OPENCLAW=0
SKIP_WATCHER=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-openclaw) SKIP_OPENCLAW=1 ;;
    --skip-watcher) SKIP_WATCHER=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

CLAUDE_DIR="$HOME/.claude"
SETTINGS_PATH="$CLAUDE_DIR/settings.json"
OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_PATH="$OPENCLAW_DIR/openclaw.json"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_LABEL="com.ethansk.agent-completion-chime.watcher"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${PLIST_LABEL}.plist"

TS="$(date +%s)"

note()  { echo "[chime-install] $*"; }
warn()  { echo "[chime-install][warn] $*" >&2; }

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found — install Node.js >=18 first."
    exit 1
  fi
}

backup_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cp "$f" "${f}.bak.${TS}"
    note "backed up $f -> ${f}.bak.${TS}"
  fi
}

# ---------------------------------------------------------------------------
# 1. Claude Code wiring (settings.json)
# ---------------------------------------------------------------------------

wire_claude() {
  if [[ ! -d "$CLAUDE_DIR" ]]; then
    note "no ~/.claude/ — skipping Claude Code wiring"
    return 0
  fi
  if (( DRY_RUN )); then
    note "[dry-run] would patch $SETTINGS_PATH (extraKnownMarketplaces, enabledPlugins, hooks.Stop/SubagentStop)"
    return 0
  fi

  backup_file "$SETTINGS_PATH"

  REPO_ROOT="$REPO_ROOT" \
  SETTINGS_PATH="$SETTINGS_PATH" \
  UNINSTALL="$UNINSTALL" \
  node - <<'NODE'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const p = process.env.SETTINGS_PATH;
const repo = process.env.REPO_ROOT;
const uninstall = process.env.UNINSTALL === '1';

let data = {};
if (existsSync(p)) {
  try { data = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    console.error('settings.json parse failed:', e.message);
    process.exit(1);
  }
}

data.extraKnownMarketplaces = data.extraKnownMarketplaces || {};
data.enabledPlugins         = data.enabledPlugins         || {};
data.hooks                  = data.hooks                  || {};

const chimeBin = `${repo}/bin/chime.js`;
const stopCmd     = `node ${chimeBin} end --from-claude-stop --quiet || true`;
const subStopCmd  = `node ${chimeBin} end --from-claude-subagent --quiet || true`;

let changed = false;

const upsertHook = (eventName, command) => {
  const hooks = (data.hooks[eventName] = data.hooks[eventName] || []);
  // Find the matcher:"" group (or create one).
  let group = hooks.find((g) => (g.matcher ?? '') === '');
  if (!group) {
    group = { matcher: '', hooks: [] };
    hooks.push(group);
    changed = true;
  }
  group.hooks = group.hooks || [];
  // Idempotent: check by exact command string OR by the chime.js token.
  const existsAlready = group.hooks.some((h) =>
    typeof h?.command === 'string' && h.command.includes(chimeBin),
  );
  if (uninstall) {
    const before = group.hooks.length;
    group.hooks = group.hooks.filter((h) =>
      !(typeof h?.command === 'string' && h.command.includes(chimeBin)),
    );
    if (group.hooks.length !== before) changed = true;
    return;
  }
  if (!existsAlready) {
    group.hooks.push({ type: 'command', command });
    changed = true;
  } else {
    // Update in place if command changed.
    for (const h of group.hooks) {
      if (typeof h?.command === 'string' && h.command.includes(chimeBin) && h.command !== command) {
        h.command = command;
        changed = true;
      }
    }
  }
};

if (uninstall) {
  if (data.extraKnownMarketplaces['agent-completion-chime']) {
    delete data.extraKnownMarketplaces['agent-completion-chime'];
    changed = true;
  }
  if (data.enabledPlugins['agent-completion-chime@agent-completion-chime']) {
    delete data.enabledPlugins['agent-completion-chime@agent-completion-chime'];
    changed = true;
  }
  upsertHook('Stop', stopCmd);
  upsertHook('SubagentStop', subStopCmd);
} else {
  const cur = data.extraKnownMarketplaces['agent-completion-chime'];
  const desired = { source: { source: 'directory', path: repo } };
  if (JSON.stringify(cur) !== JSON.stringify(desired)) {
    data.extraKnownMarketplaces['agent-completion-chime'] = desired;
    changed = true;
  }
  if (!data.enabledPlugins['agent-completion-chime@agent-completion-chime']) {
    data.enabledPlugins['agent-completion-chime@agent-completion-chime'] = true;
    changed = true;
  }
  upsertHook('Stop', stopCmd);
  upsertHook('SubagentStop', subStopCmd);
}

if (changed) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  console.log('settings.json: changed');
} else {
  console.log('settings.json: already up-to-date');
}
NODE

  # Validate JSON post-write.
  if ! node -e "JSON.parse(require('fs').readFileSync('$SETTINGS_PATH','utf8'))" 2>/dev/null; then
    warn "post-write JSON validation FAILED for $SETTINGS_PATH — rolling back"
    cp "${SETTINGS_PATH}.bak.${TS}" "$SETTINGS_PATH"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 2. OpenClaw wiring (~/.openclaw/openclaw.json)
# ---------------------------------------------------------------------------

wire_openclaw() {
  if (( SKIP_OPENCLAW )); then
    note "skipping OpenClaw wiring (--skip-openclaw)"
    return 0
  fi
  if [[ ! -d "$OPENCLAW_DIR" ]]; then
    note "no ~/.openclaw/ — skipping OpenClaw wiring"
    return 0
  fi
  if (( DRY_RUN )); then
    note "[dry-run] would patch $OPENCLAW_PATH (plugins.entries.agent-completion-chime, plugins.load.paths)"
    return 0
  fi

  backup_file "$OPENCLAW_PATH"

  REPO_ROOT="$REPO_ROOT" \
  OPENCLAW_PATH="$OPENCLAW_PATH" \
  UNINSTALL="$UNINSTALL" \
  node - <<'NODE'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const p = process.env.OPENCLAW_PATH;
const repo = process.env.REPO_ROOT;
const uninstall = process.env.UNINSTALL === '1';

let data = {};
if (existsSync(p)) {
  try { data = JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    console.error('openclaw.json parse failed:', e.message);
    process.exit(1);
  }
}

data.plugins = data.plugins || {};
data.plugins.entries = data.plugins.entries || {};
data.plugins.load = data.plugins.load || {};
data.plugins.load.paths = Array.isArray(data.plugins.load.paths) ? data.plugins.load.paths : [];

let changed = false;

if (uninstall) {
  if (data.plugins.entries['agent-completion-chime']) {
    delete data.plugins.entries['agent-completion-chime'];
    changed = true;
  }
  const before = data.plugins.load.paths.length;
  data.plugins.load.paths = data.plugins.load.paths.filter((x) => x !== repo);
  if (data.plugins.load.paths.length !== before) changed = true;
} else {
  if (!data.plugins.entries['agent-completion-chime']) {
    data.plugins.entries['agent-completion-chime'] = {
      enabled: true,
      config: { watcherAutoStart: true },
    };
    changed = true;
  }
  if (!data.plugins.load.paths.includes(repo)) {
    data.plugins.load.paths.push(repo);
    changed = true;
  }
}

if (changed) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  console.log('openclaw.json: changed');
} else {
  console.log('openclaw.json: already up-to-date');
}
NODE

  if ! node -e "JSON.parse(require('fs').readFileSync('$OPENCLAW_PATH','utf8'))" 2>/dev/null; then
    warn "post-write JSON validation FAILED for $OPENCLAW_PATH — rolling back"
    cp "${OPENCLAW_PATH}.bak.${TS}" "$OPENCLAW_PATH"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 3. launchd LaunchAgent for the OpenClaw runs watcher
# ---------------------------------------------------------------------------

wire_watcher() {
  if (( SKIP_WATCHER )); then
    note "skipping watcher LaunchAgent (--skip-watcher)"
    return 0
  fi
  if [[ ! -d "$OPENCLAW_DIR" ]]; then
    note "no ~/.openclaw/ — skipping watcher LaunchAgent"
    return 0
  fi
  if (( DRY_RUN )); then
    note "[dry-run] would write $PLIST_PATH and load it"
    return 0
  fi

  mkdir -p "$LAUNCH_AGENTS_DIR"

  if (( UNINSTALL )); then
    if [[ -f "$PLIST_PATH" ]]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      note "removed $PLIST_PATH"
    fi
    return 0
  fi

  local node_bin
  node_bin="$(command -v node)"
  if [[ -z "$node_bin" ]]; then
    warn "node binary not found — cannot install LaunchAgent"
    return 1
  fi

  local watcher_script="$REPO_ROOT/scripts/openclaw-watcher.js"
  local out_log="$HOME/.agent-completion-chime/watcher.log"
  local err_log="$HOME/.agent-completion-chime/watcher.err"
  mkdir -p "$HOME/.agent-completion-chime"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${watcher_script}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>         <string>${HOME}</string>
    <key>PATH</key>         <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key>      <true/>
  <key>RunAtLoad</key>      <true/>
  <key>ThrottleInterval</key>  <integer>30</integer>
  <key>StandardOutPath</key>   <string>${out_log}</string>
  <key>StandardErrorPath</key> <string>${err_log}</string>
</dict>
</plist>
PLIST
  note "wrote $PLIST_PATH"

  # Reload (unload + load) so changes take effect.
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  if launchctl load "$PLIST_PATH" 2>/dev/null; then
    note "launchctl load: $PLIST_LABEL"
  else
    warn "launchctl load failed; you may need to load manually:"
    warn "  launchctl load \"$PLIST_PATH\""
  fi
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

require_node

note "repo:    $REPO_ROOT"
note "settings: $SETTINGS_PATH"
note "openclaw: $OPENCLAW_PATH"
note "launchd:  $PLIST_PATH"
if (( UNINSTALL )); then note "MODE: uninstall"; fi
if (( DRY_RUN )); then note "MODE: dry-run"; fi

wire_claude
wire_openclaw
wire_watcher

note "done. Run \`node $REPO_ROOT/bin/chime.js install-status\` for a wiring truth-table."
