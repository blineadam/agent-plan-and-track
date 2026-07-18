<#
.SYNOPSIS
  Fetch the docx/pdf/pptx/xlsx skills live from anthropics/skills and install
  them for whichever of Claude Code, Codex, and GitHub Copilot are present on
  this machine (Windows sibling of install-office-skills.sh).

.DESCRIPTION
  Entry point: powershell -ExecutionPolicy Bypass -File install-office-skills.ps1

  Separate from install.ps1: these 4 skills carry an upstream LICENSE.txt that
  forbids redistribution outside Anthropic's own Services, so this repo never
  vendors them under skills/. Instead this script shells out to the
  third-party `skills` npm CLI (vercel-labs/skills) to clone them straight
  from Anthropic's own repo at install time, so nothing restricted is ever
  stored here. Requires network access and npx (Node/npm).

  Each harness is detected independently, and the shared fetch step runs
  whenever at least one is detected, regardless of which: `--agent codex` in
  the fetch below is only a directory-routing label the fetch tool uses (it
  writes to .agents/skills/ relative to cwd), not a dependency on the codex
  CLI actually being installed.

  PARITY: this script and install-office-skills.sh must stay in lockstep.
#>

$ErrorActionPreference = 'Stop'
$SourceRepo = 'https://github.com/anthropics/skills'
$Skills = @('docx', 'pdf', 'pptx', 'xlsx')
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
# Pinned, reviewed version of the third-party fetch tool (vercel-labs/skills),
# which itself declares a Node >=22.20.0 engine requirement.
$SkillsCli = 'skills@1.5.19'
$SkillsCliMinNode = [version]'22.20.0'

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Error "npx is required (install Node.js)"
  exit 1
}
$nodeVersion = [version]((& node --version) -replace '^v', '')
if ($nodeVersion -lt $SkillsCliMinNode) {
  Write-Error "$SkillsCli requires Node >=$SkillsCliMinNode (found $nodeVersion)"
  exit 1
}

$haveClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$haveCodex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
$haveCopilot = Test-Path -LiteralPath (Join-Path $HomeDir '.copilot')

if (-not $haveClaude -and -not $haveCodex -and -not $haveCopilot) {
  Write-Host "No Claude Code, Codex, or Copilot installation detected; nothing to do."
  exit 0
}

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
  $skillArgs = @()
  foreach ($s in $Skills) { $skillArgs += @('--skill', $s) }

  Push-Location $scratch
  try {
    & npx --yes $SkillsCli add $SourceRepo @skillArgs --agent codex --copy -y
    if ($LASTEXITCODE -ne 0) { throw "npx skills add failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $fetched = Join-Path $scratch '.agents\skills'
  if (-not (Test-Path -LiteralPath $fetched)) {
    Write-Error "fetch did not produce $fetched"
    exit 1
  }

  # Merge a directory tree into $dest, overwriting matching files but never
  # removing files whose source was deleted (the `cp -R` semantics the Bash
  # twin relies on). Reliable across PowerShell versions, unlike Copy-Item
  # -Recurse into an existing folder; mirrors install.ps1's own Copy-Tree.
  function Copy-Tree($src, $dst) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $src -Recurse -Force) {
      $rel = $item.FullName.Substring($src.Length + 1)
      $target = Join-Path $dst $rel
      if ($item.PSIsContainer) {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
      } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $item.FullName -Destination $target -Force
      }
    }
  }

  function Install-Into($dest, $label) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($s in $Skills) {
      Copy-Tree (Join-Path $fetched $s) (Join-Path $dest $s)
    }
    Write-Host "  $label -> $dest/{$($Skills -join ',')}"
  }

  if ($haveClaude) { Install-Into (Join-Path $HomeDir '.claude\skills') 'Claude Code' }
  else { Write-Host "  Claude Code -- not detected, skipped" }
  if ($haveCodex) { Install-Into (Join-Path $HomeDir '.agents\skills') 'Codex      ' }
  else { Write-Host "  Codex       -- not detected, skipped" }
  if ($haveCopilot) { Install-Into (Join-Path $HomeDir '.copilot\skills') 'Copilot    ' }
  else { Write-Host "  Copilot     -- not detected, skipped" }

  Write-Host "done."
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
