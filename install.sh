#!/usr/bin/env bash
# Install the plan-and-track agent rules, skills, and hooks into user-scope
# config for Claude Code, GitHub Copilot, and/or Codex.
#
# Usage: ./install.sh {claude|copilot|codex|all}
#
# Idempotent. Re-runs re-assert the repo's intended state; your own content is kept:
#   - skills are copied (this repo is the source of truth)
#   - the core-rules digest is copied; a differing existing file is backed up to *.bak;
#     machine-specific rules belong in core-rules.local.md next to it (never touched)
#   - instruction files (CLAUDE.md / AGENTS.md / copilot-instructions.md): the repo
#     content lives inside a marker-delimited managed block that installs update in
#     place; anything outside the markers is yours and is never touched. An existing
#     file WITHOUT markers is never modified.
#   - hooks are merged only if not already installed (Claude/Codex); the Copilot hook
#     files are repo-owned and overwritten, with a *.bak backup if one differed
#   - managed defaults (Claude model=opusplan + switchModelsOnFlag, Copilot
#     model=auto, Codex plan_mode_reasoning_effort=xhigh) are repo-owned and
#     OVERWRITTEN on every install. PT_KEEP_MODEL=1 keeps an existing per-machine
#     model choice; a Copilot settings.json jq can't round-trip is left untouched.
#   - the user's global git excludes file (whatever core.excludesfile already
#     points to, or ~/.gitignore_global if unset) gets tasks/todo.md and
#     tasks/lessons.md appended if missing, once per run regardless of target;
#     skipped if git isn't installed
#
# PARITY: install.ps1 is the Windows (PowerShell) sibling of this script and must
# stay in lockstep. Any change to the managed surface here (skills, agents (both
# the Claude .md copies and the Codex TOML rendering), the core-rules digest, the
# instructions managed block, hook wiring + __SCRIPTS__ substitution, model/effort
# defaults, the TOML upsert, the global gitignore entries) must be mirrored there.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARK_BEGIN="<!-- agent-plan-and-track:begin (managed block: edit in the repo, not here) -->"
MARK_BEGIN_PREFIX="<!-- agent-plan-and-track:begin ("
MARK_END="<!-- agent-plan-and-track:end -->"

usage() {
  echo "Usage: $0 {claude|copilot|codex|all}" >&2
  exit 1
}

need_jq() {
  command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)" >&2; exit 1; }
}

# Claude-only skills: installed by install_claude, skipped for the other
# harnesses. Everything else under skills/ is portable and installs everywhere.
CLAUDE_ONLY_SKILLS=("skill-comply")

