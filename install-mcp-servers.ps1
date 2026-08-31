<#
.SYNOPSIS
  Install the chrome-devtools MCP server (github.com/ChromeDevTools/chrome-devtools-mcp)
  for whichever of Claude Code, Codex, and GitHub Copilot are present on this
  machine, skipping any harness that already has a server by that name, or
  remove it again (Windows sibling of install-mcp-servers.sh).

.DESCRIPTION
  Entry point:
      powershell -ExecutionPolicy Bypass -File install-mcp-servers.ps1 [install|uninstall]

  The verb defaults to install when omitted, and more than one argument is
  still an error, same shape as install-office-skills.ps1.

  Separate from install.ps1: this script drives each harness through its own
  CLI (`mcp add`/`mcp get`/`mcp remove`), which install.ps1's shared
  JSON/TOML merge machinery has no need to know about. Exact
  install-office-skills.ps1 precedent (a third-party integration kept out of
  the shared installer).

  Detection is Get-Command <cli> for all three harnesses. That matches
  install-office-skills.ps1 for Claude Code and Codex but diverges for
  Copilot, which that script detects by testing for the ~/.copilot
  directory. The divergence is deliberate, not a copy error: this script
  drives every harness through its own CLI rather than writing files
  directly, so a harness whose CLI isn't on PATH is unusable here regardless
  of whether its config directory exists.

  Every harness CLI call is made from a fresh empty temporary directory that
  is removed on exit, because Claude Code and GitHub Copilot both resolve
  project-scoped MCP config relative to the working directory and neither
  exposes a scope flag on `mcp get`. Run from a repo carrying a .mcp.json
  that declares this server and an unscoped presence check would report it
  already configured, silently skipping the user-scope install this script
  exists to perform, and `mcp remove -s user` would then fail on a server
  that was never in user scope. Codex is unaffected (its MCP config is
  ~/.codex/config.toml only), but the location change covers all three so the
  script behaves the same wherever it is invoked from. The home directory is
  not a safe choice here: a user who has run an agent from it can have a
  ~/.mcp.json, which would shadow the user-scope entry exactly the way a
  repository's does. A directory this script just created cannot.

  It is a Push-Location inside a try/finally rather than the .sh's plain cd,
  because a PowerShell script runs in its caller's runspace and would
  otherwise leave that caller relocated after the script returned.

  One behavioral divergence from install-mcp-servers.sh, and the only one:
  Codex is registered with the Windows form the upstream README documents in
  its Windows 11 section, launching npx through cmd with SystemRoot and
  PROGRAMFILES in the server's environment. That guidance is Codex-only, so
  Claude Code and Copilot take the same plain form here as on Unix. Upstream
  also raises the server's startup timeout, which `codex mcp add` exposes no
  flag for, so that one part is left to a hand edit of the Codex config file
  and is not applied here.

  Uninstall also gates each harness on the same Get-Command detection,
  rather than sweeping known destinations unconditionally the way
  install-office-skills.ps1's uninstall path does. This is a second
  deliberate divergence: removal here goes through the harness's own
  `mcp remove` subcommand, not direct file deletion, so there is no
  orphaned-directory case to sweep the way there is for the office skills
  (whose uninstall deletes on-disk skill directories directly).

  This script never runs npx itself; the add commands below hand
  `npx -y chrome-devtools-mcp@latest` to the harness as the command it should
  launch its MCP server with, and npx only actually runs later, when that
  harness starts the server over piped stdio. The install path still gates on
  npx existing, because a config naming a command the machine does not have
  is an unusable server that fails at first use with the harness's own error
  rather than this script's. Uninstall does not gate: making a cleanup depend
  on a toolchain it never uses would strand anyone whose Node install is
  gone. Node is not implied by a harness being present, since not every
  harness CLI is itself a Node program.

  All three harnesses' add commands pass -y to npx, even though upstream
  documents -y only for Copilot: a harness launches an MCP server over
  piped stdio, and npx's first-run "ok to install?" prompt has nowhere to
  go on that channel, so without -y a harness starting the server for the
  first time on a machine without the package cached would hang instead of
  launching. -y is a no-op once the package is already cached.

  The package pin is @latest, not a fixed version, which otherwise goes
  against this repo's pin-external-tools convention (see
  install-office-skills.ps1's $SkillsCli). That convention governs a tool
  this script itself shells out to; this string is config data handed to
  the harness to run later, not a tool this script runs, so the convention
  doesn't apply here the same way. @latest also matches what upstream
  documents and what this repo's owner already has installed on all three
  harnesses.

  Requires each harness's own CLI (claude, codex, copilot) already on PATH,
  Node.js LTS, and a current-stable-or-newer Chrome install (all three
  required by chrome-devtools-mcp itself, not by this script). This script
  never hand-edits ~/.claude.json, ~/.codex/config.toml, or
  ~/.copilot/mcp-config.json; each harness's own CLI is the only writer of
  its own config.

  PARITY: this script and install-mcp-servers.sh must stay in lockstep.
