#!/usr/bin/env bash
# Run ONLY through the authorized remote terminal in an existing project directory.
# A separate remote read of the produced records is required before claiming success.
set -euo pipefail
if [[ $# != 1 || ! -d "$1" ]]; then
  echo 'Usage: remote-workspace-check.sh EXISTING_AUTHORIZED_PROJECT_DIRECTORY' >&2
  exit 2
fi
cd -- "$1"
[[ "$PWD" != / ]] || { echo 'Refusing filesystem root' >&2; exit 2; }
record="$(mktemp -d "$PWD/.browserbase-observability.XXXXXX")"
printf '%s\n' "browserbase-workspace-check:${record##*/}" > "$record/sentinel.txt"
printf '%s\n' "$PWD" > "$record/cwd.txt"
printf '%s\n' "bash -c: emit stdout, emit stderr, exit 7" > "$record/command.txt"
set +e
bash -c 'printf "stdout-visible\n"; printf "stderr-visible\n" >&2; exit 7' > "$record/stdout.txt" 2> "$record/stderr.txt"
status=$?
set -e
printf '%s\n' "$status" > "$record/exit-status.txt"
printf 'Records for a separate remote read: %s\n' "$record"
[[ "$status" == 7 ]]