is_claude_only() {
  local name="$1" s
  for s in "${CLAUDE_ONLY_SKILLS[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

# Portable skills: every skills/*/ dir except the Claude-only ones, so a new
# skill is picked up by re-installing with no install.sh edit.
copy_skills() {
  local dest="$1" dir name names=""
  mkdir -p "$dest"
  for dir in "$REPO_DIR"/skills/*/; do
    name="$(basename "$dir")"
    is_claude_only "$name" && continue
    cp -R "${dir%/}" "$dest/"
    names="$names${names:+,}$name"
  done
  echo "  skills          -> $dest/{$names}"
}

# Claude-only subagent definitions (agents/*.md): model-tiered helpers, each
# pinned to whatever model tier its task actually needs (cheaper for routine
# delegation, stronger for high-stakes judgment calls) regardless of the main
# session's model. These are repo-owned artifacts, exactly like skills. The
# repo is the source of truth, so each install overwrites them to keep them in
# sync (customize in the repo, not in ~/.claude/agents). Every agents/*.md is
# copied, so adding one needs no edit here. No-op if the repo has no agents/ dir.
copy_agents() {
  local dest="$1" f name names=""
  [ -d "$REPO_DIR/agents" ] || return 0
  mkdir -p "$dest"
  for f in "$REPO_DIR"/agents/*.md; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    cp "$f" "$dest/$name"
    names="$names${names:+,}${name%.md}"
  done
  [ -n "$names" ] && echo "  agents          -> $dest/{$names} (Claude-only)"
}

# Read a single-line frontmatter value for $2 out of $1's YAML frontmatter
# block (between the first and second `---` line). Matches a line starting
# with "<key>: " and returns the rest with at most one leading and one
# trailing double quote stripped. Doesn't handle multi-line YAML blocks or
# nested keys; every agents/*.md field this repo reads is a single physical
# line, so that's not a real limitation here. Returns '' when not found.
frontmatter_field() {
  local file="$1" key="$2"
  awk -v prefix="$key: " '
    /^---[[:space:]]*$/ { fm++; next }
    fm != 1 { next }
    index($0, prefix) == 1 {
      val = substr($0, length(prefix) + 1)
      sub(/^"/, "", val); sub(/"$/, "", val)
      print val
      exit
    }
  ' "$file"
}

# Everything in $1 after the closing `---` of its frontmatter block, with
# exactly one leading blank line stripped (agents/*.md all have one, matching
# the file body-vs-frontmatter separation the Codex TOML render needs raw).
agent_body() {
  awk '
    /^---[[:space:]]*$/ { fm++; next }
    fm < 2 { next }
    fm == 2 { fm++; if ($0 == "") next }
    { print }
  ' "$1"
}

# Escape a string for embedding in a basic double-quoted TOML string
# (backslashes first, then double quotes, so an escaped quote isn't
# re-escaped).
toml_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# Render one agents/*.md source ($1) into a Codex-native TOML agent file at
# $2. model is left UNSET: Claude model names (fable/opus/sonnet/haiku) don't
# translate to Codex's own model catalog, so the agent inherits whatever
# model the parent session is running. developer_instructions uses a TOML
# literal triple-single-quoted string so the body needs no escaping; same
# documented tradeoff upsert_toml_default takes on TOML string handling
# below, and none of this repo's agent bodies contain a literal ''' to break it.
render_codex_agent() {
  local src="$1" dest="$2" name description effort tools sandbox_mode
  name="$(frontmatter_field "$src" name)"
  description="$(frontmatter_field "$src" description)"
  effort="$(frontmatter_field "$src" effort)"
  tools="$(frontmatter_field "$src" tools)"
  case "$tools" in
    *Edit*|*Write*) sandbox_mode="workspace-write" ;;
    *)              sandbox_mode="read-only" ;;
  esac
  {
    printf 'name = "%s"\n' "$(toml_escape "$name")"
    printf 'description = "%s"\n' "$(toml_escape "$description")"
    printf 'model_reasoning_effort = "%s"\n' "$effort"
    printf 'sandbox_mode = "%s"\n' "$sandbox_mode"
    printf "developer_instructions = '''\n%s\n'''\n" "$(agent_body "$src")"
  } > "$dest"
}

# Codex-native mirror of copy_agents: same source (agents/*.md), rendered into
# Codex's one-TOML-file-per-agent format at $dest/<name>.toml instead of
# copied verbatim, since Codex has no Claude-style Markdown subagent file.
# Every agents/*.md is rendered, so adding one needs no edit here. No-op if
# the repo has no agents/ dir.
copy_codex_agents() {
  local dest="$1" f name names=""
  [ -d "$REPO_DIR/agents" ] || return 0
  mkdir -p "$dest"
  for f in "$REPO_DIR"/agents/*.md; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .md)"
    render_codex_agent "$f" "$dest/$name.toml"
    names="$names${names:+,}$name"
  done
  [ -n "$names" ] && echo "  agents (codex)  -> $dest/{$names}"
}

# Write $1 (a temp file) back to $2, preserving a symlink at $2 instead of
# replacing it. Config files are often symlinked from a dotfiles repo; a plain
# `mv` would swap the link for a regular file. When $2 is a symlink we write
# through it (truncate + rewrite the target); otherwise we mv for atomicity.
write_back() {
  local tmp="$1" file="$2"
  if [ -L "$file" ]; then cat "$tmp" > "$file"; rm -f "$tmp"; else mv "$tmp" "$file"; fi
}

# Render a hook wiring template ($1) to stdout with the __SCRIPTS__ placeholder
# replaced by the resolved absolute scripts dir ($2). Baking the real path at
# install time removes all runtime $HOME expansion from hook commands, which is
# exactly what Claude Code's Windows hook-resolution bugs mishandle. $2 stays
# forward-slashed (node accepts forward slashes on Windows too, and it avoids
# JSON backslash escaping); install.ps1 mirrors this substitution 1:1.
# Uses bash literal replacement (not sed), so a home path containing sed-special
# characters like '&', '|', or '\' can't corrupt the substituted JSON.
render_hook() {
  local content
  content="$(cat "$1")"
  printf '%s\n' "${content//__SCRIPTS__/$2}"
}

# Set a repo-owned JSON default in a settings file (jq), overwriting on every
# install so a re-run re-asserts the intended value. With PT_KEEP_MODEL=1 this
# reverts to set-if-absent: an existing value is kept, an absent one still gets
# the default. $3 is a JSON value literal ('"opusplan"', 'true').
set_json_default() {
  local file="$1" key="$2" jqval="$3" label="$4" tmp prev
  if [ "${PT_KEEP_MODEL:-}" = "1" ] && jq -e --arg k "$key" 'has($k)' "$file" >/dev/null 2>&1; then
    printf '  %-16s-- PT_KEEP_MODEL=1; kept %s=%s\n' "$label" "$key" \
      "$(jq -r --arg k "$key" '.[$k]' "$file")"
    return 0
  fi
  prev="$(jq -r --arg k "$key" 'if has($k) then (.[$k]|tostring) else "unset" end' "$file")"
  tmp="$(mktemp)"
  jq --arg k "$key" --argjson v "$jqval" '.[$k] = $v' "$file" > "$tmp" && write_back "$tmp" "$file"
  printf '  %-16s-> %s=%s (was: %s)\n' "$label" "$key" \
    "$(jq -r --arg k "$key" '.[$k]' "$file")" "$prev"
}

# Set a top-level (root-table) TOML `key = "value"`, overwriting on every install.
# TOML has no jq, so this stays dependency-free. Scope is the ROOT table (lines
# before the first [section]); a same-named key inside a [section] is a different
# key and is never touched. An absent key is PREPENDED as the file's first line,
# which is unambiguously a root assignment (never captured by a [section], never
# inside a multiline """...""" value). A present root key has its line replaced in
# place. Documented limit, out of scope by design: this is a line-based scan, so a
# root-region multiline ("""...""") value whose interior line reads like `key =` or
# a `[section]` header could fool it into rewriting string content. Codex
# config.toml has no such strings, so we accept that over shipping a TOML parser.
upsert_toml_default() {
  local file="$1" key="$2" val="$3" tmp
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  if awk -v key="$key" '
      seen { next }                                  # ignore everything after the first section
      /^[[:space:]]*\[/ { seen = 1; next }           # first [section] ends the root table
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { found = 1 }
      END { exit found ? 0 : 1 }
    ' "$file"; then
    tmp="$(mktemp)"
    awk -v key="$key" -v val="$val" '
      !seen && /^[[:space:]]*\[/ { seen = 1 }        # first [section] ends the root table
      !done && !seen && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
        print key " = \"" val "\""; done = 1; next   # replace the root key in place
      }
      { print }
    ' "$file" > "$tmp" && write_back "$tmp" "$file"
    echo "  plan-mode effort-> $key = \"$val\" set in $(basename "$file")"
  else
    tmp="$(mktemp)"
    { echo "$key = \"$val\""; cat "$file"; } > "$tmp" && write_back "$tmp" "$file"
    echo "  plan-mode effort-> $key = \"$val\" prepended in $(basename "$file")"
  fi
}

# Ensure the user's *global* git excludes file ignores the per-project
# tasks/todo.md and tasks/lessons.md scratch files the plan-and-track and
# capture-lesson skills create in whatever repo they run in (not just this
# one, so this belongs in the global excludes file, not this repo's own
# .gitignore). No-op if git isn't installed: gh has no gitignore concept of
# its own, so there's nothing to configure without git. Respects an existing
# core.excludesfile instead of assuming ~/.gitignore_global, since git only
# honors whatever that setting actually points to.
install_global_gitignore() {
  command -v git >/dev/null 2>&1 || {
    echo "Global gitignore (skipped: git not found)"
    return 0
  }
  echo "Global gitignore"
  local target
  target="$(git config --global --path core.excludesfile 2>/dev/null || true)"
  if [ -z "$target" ]; then
    target="$HOME/.gitignore_global"
    git config --global core.excludesfile "$target"
    echo "  core.excludesfile -> $target (was unset)"
  else
    echo "  core.excludesfile -> $target (existing)"
  fi
  mkdir -p "$(dirname "$target")"
  [ -f "$target" ] || : > "$target"
  if [ -s "$target" ] && [ -n "$(tail -c 1 "$target")" ]; then
    echo >> "$target"
  fi
  local entry added=""
  for entry in tasks/todo.md tasks/lessons.md; do
    grep -qxF "$entry" "$target" 2>/dev/null && continue
    echo "$entry" >> "$target"
    added="$added${added:+, }$entry"
  done
  if [ -n "$added" ]; then
    echo "  entries         -> added $added to $target"
  else
    echo "  entries         -- already present in $target"
  fi
}

install_digest() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && ! cmp -s "$REPO_DIR/rules/core-rules.md" "$dest"; then
    cp "$dest" "$dest.bak"
    echo "  (existing digest differed; backed up to $dest.bak)"
  fi
  cp "$REPO_DIR/rules/core-rules.md" "$dest"
  echo "  rules digest    -> $dest"
}

install_instructions() {
  local dest="$1" tmp
  mkdir -p "$(dirname "$dest")"
  if [ ! -f "$dest" ]; then
    { echo "$MARK_BEGIN"; cat "$REPO_DIR/rules/agent-guidelines.md"; echo "$MARK_END"; } > "$dest"
    echo "  instructions    -> $dest"
  elif grep -qF "$MARK_BEGIN_PREFIX" "$dest"; then
    tmp="$(mktemp)"
    awk -v prefix="$MARK_BEGIN_PREFIX" -v begin="$MARK_BEGIN" -v end="$MARK_END" -v src="$REPO_DIR/rules/agent-guidelines.md" '
      index($0, prefix) == 1 { print begin; while ((getline line < src) > 0) print line; close(src); skip = 1; next }
      $0 == end   { skip = 0 }
      !skip' "$dest" > "$tmp" && mv "$tmp" "$dest"
    echo "  instructions    -> managed block updated in $dest (content outside markers untouched)"
  else
    echo "  instructions    -- $dest exists without managed markers; NOT modified." \
         "Move the shared section into a '$MARK_BEGIN' ... '$MARK_END' block to make it updatable."
  fi
}

install_claude() {
  echo "Claude Code (user scope: ~/.claude)"
  copy_skills "$HOME/.claude/skills"
  local claude_skill
  for claude_skill in "${CLAUDE_ONLY_SKILLS[@]}"; do
    cp -R "$REPO_DIR/skills/$claude_skill" "$HOME/.claude/skills/"
    echo "  skill (claude)  -> ~/.claude/skills/$claude_skill (Claude-only)"
  done
  copy_agents "$HOME/.claude/agents"
  install_digest "$HOME/.claude/core-rules.md"
  install_instructions "$HOME/.claude/CLAUDE.md"
  mkdir -p "$HOME/.claude/scripts"
  # core-rules digest hook (shared script): replaces the old inline `cat` command.
  cp "$REPO_DIR/hooks/core-rules-digest.js" "$HOME/.claude/scripts/core-rules-digest.js"
  echo "  digest script   -> ~/.claude/scripts/core-rules-digest.js"
  # strategic-compact auto-suggest hook (Claude-only): script + PreToolUse hook.
  cp "$REPO_DIR/hooks/claude/suggest-compact.js" "$HOME/.claude/scripts/suggest-compact.js"
  echo "  compact script  -> ~/.claude/scripts/suggest-compact.js"
  # delivery-gate pre-finish Stop hook (shared Claude+Codex script): + Stop hook.
  cp "$REPO_DIR/hooks/delivery-gate.js" "$HOME/.claude/scripts/delivery-gate.js"
  echo "  delivery script -> ~/.claude/scripts/delivery-gate.js"
  # gateguard fact-forcing edit gate (shared universal script): + PreToolUse hook.
  cp "$REPO_DIR/hooks/gateguard.js" "$HOME/.claude/scripts/gateguard.js"
  echo "  gateguard script-> ~/.claude/scripts/gateguard.js"
  need_jq
  local settings="$HOME/.claude/settings.json" tmp
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  # Repo-owned model defaults, re-asserted on every install (PT_KEEP_MODEL=1 keeps
  # an existing per-machine choice): opusplan runs Opus in Plan mode and Sonnet for
  # execution; switchModelsOnFlag=true lets Claude Code switch to another model when
  # a message is flagged by safety measures, instead of pausing the session.
  set_json_default "$settings" model '"opusplan"' "model default"
  set_json_default "$settings" switchModelsOnFlag true "safety-switch"
  local cscripts="$HOME/.claude/scripts"
  # Match either the new digest command (core-rules-digest) or an old install's
  # inline `cat ...core-rules.md`, so upgrading never double-merges the hook.
  if grep -q 'core-rules' "$settings"; then
    echo "  digest hook     -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/claude/settings-hooks.json" "$cscripts") \
      '.hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + $h[0].hooks.UserPromptSubmit)' \
      "$settings" > "$tmp" && write_back "$tmp" "$settings"
    echo "  digest hook     -> merged into $settings (UserPromptSubmit)"
  fi
  if grep -q 'suggest-compact' "$settings"; then
    echo "  compact hook    -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/claude/pretooluse-compact.json" "$cscripts") \
      '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse)' \
      "$settings" > "$tmp" && write_back "$tmp" "$settings"
    echo "  compact hook    -> merged into $settings (PreToolUse, all tools)"
  fi
  if grep -q 'delivery-gate' "$settings"; then
    echo "  delivery hook   -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/claude/stop-delivery-gate.json" "$cscripts") \
      '.hooks.Stop = ((.hooks.Stop // []) + $h[0].hooks.Stop)' \
      "$settings" > "$tmp" && write_back "$tmp" "$settings"
    echo "  delivery hook   -> merged into $settings (Stop; warn-only, DELIVERY_GATE_BLOCK=1 to enforce)"
  fi
  if grep -q 'gateguard' "$settings"; then
    echo "  gateguard hook  -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/claude/pretooluse-gateguard.json" "$cscripts") \
      '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse)' \
      "$settings" > "$tmp" && write_back "$tmp" "$settings"
    echo "  gateguard hook  -> merged into $settings (PreToolUse on edits; GATEGUARD_DISABLED=1 to turn off)"
  fi
  echo "  done. New Claude Code sessions pick this up automatically."
}

install_copilot() {
  echo "GitHub Copilot (user scope: ~/.copilot)"
  copy_skills "$HOME/.copilot/skills"
  install_digest "$HOME/.copilot/core-rules.md"
  install_instructions "$HOME/.copilot/copilot-instructions.md"
  # Global model default: "auto" lets Copilot route to the best model per task.
  # Re-asserted on every install (PT_KEEP_MODEL=1 keeps an existing choice), but
  # only when the settings file parses as plain JSON: a JSONC file with comments
  # jq can't round-trip is left untouched (warn).
  local csettings="$HOME/.copilot/settings.json"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  model default   -- jq not found; skipping Copilot model default (add \"model\":\"auto\" by hand)"
  elif [ -f "$csettings" ] && ! jq empty "$csettings" >/dev/null 2>&1; then
    echo "  model default   -- $csettings isn't plain JSON (JSONC comments?); NOT modified. Add \"model\":\"auto\" by hand."
  else
    [ -f "$csettings" ] || echo '{}' > "$csettings"
    set_json_default "$csettings" model '"auto"' "model default"
  fi
  mkdir -p "$HOME/.copilot/hooks" "$HOME/.copilot/scripts"
  local cscripts="$HOME/.copilot/scripts" rendered
  # Shared scripts: the core-rules digest (replaces the old inline bash+jq
  # throttle, so Copilot no longer needs jq at runtime) and the universal
  # gateguard. UNVERIFIED: the Copilot CLI wasn't available to test against
  # locally; the wire format follows the docs + the proven core-rules.json shape.
  cp "$REPO_DIR/hooks/core-rules-digest.js" "$cscripts/core-rules-digest.js"
  echo "  digest script   -> ~/.copilot/scripts/core-rules-digest.js"
  cp "$REPO_DIR/hooks/gateguard.js" "$cscripts/gateguard.js"
  echo "  gateguard script-> ~/.copilot/scripts/gateguard.js"
  # Repo-owned hook wiring, overwritten each install (with a .bak if it differed).
  # Compare against the RENDERED template (paths already substituted), not the raw
  # template, or the baked-in path would always read as "changed" and re-.bak.
  local chook="$HOME/.copilot/hooks/core-rules.json"
  rendered="$(mktemp)"
  render_hook "$REPO_DIR/hooks/copilot/core-rules.json" "$cscripts" > "$rendered"
  if [ -f "$chook" ] && ! cmp -s "$rendered" "$chook"; then
    cp "$chook" "$chook.bak"
    echo "  (existing hook differed; backed up to $chook.bak)"
  fi
  cp "$rendered" "$chook"; rm -f "$rendered"
  echo "  hook            -> ~/.copilot/hooks/core-rules.json (postToolUse, 10-min throttle)"
  local ghook="$HOME/.copilot/hooks/pretooluse-gateguard.json"
  rendered="$(mktemp)"
  render_hook "$REPO_DIR/hooks/copilot/pretooluse-gateguard.json" "$cscripts" > "$rendered"
  if [ -f "$ghook" ] && ! cmp -s "$rendered" "$ghook"; then
    cp "$ghook" "$ghook.bak"
    echo "  (existing gateguard hook differed; backed up to $ghook.bak)"
  fi
  cp "$rendered" "$ghook"; rm -f "$rendered"
  echo "  gateguard hook  -> ~/.copilot/hooks/pretooluse-gateguard.json (preToolUse on create|edit)"
  echo "  done. Hooks need node at runtime. Start a NEW copilot session to load."
}

install_codex() {
  echo "Codex (user scope: ~/.codex; skills in ~/.agents/skills)"
  copy_skills "$HOME/.agents/skills"
  copy_codex_agents "$HOME/.codex/agents"
  install_digest "$HOME/.codex/core-rules.md"
  install_instructions "$HOME/.codex/AGENTS.md"
  # Plan-mode default, re-asserted on every install: raise reasoning effort in
  # Plan mode only, leaving the execution model and effort untouched. Codex has no
  # plan-mode model swap (no opusplan analog), so effort is the only phase-specific
  # lever. Not gated by PT_KEEP_MODEL (that opt-out covers model settings only).
  upsert_toml_default "$HOME/.codex/config.toml" "plan_mode_reasoning_effort" "xhigh"
  need_jq
  local hooks="$HOME/.codex/hooks.json" cscripts="$HOME/.codex/scripts" tmp
  mkdir -p "$HOME/.codex" "$cscripts"
  [ -f "$hooks" ] || echo '{"hooks":{}}' > "$hooks"
  # Shared scripts: the core-rules digest (replaces the old inline `cat`) plus
  # gateguard + delivery-gate. Codex's Stop payload and apply_patch PreToolUse are
  # Claude-shaped, so the same universal code runs here (dialect sniffed at runtime).
  cp "$REPO_DIR/hooks/core-rules-digest.js" "$cscripts/core-rules-digest.js"
  cp "$REPO_DIR/hooks/gateguard.js" "$cscripts/gateguard.js"
  cp "$REPO_DIR/hooks/delivery-gate.js" "$cscripts/delivery-gate.js"
  echo "  scripts         -> ~/.codex/scripts/{core-rules-digest,gateguard,delivery-gate}.js"
  # Match either the new digest command or an old install's inline `cat ...core-rules.md`,
  # so upgrading never double-merges the hook.
  if grep -q 'core-rules' "$hooks"; then
    echo "  hook            -- already present in hooks.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/codex/hooks.json" "$cscripts") \
      '.hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + $h[0].hooks.UserPromptSubmit)' \
      "$hooks" > "$tmp" && write_back "$tmp" "$hooks"
    echo "  hook            -> merged into $hooks (UserPromptSubmit, per turn)"
  fi
  if grep -q 'gateguard' "$hooks"; then
    echo "  gateguard hook  -- already present in hooks.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/codex/pretooluse-gateguard.json" "$cscripts") \
      '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse)' \
      "$hooks" > "$tmp" && write_back "$tmp" "$hooks"
    echo "  gateguard hook  -> merged into $hooks (PreToolUse on apply_patch; GATEGUARD_DISABLED=1 to turn off)"
  fi
  if grep -q 'delivery-gate' "$hooks"; then
    echo "  delivery hook   -- already present in hooks.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/codex/stop-delivery-gate.json" "$cscripts") \
      '.hooks.Stop = ((.hooks.Stop // []) + $h[0].hooks.Stop)' \
      "$hooks" > "$tmp" && write_back "$tmp" "$hooks"
    echo "  delivery hook   -> merged into $hooks (Stop; warn-only, DELIVERY_GATE_BLOCK=1 to enforce)"
  fi
  echo "  done. Hooks need node at runtime. Start a new codex session to load."
}

[ $# -eq 1 ] || usage
case "$1" in
  claude|copilot|codex|all) ;;
  *)                        usage ;;
esac

install_global_gitignore
echo

case "$1" in
  claude)  install_claude ;;
  copilot) install_copilot ;;
  codex)   install_codex ;;
  all)     install_claude; echo; install_copilot; echo; install_codex ;;
esac
