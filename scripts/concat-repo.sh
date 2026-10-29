#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)
OUTPUT="$ROOT/repository.txt"

usage() {
  printf 'Usage: %s [-o|--output FILE]\n' "$0"
}

while (($#)); do
  case "$1" in
    -o|--output)
      if (($# < 2)); then
        usage >&2
        exit 2
      fi
      OUTPUT=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

OUTPUT_REAL=$(realpath -m -- "$OUTPUT")
mkdir -p -- "$(dirname -- "$OUTPUT")"
TRACKED_LIST=$(mktemp)
trap 'rm -f -- "$TRACKED_LIST"' EXIT

if ! git -C "$ROOT" ls-files -z > "$TRACKED_LIST"; then
  printf 'error: git ls-files failed\n' >&2
  exit 1
fi

written=0
skipped=()

while IFS= read -r -d '' relative_path; do
  source="$ROOT/$relative_path"
  if [[ $(realpath -m -- "$source") == "$OUTPUT_REAL" ]]; then
    skipped+=("$relative_path (output file)")
    continue
  fi
  if [[ ! -f "$source" || -L "$source" ]]; then
    skipped+=("$relative_path (missing or not a regular file)")
    continue
  fi
  if [[ -s "$source" ]] && ! LC_ALL=C grep -Iq . "$source"; then
    skipped+=("$relative_path (binary file)")
    continue
  fi
  if ! iconv -f UTF-8 -t UTF-8 "$source" >/dev/null 2>&1; then
    skipped+=("$relative_path (binary or non-UTF-8 file)")
    continue
  fi

  printf '================\n%s\n================\n\n' "$relative_path"
  if ! cat -- "$source"; then
    printf 'error: cannot read %s\n' "$relative_path" >&2
    exit 1
  fi
  printf '\n---\n\n'
  ((written += 1))
done < "$TRACKED_LIST" > "$OUTPUT"

printf 'Wrote %d files to %s\n' "$written" "$OUTPUT"
if ((${#skipped[@]})); then
  printf 'Skipped files:\n' >&2
  printf '  %s\n' "${skipped[@]}" >&2
fi
