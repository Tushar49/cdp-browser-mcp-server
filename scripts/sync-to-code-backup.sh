#!/usr/bin/env bash
# scripts/sync-to-code-backup.sh
# Sync current branch (dev/main) into the code_backup branch, including the
# .temp/, .research/, and .prompts/ directories that are normally gitignored.
#
# Usage:
#   ./scripts/sync-to-code-backup.sh                # real run
#   ./scripts/sync-to-code-backup.sh --dry-run      # preview only
#   ./scripts/sync-to-code-backup.sh --no-push      # commit but skip push
#   ./scripts/sync-to-code-backup.sh -m "custom"    # custom commit message
#
# Notes:
# - code_backup uses the same .gitignore as dev, so the ignored dirs must be
#   force-added (`git add -f`) on every sync.
# - The script aborts if the working tree is dirty, unless --dry-run is set.
# - Always returns to the original branch on success.

set -euo pipefail

DRY_RUN=0
NO_PUSH=0
MESSAGE="sync: backup to code_backup ($(date '+%Y-%m-%d %H:%M'))"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    -m|--message) MESSAGE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" == "code_backup" ]]; then
  echo "Already on code_backup. Switch to dev or main first." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" && $DRY_RUN -eq 0 ]]; then
  echo "Working tree dirty on '$CURRENT_BRANCH'. Commit or stash first, or use --dry-run." >&2
  git status --short
  exit 1
fi

IGNORED_DIRS=()
for d in .temp .research .prompts; do
  [[ -d "$d" ]] && IGNORED_DIRS+=("$d")
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[DRY] current branch: $CURRENT_BRANCH"
  echo "[DRY] would: git checkout code_backup"
  echo "[DRY] would: git merge --no-ff $CURRENT_BRANCH -m 'merge $CURRENT_BRANCH into code_backup'"
  if [[ ${#IGNORED_DIRS[@]} -gt 0 ]]; then
    echo "[DRY] would: git add -f ${IGNORED_DIRS[*]}"
  else
    echo "[DRY] no ignored dirs present to force-add"
  fi
  echo "[DRY] would: git commit -m \"$MESSAGE\" (only if changes staged)"
  [[ $NO_PUSH -eq 0 ]] && echo "[DRY] would: git push origin code_backup"
  echo "[DRY] would: git checkout $CURRENT_BRANCH"
  exit 0
fi

cleanup() {
  echo "==> Returning to $CURRENT_BRANCH"
  git checkout "$CURRENT_BRANCH"
}
trap cleanup EXIT

echo "==> Switching to code_backup"
git checkout code_backup

echo "==> Merging $CURRENT_BRANCH into code_backup"
git merge --no-ff "$CURRENT_BRANCH" -m "merge $CURRENT_BRANCH into code_backup"

if [[ ${#IGNORED_DIRS[@]} -gt 0 ]]; then
  echo "==> Force-adding ignored dirs: ${IGNORED_DIRS[*]}"
  git add -f "${IGNORED_DIRS[@]}"
fi

if [[ -n "$(git diff --cached --name-only)" ]]; then
  echo "==> Committing staged paths"
  git commit -m "$MESSAGE"
  if [[ $NO_PUSH -eq 0 ]]; then
    echo "==> Pushing code_backup"
    git push origin code_backup
  fi
else
  echo "==> Nothing new to commit on code_backup"
fi

echo "Sync complete."
