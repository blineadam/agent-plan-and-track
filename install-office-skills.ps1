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
  third-party `skills` npm CLI (vercel-labs/skills) to install them straight
  from Anthropic's own repo at install time, so nothing restricted is ever
  stored here. Requires network access and npx (Node/npm).

  Each detected harness gets its own `skills add --agent <id> -g` global
  install, rather than a single shared fetch copied by hand into each
  destination. Codex and GitHub Copilot both resolve to the same shared
  ~/.agents/skills directory: GitHub's own docs for Copilot CLI agent skills
  list ~/.agents/skills as an officially supported personal-skills location
  alongside ~/.copilot/skills, and the `skills` CLI's own agent registry
  treats any agent whose skills directory is ".agents/skills" as sharing that
  one canonical global path. When both are present the two installs write the
  same files there, which is harmless; re-running either install is also a
  harmless no-op.

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

$skillArgs = @()
foreach ($s in $Skills) { $skillArgs += @('--skill', $s) }

function Install-For($agent) {
  & npx --yes $SkillsCli add $SourceRepo @skillArgs --agent $agent -g --copy -y
  if ($LASTEXITCODE -ne 0) { throw "npx skills add failed for agent '$agent' with exit code $LASTEXITCODE" }
}

if ($haveClaude) { Write-Host "Claude Code:"; Install-For 'claude-code' }
else { Write-Host "  Claude Code -- not detected, skipped" }
if ($haveCodex) { Write-Host "Codex:"; Install-For 'codex' }
else { Write-Host "  Codex       -- not detected, skipped" }
if ($haveCopilot) { Write-Host "Copilot:"; Install-For 'github-copilot' }
else { Write-Host "  Copilot     -- not detected, skipped" }

Write-Host "done."
