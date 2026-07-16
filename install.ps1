<#
.SYNOPSIS
  Install the plan-and-track agent rules, skills, and hooks into user-scope
  config for Claude Code, GitHub Copilot, and/or Codex on Windows.

.DESCRIPTION
  Windows (PowerShell) sibling of install.sh. Entry point:
      powershell -ExecutionPolicy Bypass -File install.ps1 all
  (also accepts claude | copilot | codex). Targets Windows PowerShell 5.1,
  which ships with Windows, so it uses only built-in cmdlets and .NET, never jq.

  Idempotent, exactly like install.sh. Re-runs re-assert the repo's intended
  state; your own content is kept:
    - skills are copied (this repo is the source of truth)
    - the core-rules digest is copied; a differing existing file is backed up to
      *.bak; machine-specific rules belong in core-rules.local.md (never touched)
    - instruction files (CLAUDE.md / AGENTS.md / copilot-instructions.md): repo
      content lives inside a marker-delimited managed block that installs update
      in place; content outside the markers is yours. A file WITHOUT markers is
      never modified.
    - hooks are merged only if not already installed (Claude/Codex); the Copilot
      hook files are repo-owned and overwritten, with a *.bak if one differed
    - managed defaults (Claude model=opusplan + switchModelsOnFlag, Copilot
      model=auto, Codex plan_mode_reasoning_effort=xhigh) are repo-owned and
      OVERWRITTEN on every install. PT_KEEP_MODEL=1 keeps an existing per-machine
      model choice; a Copilot settings.json that isn't plain JSON is left alone.
    - the user's global git excludes file (whatever core.excludesfile already
      points to, or ~/.gitignore_global if unset) gets tasks/todo.md and
      tasks/lessons.md appended if missing, once per run regardless of target;
      skipped if git isn't installed

  PARITY: this script and install.sh must stay in lockstep. Any change to the
  managed surface (skills, agents (both the Claude .md copies and the Codex
  TOML rendering), the core-rules digest, the instructions managed block, hook
  wiring + __SCRIPTS__ substitution, model/effort defaults, the TOML upsert,
  the global gitignore entries) must be mirrored in both. See install.sh for
  the same note.
#>
param([string]$Target)

$ErrorActionPreference = 'Stop'

$RepoDir = $PSScriptRoot
# Home base: %USERPROFILE% on Windows; fall back to $HOME so the script is
# testable on macOS/Linux with pwsh. Both resolve to the same layout install.sh
# builds under $HOME.
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }

$MarkBegin       = '<!-- agent-plan-and-track:begin (managed block: edit in the repo, not here) -->'
$MarkBeginPrefix = '<!-- agent-plan-and-track:begin ('
$MarkEnd         = '<!-- agent-plan-and-track:end -->'

# Claude-only skills: installed by Install-Claude, skipped for the other
# harnesses. Everything else under skills/ is portable and installs everywhere.
$ClaudeOnlySkills = @('skill-comply')

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Usage {
  [Console]::Error.WriteLine("Usage: install.ps1 {claude|copilot|codex|all}")
  exit 1
}

# Write $content to a fresh temp file (UTF-8, no BOM) and return its path.
function New-TempFileWith([string]$content) {
  $tmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($tmp, $content, $Utf8NoBom)
  return $tmp
}

# Byte-for-byte file comparison (the cmp -s install.sh uses).
function Test-FilesEqual($a, $b) {
  if (-not (Test-Path -LiteralPath $a) -or -not (Test-Path -LiteralPath $b)) { return $false }
  $ba = [System.IO.File]::ReadAllBytes($a)
  $bb = [System.IO.File]::ReadAllBytes($b)
  if ($ba.Length -ne $bb.Length) { return $false }
  for ($i = 0; $i -lt $ba.Length; $i++) { if ($ba[$i] -ne $bb[$i]) { return $false } }
  return $true
}

# Display form of a JSON value for console output: lowercase booleans (to match
# jq) and render an absent value as "unset".
function Format-Val($v) {
  if ($null -eq $v) { return 'unset' }
  if ($v -is [bool]) { return $v.ToString().ToLowerInvariant() }
  return "$v"
}

# Merge a directory tree ($src) into $dst, overwriting matching files but never
# removing files whose source was deleted (the `cp -R` semantics install.sh
# relies on). Reliable across PowerShell versions, unlike Copy-Item -Recurse
# into an existing folder.
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

