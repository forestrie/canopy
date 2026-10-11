#!/usr/bin/env bash
# Throwaway probe (agentfiles plan 2610-01): can a cloud session install the
# forestrie-agents plugins from a SessionStart hook? Stdout becomes session
# context, so the session can report what happened. Never merge this branch.
set -u
# Local sessions run under a profile (CLAUDE_CONFIG_DIR); leave those alone.
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then echo "probe: skipped (CLAUDE_CONFIG_DIR set)"; exit 0; fi
log="${CLAUDE_PROJECT_DIR:-.}/.claude/probe.log"
{
  echo "== probe-plugin-install $(date -u +%FT%TZ)"
  echo "CLAUDE_CODE_REMOTE=${CLAUDE_CODE_REMOTE:-unset} HOME=$HOME"
  echo "claude: $(command -v claude || echo missing) $(claude --version 2>&1 | head -1)"
  echo "-- installed before:"; cat "$HOME/.claude/plugins/installed_plugins.json" 2>&1 | head -20
  echo "-- marketplace add:"
  env -u CLAUDECODE claude plugin marketplace add forestrie/forestrie-agents 2>&1 | tail -5
  for p in forestrie-core@forestrie-agents mattpocock-skills@forestrie-agents; do
    echo "-- install $p:"; env -u CLAUDECODE claude plugin install "$p" 2>&1 | tail -5
  done
  echo "-- installed after:"; cat "$HOME/.claude/plugins/installed_plugins.json" 2>&1 | head -40
} > "$log" 2>&1
cat "$log"
exit 0
