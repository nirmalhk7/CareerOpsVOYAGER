#!/usr/bin/env bash
# Antigravity Turbo launcher for career-ops: no permission prompts, accept edits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Flags before -p: -p consumes the next argv as the prompt.
exec agy --dangerously-skip-permissions --mode accept-edits --project career-ops "$@"