# Write a temp file back to $file, preserving a symlink at $file instead of
# replacing it (config files are often symlinked from a dotfiles repo). When
# $file is a reparse point we write THROUGH it (byte-write the target, keeping
# the link); otherwise we move for atomicity.
function Write-Back($tmp, $file) {
  $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  if ($item -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    [System.IO.File]::WriteAllBytes($file, [System.IO.File]::ReadAllBytes($tmp))
    Remove-Item -LiteralPath $tmp -Force
  } else {
    Move-Item -LiteralPath $tmp -Destination $file -Force
  }
}

# Copy the portable skills (every skills/*/ dir except the Claude-only ones) into
# $dest, so a new skill is picked up on re-install with no edit here.
function Copy-Skills($dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $names = @()
  foreach ($dir in Get-ChildItem -LiteralPath (Join-Path $RepoDir 'skills') -Directory) {
    if ($ClaudeOnlySkills -contains $dir.Name) { continue }
    Copy-Tree $dir.FullName (Join-Path $dest $dir.Name)
    $names += $dir.Name
  }
  Write-Host "  skills          -> $dest/{$($names -join ',')}"
}

# Claude-only subagent definitions (agents/*.md), overwritten each install so the
# repo stays the source of truth. No-op if the repo has no agents/ dir.
function Copy-Agents($dest) {
  $agentsDir = Join-Path $RepoDir 'agents'
  if (-not (Test-Path -LiteralPath $agentsDir)) { return }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $names = @()
  foreach ($f in Get-ChildItem -LiteralPath $agentsDir -Filter '*.md' -File) {
    Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $dest $f.Name) -Force
    $names += $f.BaseName
  }
  if ($names.Count -gt 0) { Write-Host "  agents          -> $dest/{$($names -join ',')} (Claude-only)" }
}

# Read a single-line frontmatter value for $key out of $file's YAML
# frontmatter block (between the first and second `---` line). Matches a line
# starting with "<key>: " and returns the rest with at most one leading and
# one trailing double quote stripped. Doesn't handle multi-line YAML blocks or
# nested keys; every agents/*.md field this repo reads is a single physical
# line, so that's not a real limitation here. Returns '' when not found.
function Get-AgentFrontmatterField($file, $key) {
  $prefix = "$key`: "
  $fm = 0
  foreach ($line in [System.IO.File]::ReadAllLines($file)) {
    if ($line -match '^---\s*$') { $fm++; continue }
    if ($fm -ne 1) { continue }
    if ($line.StartsWith($prefix)) {
      $val = $line.Substring($prefix.Length)
      $val = $val -replace '^"', '' -replace '"$', ''
      return $val
    }
  }
  return ''
}

# Everything in $file after the closing `---` of its frontmatter block, with
# exactly one leading blank line stripped (agents/*.md all have one, matching
# the file body-vs-frontmatter separation the Codex TOML render needs raw).
function Get-AgentBody($file) {
  $fm = 0; $started = $false
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in [System.IO.File]::ReadAllLines($file)) {
    if ($line -match '^---\s*$') { $fm++; continue }
    if ($fm -lt 2) { continue }
    if (-not $started) {
      $started = $true
      if ($line -eq '') { continue }
    }
    $out.Add($line)
  }
  return ($out -join "`n")
}