#>
param([string]$Action = 'install')

$ErrorActionPreference = 'Stop'
$McpName = 'chrome-devtools'
$McpPackage = 'chrome-devtools-mcp@latest'

function Usage {
  [Console]::Error.WriteLine("Usage: install-mcp-servers.ps1 [install|uninstall]")
  exit 1
}

# PowerShell binds only the first positional arg to $Action and silently drops
# the rest into $args, so the extra-argument rejection the .sh gets free from
# `[ $# -le 1 ] || usage` has to be written out here to keep the two in step.
if ($args.Count -gt 0) { Usage }
if ($Action -notin @('install', 'uninstall')) { Usage }

if ($Action -eq 'install' -and -not (Get-Command npx -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine("error: npx is required (install Node.js); every harness launches this server through npx")
  exit 1
}

$haveClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$haveCodex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
$haveCopilot = [bool](Get-Command copilot -ErrorAction SilentlyContinue)

if (-not $haveClaude -and -not $haveCodex -and -not $haveCopilot) {
  Write-Host "No Claude Code, Codex, or Copilot installation detected; nothing to do."
  exit 0
}

function Test-McpPresent($cli) {
  & $cli mcp get $McpName *> $null
  return $LASTEXITCODE -eq 0
}

function Add-Mcp($cli) {
  switch ($cli) {
    'claude'  { & claude mcp add $McpName --scope user -- npx -y $McpPackage *> $null }
    # Codex gets the Windows form the upstream README's Windows 11 section
    # documents: npx launched through cmd, with SystemRoot and PROGRAMFILES in
    # the server's environment. That section is Codex-only, so Claude Code and
    # Copilot keep the plain form. Upstream also raises the startup timeout,
    # which `codex mcp add` exposes no flag for, so the server keeps Codex's
    # default; raise it by hand in the config file if Chrome is slow to start.
    'codex'   { & codex mcp add $McpName --env "SystemRoot=$env:SystemRoot" --env "PROGRAMFILES=$env:ProgramFiles" -- cmd /c npx -y $McpPackage *> $null }
    'copilot' { & copilot mcp add $McpName -- npx -y $McpPackage *> $null }
  }
  if ($LASTEXITCODE -ne 0) { throw "mcp add failed for '$cli' with exit code $LASTEXITCODE" }
}

function Remove-Mcp($cli) {
  switch ($cli) {
    'claude'  { & claude mcp remove $McpName -s user *> $null }
    'codex'   { & codex mcp remove $McpName *> $null }
    'copilot' { & copilot mcp remove $McpName *> $null }
  }
  if ($LASTEXITCODE -ne 0) { throw "mcp remove failed for '$cli' with exit code $LASTEXITCODE" }
}

function Write-Report($label, $message) {
  Write-Host ("  {0,-11} -- {1}" -f $label, $message)
}

function Invoke-Dispatch($cli, $label, $detected) {
  if (-not $detected) {
    Write-Report $label "not detected, skipped"
    return
  }

  if ($Action -eq 'install') {
    if (Test-McpPresent $cli) {
      Write-Report $label "already configured, skipped"
    } else {
      Add-Mcp $cli
      Write-Report $label "added"
    }
  } else {
    if (Test-McpPresent $cli) {
      Remove-Mcp $cli
      Write-Report $label "removed"
    } else {
      Write-Report $label "not configured, skipped"
    }
  }
}

# Push-Location rather than Set-Location: a script run in the caller's runspace
# leaves that runspace wherever it lands, so a bare Set-Location would relocate
# an interactive caller and break the very next relative path they resolve. The
# finally restores the location and removes the scratch directory on every path,
# including a throw out of Add-Mcp or Remove-Mcp.
$workDir = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
Push-Location -LiteralPath $workDir
try {
  Invoke-Dispatch 'claude' 'Claude Code' $haveClaude
  Invoke-Dispatch 'codex' 'Codex' $haveCodex
  Invoke-Dispatch 'copilot' 'Copilot' $haveCopilot
} finally {
  Pop-Location
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "done."
# The last thing this script runs is usually a harness CLI, and a `mcp get` that
# correctly reports "absent" exits 1. Without this the caller would read that as
# the script itself failing, which is exactly what a no-op uninstall looks like.
exit 0
