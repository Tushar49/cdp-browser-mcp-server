# scripts/sync-to-code-backup.ps1
# Sync current branch (dev/main) into the code_backup branch, including the
# .temp/, .research/, and .prompts/ directories that are normally gitignored.
#
# Usage:
#   pwsh -File scripts/sync-to-code-backup.ps1            # real run
#   pwsh -File scripts/sync-to-code-backup.ps1 -DryRun    # preview only
#   pwsh -File scripts/sync-to-code-backup.ps1 -NoPush    # commit but skip push
#   pwsh -File scripts/sync-to-code-backup.ps1 -Message "custom msg"
#
# Notes:
# - code_backup uses the same .gitignore as dev, so the ignored dirs must be
#   force-added (`git add -f`) on every sync.
# - The script aborts if the working tree is dirty, unless -DryRun is set.
# - Always returns to the original branch on success.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoPush,
  [string]$Message = "sync: backup to code_backup ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($currentBranch -eq 'code_backup') {
  Write-Error "Already on code_backup. Switch to dev or main first."
  exit 1
}

$dirty = git status --porcelain
if ($dirty -and -not $DryRun) {
  Write-Error "Working tree dirty on '$currentBranch'. Commit or stash first, or run with -DryRun."
  Write-Host $dirty
  exit 1
}

$ignoredDirs = @('.temp', '.research', '.prompts') | Where-Object { Test-Path $_ }

if ($DryRun) {
  Write-Host "[DRY] current branch: $currentBranch"
  Write-Host "[DRY] would: git checkout code_backup"
  Write-Host "[DRY] would: git merge --no-ff $currentBranch -m 'merge $currentBranch into code_backup'"
  if ($ignoredDirs) {
    Write-Host "[DRY] would: git add -f $($ignoredDirs -join ' ')"
  } else {
    Write-Host "[DRY] no ignored dirs present to force-add"
  }
  Write-Host "[DRY] would: git commit -m `"$Message`" (only if changes staged)"
  if (-not $NoPush) { Write-Host "[DRY] would: git push origin code_backup" }
  Write-Host "[DRY] would: git checkout $currentBranch"
  exit 0
}

Write-Host "==> Switching to code_backup"
git checkout code_backup

try {
  Write-Host "==> Merging $currentBranch into code_backup"
  git merge --no-ff $currentBranch -m "merge $currentBranch into code_backup"

  if ($ignoredDirs) {
    Write-Host "==> Force-adding ignored dirs: $($ignoredDirs -join ', ')"
    git add -f @ignoredDirs
  }

  $staged = git diff --cached --name-only
  if ($staged) {
    Write-Host "==> Committing $(@($staged).Count) staged path(s)"
    git commit -m $Message
    if (-not $NoPush) {
      Write-Host "==> Pushing code_backup"
      git push origin code_backup
    }
  } else {
    Write-Host "==> Nothing new to commit on code_backup"
  }
} finally {
  Write-Host "==> Returning to $currentBranch"
  git checkout $currentBranch
}

Write-Host "Sync complete. Back on $currentBranch."
