#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
/bin/bash "$ROOT/scripts/build.sh" >/dev/null
python3 "$ROOT/scripts/launch.py"
