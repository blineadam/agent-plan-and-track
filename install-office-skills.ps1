<#
.SYNOPSIS
  Fetch the docx/pdf/pptx/xlsx skills live from anthropics/skills and install
  them for whichever of Claude Code, Codex, and GitHub Copilot are present on
  this machine, or remove them again (Windows sibling of
  install-office-skills.sh).

.DESCRIPTION
  Entry point:
      powershell -ExecutionPolicy Bypass -File install-office-skills.ps1 [install|uninstall]

  The verb defaults to install when omitted: README.md, AGENTS.md, and the
  CI install workflow all invoke this script with no arguments and must keep
  working, so a missing arg is not an error here the way it is in install.ps1
  (which requires exactly one arg). This is a deliberate divergence from
  install.ps1's Usage shape, made only for the zero-arg default.

  Separate from install.ps1: these 4 skills carry an upstream LICENSE.txt that
  forbids redistribution outside Anthropic's own Services, so this repo never
  vendors them under skills/. Instead this script shells out to the
  third-party `skills` npm CLI (vercel-labs/skills) to install them straight
  from Anthropic's own repo at install time, so nothing restricted is ever
  stored here. That fetch needs network access and npx (Node/npm); uninstall
  needs neither, since it only deletes directories already on disk. The
  npx-existence and Node-minimum-version gates therefore run only on the
  install path: making a cleanup depend on a toolchain it never uses would
  strand anyone whose Node install is gone, broken, or never present.

  Each detected harness gets its own `skills add --agent <id> -g` global
  install, rather than a single shared fetch copied by hand into each
  destination. Codex and GitHub Copilot both resolve to the same shared
  ~/.agents/skills directory: GitHub's own docs for Copilot CLI agent skills
  list ~/.agents/skills as an officially supported personal-skills location
  alongside ~/.copilot/skills, and the `skills` CLI's own agent registry
  treats any agent whose skills directory is ".agents/skills" as sharing that
  one canonical global path. When both are present the two installs write the
  same files there, which is harmless. Re-running is also safe: the CLI wipes
  and re-fetches each skill's own directory on every install (`--copy` is not
  a diff/merge), so a re-run does real work but always converges on the same
  content, not a no-op in the sense of touching nothing. A user's own local
  edits to a copy-installed skill are lost the same way on the next install;
  that is by design, not a bug to fix here.

  Uninstall deletes the four SKILLS names as direct children of the three
  known destinations (~/.claude/skills, ~/.agents/skills, ~/.copilot/skills),
  sweeping all three unconditionally rather than gating on which harness is
  currently detected: gating on harness detection would strand orphaned
  skill directories on a machine whose harness has already been removed.
  Deletion is name-based, so it cannot tell an orphaned copy of one of these
  four skills apart from a same-named skill a user hand-authored themselves;
  that is an accepted limitation of a name-only uninstall, not a bug.
  Uninstall never reads, writes, or deletes .plan-and-track-manifest or
  .plan-and-track-pruned in any destination. Those belong to install.ps1 and
  record a different, much larger set of skills this script never touches.
  Uninstall also leaves ~/.agents/.skill-lock.json alone on purpose. That
  lock belongs to the pinned third-party `skills` CLI, which tracks it one
  skill name at a time and never reconciles an entry against what is on
  disk: `addSkillToLock` upserts an entry, `removeSkillFromLock` deletes
  one, and nothing prunes (read in its dist/cli.mjs at skills@1.5.19). So
  these four entries persist until the same skills are installed again,
  which rewrites them. Hand-editing another tool's state file is worse than
  leaving an entry that names a directory no longer there. Recheck this
  when SKILLS_CLI moves.

  PARITY: this script and install-office-skills.sh must stay in lockstep.
#>
param([string]$Action = 'install')

$ErrorActionPreference = 'Stop'
$SourceRepo = 'https://github.com/anthropics/skills'
$Skills = @('docx', 'pdf', 'pptx', 'xlsx')
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
# Pinned, reviewed version of the third-party fetch tool (vercel-labs/skills),
# which itself declares a Node >=22.20.0 engine requirement.
$SkillsCli = 'skills@1.5.19'
$SkillsCliMinNode = [version]'22.20.0'

function Usage {
  [Console]::Error.WriteLine("Usage: install-office-skills.ps1 [install|uninstall]")
  exit 1
}

# PowerShell binds only the first positional arg to $Action and silently drops
# the rest into $args, so the extra-argument rejection the .sh gets free from
# `[ $# -le 1 ] || usage` has to be written out here to keep the two in step.
if ($args.Count -gt 0) { Usage }
if ($Action -notin @('install', 'uninstall')) { Usage }

if ($Action -eq 'uninstall') {
  $Dests = @(
    (Join-Path $HomeDir '.claude/skills'),
    (Join-Path $HomeDir '.agents/skills'),
    (Join-Path $HomeDir '.copilot/skills')
  )
  foreach ($dest in $Dests) {
    if (-not (Test-Path -LiteralPath $dest)) { continue }
    $removed = @()
    foreach ($s in $Skills) {
      $target = Join-Path $dest $s
      $item = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
      if ($item) {
        if ($item.LinkType) {
          # Symlink/junction/reparse point: remove the link itself, not
          # -Recurse, which on some PowerShell versions follows the link
          # into its target and deletes the target's contents instead.
          Remove-Item -LiteralPath $target -Force
        } else {
          Remove-Item -LiteralPath $target -Recurse -Force
        }
        $removed += $s
      }
    }
    if ($removed.Count -gt 0) {
      Write-Host "${dest}:"
      foreach ($s in $removed) { Write-Host "  removed $s" }
    } else {
      Write-Host "  $dest -- nothing to remove"
    }
  }
  Write-Host "done."
  exit 0
}

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