# Escape a string for embedding in a basic double-quoted TOML string
# (backslashes first, then double quotes, so an escaped quote isn't
# re-escaped).
function ConvertTo-TomlEscaped($s) {
  return $s.Replace('\', '\\').Replace('"', '\"')
}

# Render one agents/*.md source into Codex-native TOML agent text. model is
# left UNSET: Claude model names (fable/opus/sonnet/haiku) don't translate to
# Codex's own model catalog, so the agent inherits whatever model the parent
# session is running. developer_instructions uses a TOML literal
# triple-single-quoted string so the body needs no escaping; same documented
# tradeoff Set-TomlDefault takes on TOML string handling above, and none of
# this repo's agent bodies contain a literal ''' to break it.
function ConvertTo-CodexAgentToml($src) {
  $name = Get-AgentFrontmatterField $src 'name'
  $description = Get-AgentFrontmatterField $src 'description'
  $effort = Get-AgentFrontmatterField $src 'effort'
  $tools = Get-AgentFrontmatterField $src 'tools'
  $sandboxMode = if ($tools -match 'Edit|Write') { 'workspace-write' } else { 'read-only' }
  $body = Get-AgentBody $src
  $lines = @(
    "name = `"$(ConvertTo-TomlEscaped $name)`"",
    "description = `"$(ConvertTo-TomlEscaped $description)`"",
    "model_reasoning_effort = `"$effort`"",
    "sandbox_mode = `"$sandboxMode`"",
    "developer_instructions = '''",
    $body,
    "'''"
  )
  return ($lines -join "`n") + "`n"
}

# Codex-native mirror of Copy-Agents: same source (agents/*.md), rendered into
# Codex's one-TOML-file-per-agent format at $dest/<name>.toml instead of
# copied verbatim, since Codex has no Claude-style Markdown subagent file.
# Every agents/*.md is rendered, so adding one needs no edit here. No-op if
# the repo has no agents/ dir.
function Copy-CodexAgents($dest) {
  $agentsDir = Join-Path $RepoDir 'agents'
  if (-not (Test-Path -LiteralPath $agentsDir)) { return }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $names = @()
  foreach ($f in Get-ChildItem -LiteralPath $agentsDir -Filter '*.md' -File) {
    $toml = ConvertTo-CodexAgentToml $f.FullName
    [System.IO.File]::WriteAllText((Join-Path $dest "$($f.BaseName).toml"), $toml, $Utf8NoBom)
    $names += $f.BaseName
  }
  if ($names.Count -gt 0) { Write-Host "  agents (codex)  -> $dest/{$($names -join ',')}" }
}

# Render a hook wiring template to text, replacing __SCRIPTS__ with the resolved
# absolute scripts dir. Mirrors install.sh render_hook; $scriptsDir is
# forward-slashed by the caller (node accepts forward slashes on Windows too, and
# it avoids JSON backslash escaping).
function Get-RenderedHook($template, $scriptsDir) {
  return ([System.IO.File]::ReadAllText($template)).Replace('__SCRIPTS__', $scriptsDir)
}

# Set a repo-owned JSON default in a settings file, overwriting on every install
# so a re-run re-asserts the intended value. With PT_KEEP_MODEL=1 this reverts to
# set-if-absent. $value is a native value ('opusplan', $true).
function Set-JsonDefault($file, $key, $value, $label) {
  $json = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json
  $has = ($json.PSObject.Properties.Name -contains $key)
  if ($env:PT_KEEP_MODEL -eq '1' -and $has) {
    Write-Host ("  {0,-16}-- PT_KEEP_MODEL=1; kept {1}={2}" -f $label, $key, (Format-Val $json.$key))
    return
  }
  $prev = if ($has) { $json.$key } else { $null }
  if ($has) { $json.$key = $value }
  else { $json | Add-Member -NotePropertyName $key -NotePropertyValue $value -Force }
  $tmp = New-TempFileWith (ConvertTo-Json -InputObject $json -Depth 100)
  Write-Back $tmp $file
  Write-Host ("  {0,-16}-> {1}={2} (was: {3})" -f $label, $key, (Format-Val $value), (Format-Val $prev))
}

# Set a top-level (root-table) TOML `key = "value"`, overwriting on every install.
# Line-based scan of the ROOT table (lines before the first [section]); a
# same-named key inside a [section] is never touched. Absent key is PREPENDED as
# the first line; a present root key is replaced in place. Same documented limit
# as install.sh: a root-region multiline ("""...""") value whose interior looks
# like `key =` or `[section]` could fool it. Codex config.toml has no such strings.
function Set-TomlDefault($file, $key, $val) {
  $dir = Split-Path -Parent $file
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (-not (Test-Path -LiteralPath $file)) { [System.IO.File]::WriteAllText($file, '', $Utf8NoBom) }
  $lines = @([System.IO.File]::ReadAllLines($file))
  $keyRe = '^\s*' + [regex]::Escape($key) + '\s*='
  $base = Split-Path -Leaf $file

  $seen = $false; $found = $false
  foreach ($line in $lines) {
    if ($seen) { continue }
    if ($line -match '^\s*\[') { $seen = $true; continue }
    if ($line -match $keyRe) { $found = $true }
  }

  if ($found) {
    $seen = $false; $done = $false
    $out = foreach ($line in $lines) {
      if (-not $seen -and $line -match '^\s*\[') { $seen = $true }
      if (-not $done -and -not $seen -and $line -match $keyRe) {
        $done = $true
        "$key = `"$val`""
      } else { $line }
    }
    $tmp = New-TempFileWith ((@($out) -join "`n") + "`n")
    Write-Back $tmp $file
    Write-Host "  plan-mode effort-> $key = `"$val`" set in $base"
  } else {
    $body = if ($lines.Count -gt 0) { (($lines -join "`n") + "`n") } else { '' }
    $tmp = New-TempFileWith ("$key = `"$val`"`n" + $body)
    Write-Back $tmp $file
    Write-Host "  plan-mode effort-> $key = `"$val`" prepended in $base"
  }
}

# Ensure the user's *global* git excludes file ignores the per-project
# tasks/todo.md and tasks/lessons.md scratch files the plan-and-track and
# capture-lesson skills create in whatever repo they run in (not just this
# one). No-op if git isn't installed: gh has no gitignore concept of its own.
# Respects an existing core.excludesfile instead of assuming
# ~/.gitignore_global, since git only honors whatever that setting points to.
function Install-GlobalGitignore {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Global gitignore (skipped: git not found)"
    return
  }
  Write-Host "Global gitignore"
  $target = (git config --global --path core.excludesfile 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($target)) {
    $target = Join-Path $HomeDir '.gitignore_global'
    git config --global core.excludesfile $target | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  core.excludesfile -> failed to set, skipping"
      return
    }
    Write-Host "  core.excludesfile -> $target (was unset)"
  } else {
    Write-Host "  core.excludesfile -> $target (existing)"
  }
  $dir = Split-Path -Parent $target
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (-not (Test-Path -LiteralPath $target)) { [System.IO.File]::WriteAllText($target, '', $Utf8NoBom) }
  $content = [System.IO.File]::ReadAllText($target)
  $lines = @([System.IO.File]::ReadAllLines($target))
  $added = @($('tasks/todo.md', 'tasks/lessons.md') | Where-Object { $lines -cnotcontains $_ })
  if ($added.Count -gt 0) {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
      Add-Content -LiteralPath $target -Value ''
    }
    foreach ($entry in $added) { Add-Content -LiteralPath $target -Value $entry }
    Write-Host "  entries         -> added $($added -join ', ') to $target"
  } else {
    Write-Host "  entries         -- already present in $target"
  }
}

function Install-Digest($dest) {
  $dir = Split-Path -Parent $dest
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $src = Join-Path $RepoDir 'rules/core-rules.md'
  if ((Test-Path -LiteralPath $dest) -and -not (Test-FilesEqual $src $dest)) {
    Copy-Item -LiteralPath $dest -Destination "$dest.bak" -Force
    Write-Host "  (existing digest differed; backed up to $dest.bak)"
  }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  Write-Host "  rules digest    -> $dest"
}

function Install-Instructions($dest) {
  $dir = Split-Path -Parent $dest
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $srcLines = [System.IO.File]::ReadAllLines((Join-Path $RepoDir 'rules/agent-guidelines.md'))
  if (-not (Test-Path -LiteralPath $dest)) {
    $out = @($MarkBegin) + $srcLines + @($MarkEnd)
    [System.IO.File]::WriteAllText($dest, (($out -join "`n") + "`n"), $Utf8NoBom)
    Write-Host "  instructions    -> $dest"
    return
  }
  $destText = [System.IO.File]::ReadAllText($dest)
  if ($destText.Contains($MarkBeginPrefix)) {
    $destLines = [System.IO.File]::ReadAllLines($dest)
    $out = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($line in $destLines) {
      if ($line.StartsWith($MarkBeginPrefix)) {
        $out.Add($MarkBegin)
        foreach ($s in $srcLines) { $out.Add($s) }
        $skip = $true
        continue
      }
      if ($line -eq $MarkEnd) { $skip = $false }
      if (-not $skip) { $out.Add($line) }
    }
    # install.sh uses a plain mv here (not write_back); mirror that.
    [System.IO.File]::WriteAllText($dest, (($out -join "`n") + "`n"), $Utf8NoBom)
    Write-Host "  instructions    -> managed block updated in $dest (content outside markers untouched)"
  } else {
    Write-Host "  instructions    -- $dest exists without managed markers; NOT modified. Move the shared section into a '$MarkBegin' ... '$MarkEnd' block to make it updatable."
  }
}

# Merge one hook wiring template's <event> array into a Claude/Codex settings
# file (the jq --slurpfile append install.sh does, in native PowerShell JSON).
function Merge-HookInto($settingsFile, $eventName, $template, $scriptsDir) {
  $settings = [System.IO.File]::ReadAllText($settingsFile) | ConvertFrom-Json
  $tpl = Get-RenderedHook $template $scriptsDir | ConvertFrom-Json
  if (-not ($settings.PSObject.Properties.Name -contains 'hooks') -or $null -eq $settings.hooks) {
    $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([PSCustomObject]@{}) -Force
  }
  $existing = @()
  if ($settings.hooks.PSObject.Properties.Name -contains $eventName) {
    $existing = @($settings.hooks.$eventName)
  }
  $merged = @($existing + @($tpl.hooks.$eventName))
  if ($settings.hooks.PSObject.Properties.Name -contains $eventName) {
    $settings.hooks.$eventName = $merged
  } else {
    $settings.hooks | Add-Member -NotePropertyName $eventName -NotePropertyValue $merged -Force
  }
  $tmp = New-TempFileWith (ConvertTo-Json -InputObject $settings -Depth 100)
  Write-Back $tmp $settingsFile
}

# Install a repo-owned Copilot hook file: render the template, back up a differing
# existing file to *.bak, then overwrite. Compares against the RENDERED template
# (paths already substituted), not the raw template.
function Install-RenderedHookFile($template, $dest, $scriptsDir, $label) {
  $tmp = New-TempFileWith (Get-RenderedHook $template $scriptsDir)
  if ((Test-Path -LiteralPath $dest) -and -not (Test-FilesEqual $tmp $dest)) {
    Copy-Item -LiteralPath $dest -Destination "$dest.bak" -Force
    Write-Host "  ($label differed; backed up to $dest.bak)"
  }
  Copy-Item -LiteralPath $tmp -Destination $dest -Force
  Remove-Item -LiteralPath $tmp -Force
}

function Install-Claude {
  Write-Host "Claude Code (user scope: ~/.claude)"
  $base = Join-Path $HomeDir '.claude'
  $scripts = Join-Path $base 'scripts'
  Copy-Skills (Join-Path $base 'skills')
  foreach ($s in $ClaudeOnlySkills) {
    Copy-Tree (Join-Path (Join-Path $RepoDir 'skills') $s) (Join-Path (Join-Path $base 'skills') $s)
    Write-Host "  skill (claude)  -> ~/.claude/skills/$s (Claude-only)"
  }
  Copy-Agents (Join-Path $base 'agents')
  Install-Digest (Join-Path $base 'core-rules.md')
  Install-Instructions (Join-Path $base 'CLAUDE.md')

  New-Item -ItemType Directory -Force -Path $scripts | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/core-rules-digest.js') -Destination (Join-Path $scripts 'core-rules-digest.js') -Force
  Write-Host "  digest script   -> ~/.claude/scripts/core-rules-digest.js"
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/claude/suggest-compact.js') -Destination (Join-Path $scripts 'suggest-compact.js') -Force
  Write-Host "  compact script  -> ~/.claude/scripts/suggest-compact.js"
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/delivery-gate.js') -Destination (Join-Path $scripts 'delivery-gate.js') -Force
  Write-Host "  delivery script -> ~/.claude/scripts/delivery-gate.js"
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/gateguard.js') -Destination (Join-Path $scripts 'gateguard.js') -Force
  Write-Host "  gateguard script-> ~/.claude/scripts/gateguard.js"

  $settings = Join-Path $base 'settings.json'
  New-Item -ItemType Directory -Force -Path $base | Out-Null
  if (-not (Test-Path -LiteralPath $settings)) { [System.IO.File]::WriteAllText($settings, '{}', $Utf8NoBom) }
  Set-JsonDefault $settings 'model' 'opusplan' 'model default'
  Set-JsonDefault $settings 'switchModelsOnFlag' $true 'safety-switch'

  $scriptsFwd = $scripts.Replace('\', '/')
  $raw = [System.IO.File]::ReadAllText($settings)
  if ($raw.Contains('core-rules')) {
    Write-Host "  digest hook     -- already present in settings.json"
  } else {
    Merge-HookInto $settings 'UserPromptSubmit' (Join-Path $RepoDir 'hooks/claude/settings-hooks.json') $scriptsFwd
    Write-Host "  digest hook     -> merged into settings.json (UserPromptSubmit)"
  }
  if ($raw.Contains('suggest-compact')) {
    Write-Host "  compact hook    -- already present in settings.json"
  } else {
    Merge-HookInto $settings 'PreToolUse' (Join-Path $RepoDir 'hooks/claude/pretooluse-compact.json') $scriptsFwd
    Write-Host "  compact hook    -> merged into settings.json (PreToolUse, all tools)"
  }
  if ($raw.Contains('delivery-gate')) {
    Write-Host "  delivery hook   -- already present in settings.json"
  } else {
    Merge-HookInto $settings 'Stop' (Join-Path $RepoDir 'hooks/claude/stop-delivery-gate.json') $scriptsFwd
    Write-Host "  delivery hook   -> merged into settings.json (Stop; warn-only, DELIVERY_GATE_BLOCK=1 to enforce)"
  }
  if ($raw.Contains('gateguard')) {
    Write-Host "  gateguard hook  -- already present in settings.json"
  } else {
    Merge-HookInto $settings 'PreToolUse' (Join-Path $RepoDir 'hooks/claude/pretooluse-gateguard.json') $scriptsFwd
    Write-Host "  gateguard hook  -> merged into settings.json (PreToolUse on edits; GATEGUARD_DISABLED=1 to turn off)"
  }
  Write-Host "  done. New Claude Code sessions pick this up automatically."
}

function Install-Copilot {
  Write-Host "GitHub Copilot (user scope: ~/.copilot)"
  $base = Join-Path $HomeDir '.copilot'
  Copy-Skills (Join-Path $base 'skills')
  Install-Digest (Join-Path $base 'core-rules.md')
  Install-Instructions (Join-Path $base 'copilot-instructions.md')

  # Global model default "auto". Re-asserted each install (PT_KEEP_MODEL=1 keeps
  # an existing choice), but only when settings.json parses as plain JSON: a
  # JSONC file with comments is left untouched (warn).
  $csettings = Join-Path $base 'settings.json'
  $parses = $true
  if (Test-Path -LiteralPath $csettings) {
    try { [System.IO.File]::ReadAllText($csettings) | ConvertFrom-Json | Out-Null } catch { $parses = $false }
  }
  if ((Test-Path -LiteralPath $csettings) -and -not $parses) {
    Write-Host "  model default   -- $csettings isn't plain JSON (JSONC comments?); NOT modified. Add ""model"":""auto"" by hand."
  } else {
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    if (-not (Test-Path -LiteralPath $csettings)) { [System.IO.File]::WriteAllText($csettings, '{}', $Utf8NoBom) }
    Set-JsonDefault $csettings 'model' 'auto' 'model default'
  }

  $hooksDir = Join-Path $base 'hooks'
  $scripts = Join-Path $base 'scripts'
  New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
  New-Item -ItemType Directory -Force -Path $scripts | Out-Null
  $scriptsFwd = $scripts.Replace('\', '/')
  # Shared scripts: the core-rules digest (replaces the old inline bash+jq
  # throttle, so Copilot no longer needs jq at runtime) and the universal
  # gateguard. UNVERIFIED: the Copilot CLI wasn't available to test against
  # locally; the wire format follows the docs + the proven core-rules.json shape.
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/core-rules-digest.js') -Destination (Join-Path $scripts 'core-rules-digest.js') -Force
  Write-Host "  digest script   -> ~/.copilot/scripts/core-rules-digest.js"
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/gateguard.js') -Destination (Join-Path $scripts 'gateguard.js') -Force
  Write-Host "  gateguard script-> ~/.copilot/scripts/gateguard.js"
  Install-RenderedHookFile (Join-Path $RepoDir 'hooks/copilot/core-rules.json') (Join-Path $hooksDir 'core-rules.json') $scriptsFwd 'existing hook'
  Write-Host "  hook            -> ~/.copilot/hooks/core-rules.json (postToolUse, 10-min throttle)"
  Install-RenderedHookFile (Join-Path $RepoDir 'hooks/copilot/pretooluse-gateguard.json') (Join-Path $hooksDir 'pretooluse-gateguard.json') $scriptsFwd 'existing gateguard hook'
  Write-Host "  gateguard hook  -> ~/.copilot/hooks/pretooluse-gateguard.json (preToolUse on create|edit)"
  Write-Host "  done. Hooks need node at runtime. Start a NEW copilot session to load."
}

function Install-Codex {
  Write-Host "Codex (user scope: ~/.codex; skills in ~/.agents/skills)"
  $codex = Join-Path $HomeDir '.codex'
  $scripts = Join-Path $codex 'scripts'
  Copy-Skills (Join-Path (Join-Path $HomeDir '.agents') 'skills')
  Copy-CodexAgents (Join-Path $codex 'agents')
  Install-Digest (Join-Path $codex 'core-rules.md')
  Install-Instructions (Join-Path $codex 'AGENTS.md')
  # Plan-mode default, re-asserted each install: raise reasoning effort in Plan
  # mode only. Not gated by PT_KEEP_MODEL (that opt-out covers model settings).
  Set-TomlDefault (Join-Path $codex 'config.toml') 'plan_mode_reasoning_effort' 'xhigh'

  $hooks = Join-Path $codex 'hooks.json'
  New-Item -ItemType Directory -Force -Path $codex | Out-Null
  New-Item -ItemType Directory -Force -Path $scripts | Out-Null
  if (-not (Test-Path -LiteralPath $hooks)) { [System.IO.File]::WriteAllText($hooks, '{"hooks":{}}', $Utf8NoBom) }
  # Shared scripts: the core-rules digest (replaces the old inline `cat`) plus
  # gateguard + delivery-gate. Codex's Stop payload and apply_patch PreToolUse are
  # Claude-shaped, so the same universal code runs here (dialect sniffed at runtime).
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/core-rules-digest.js') -Destination (Join-Path $scripts 'core-rules-digest.js') -Force
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/gateguard.js') -Destination (Join-Path $scripts 'gateguard.js') -Force
  Copy-Item -LiteralPath (Join-Path $RepoDir 'hooks/delivery-gate.js') -Destination (Join-Path $scripts 'delivery-gate.js') -Force
  Write-Host "  scripts         -> ~/.codex/scripts/{core-rules-digest,gateguard,delivery-gate}.js"

  $scriptsFwd = $scripts.Replace('\', '/')
  $raw = [System.IO.File]::ReadAllText($hooks)
  if ($raw.Contains('core-rules')) {
    Write-Host "  hook            -- already present in hooks.json"
  } else {
    Merge-HookInto $hooks 'UserPromptSubmit' (Join-Path $RepoDir 'hooks/codex/hooks.json') $scriptsFwd
    Write-Host "  hook            -> merged into hooks.json (UserPromptSubmit, per turn)"
  }
  if ($raw.Contains('gateguard')) {
    Write-Host "  gateguard hook  -- already present in hooks.json"
  } else {
    Merge-HookInto $hooks 'PreToolUse' (Join-Path $RepoDir 'hooks/codex/pretooluse-gateguard.json') $scriptsFwd
    Write-Host "  gateguard hook  -> merged into hooks.json (PreToolUse on apply_patch; GATEGUARD_DISABLED=1 to turn off)"
  }
  if ($raw.Contains('delivery-gate')) {
    Write-Host "  delivery hook   -- already present in hooks.json"
  } else {
    Merge-HookInto $hooks 'Stop' (Join-Path $RepoDir 'hooks/codex/stop-delivery-gate.json') $scriptsFwd
    Write-Host "  delivery hook   -> merged into hooks.json (Stop; warn-only, DELIVERY_GATE_BLOCK=1 to enforce)"
  }
  Write-Host "  done. Hooks need node at runtime. Start a new codex session to load."
}

if ($Target -notin @('claude', 'copilot', 'codex', 'all')) { Usage }

Install-GlobalGitignore
Write-Host ''

switch ($Target) {
  'claude'  { Install-Claude }
  'copilot' { Install-Copilot }
  'codex'   { Install-Codex }
  'all'     { Install-Claude; Write-Host ''; Install-Copilot; Write-Host ''; Install-Codex }
}
