#!/usr/bin/env bash
# Install the plan-and-track agent rules, skills, and hooks into user-scope
# config for Claude Code, GitHub Copilot, and/or Codex.
#
# Usage: ./install.sh {claude|copilot|codex|all}
#
# Idempotent and non-destructive:
#   - skills are copied (this repo is the source of truth)
#   - the core-rules digest is copied; a differing existing file is backed up to *.bak;
#     machine-specific rules belong in core-rules.local.md next to it (never touched)
#   - instruction files (CLAUDE.md / AGENTS.md / copilot-instructions.md): the repo
#     content lives inside a marker-delimited managed block that installs update in
#     place; anything outside the markers is yours and is never touched. An existing
#     file WITHOUT markers is never modified.
#   - hooks are merged only if not already installed (Claude/Codex); the Copilot hook
#     files are repo-owned and overwritten, with a *.bak backup if one differed
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARK_BEGIN="<!-- agent-plan-and-track:begin (managed block — edit in the repo, not here) -->"
MARK_END="<!-- agent-plan-and-track:end -->"

usage() {
  echo "Usage: $0 {claude|copilot|codex|all}" >&2
  exit 1
}

need_jq() {
  command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)" >&2; exit 1; }
}

# Claude-only skills — installed by install_claude, skipped for the other
# harnesses. Everything else under skills/ is portable and installs everywhere.
CLAUDE_ONLY_SKILLS=("skill-comply")

is_claude_only() {
  local name="$1" s
  for s in "${CLAUDE_ONLY_SKILLS[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

# Portable skills — every skills/*/ dir except the Claude-only ones, so a new
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

# Claude-only subagent definitions (agents/*.md): model-tiered helpers so
# offloaded work runs on a cheaper model than the main session regardless of
# what it's set to. These are repo-owned artifacts, exactly like skills — the
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

# Set a top-level (root-table) TOML `key = "value"` in a config file,
# idempotently. TOML has no jq, so this stays dependency-free:
#   - Idempotency check is scoped to the ROOT table (lines before the first
#     [section]). A same-named key inside a [section] is a *different* key and
#     must not count — it wouldn't supply the top-level default anyway.
#   - The write PREPENDS the key as the file's first line. A root key at the
#     very top is unambiguously a root-table assignment: it can never be
#     captured by a [section] and can never land inside a multiline ("""...""")
#     value, so no TOML-structure parsing is needed. (Contrived exception: a
#     multiline string in the root region whose contents mimic a section header
#     could fool the check into a false negative — accepted; Codex configs
#     don't do that.)
insert_toml_default() {
  local file="$1" key="$2" val="$3" tmp
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  if awk -v key="$key" '
      seen { next }                                  # ignore everything after the first section
      /^[[:space:]]*\[/ { seen = 1; next }           # first [section] ends the root table
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { found = 1 }
      END { exit found ? 0 : 1 }
    ' "$file"; then
    echo "  plan-mode effort-- $key already set at root in $(basename "$file"); left alone"
    return 0
  fi
  tmp="$(mktemp)"
  { echo "$key = \"$val\""; cat "$file"; } > "$tmp" && mv "$tmp" "$file"
  echo "  plan-mode effort-> $key = \"$val\" prepended in $(basename "$file")"
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
  elif grep -qF "$MARK_BEGIN" "$dest"; then
    tmp="$(mktemp)"
    awk -v begin="$MARK_BEGIN" -v end="$MARK_END" -v src="$REPO_DIR/rules/agent-guidelines.md" '
      $0 == begin { print; while ((getline line < src) > 0) print line; close(src); skip = 1; next }
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
  # strategic-compact auto-suggest hook (Claude-only): script + PreToolUse hook.
  mkdir -p "$HOME/.claude/scripts"
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
  # Global model default: opusplan (Opus in Plan mode, Sonnet for execution) —
  # a cheaper default than pinning Opus for everything. Only set when the user
  # hasn't already chosen a model; never clobber an existing choice.
  if jq -e 'has("model")' "$settings" >/dev/null 2>&1; then
    echo "  model default   -- settings.json already sets model=$(jq -r .model "$settings"); left alone"
  else
    tmp="$(mktemp)"
    jq '.model = "opusplan"' "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "  model default   -> settings.json model=opusplan (Opus plan / Sonnet exec)"
  fi
  if grep -q 'core-rules\.md' "$settings"; then
    echo "  digest hook     -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/claude/settings-hooks.json" \
      '.hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + $h[0].hooks.UserPromptSubmit)' \
      "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "  digest hook     -> merged into $settings (UserPromptSubmit)"
  fi
  if grep -q 'suggest-compact' "$settings"; then
    echo "  compact hook    -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/claude/pretooluse-compact.json" \
      '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse)' \
      "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "  compact hook    -> merged into $settings (PreToolUse, all tools)"
  fi
  if grep -q 'delivery-gate' "$settings"; then
    echo "  delivery hook   -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/claude/stop-delivery-gate.json" \
      '.hooks.Stop = ((.hooks.Stop // []) + $h[0].hooks.Stop)' \
      "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "  delivery hook   -> merged into $settings (Stop; warn-only, DELIVERY_GATE_BLOCK=1 to enforce)"
  fi
  if grep -q 'gateguard' "$settings"; then
    echo "  gateguard hook  -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/claude/pretooluse-gateguard.json" \
      '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse)' \
      "$settings" > "$tmp" && mv "$tmp" "$settings"
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
  # Add only if absent, and only when the settings file parses as plain JSON —
  # a JSONC file with comments jq can't round-trip is left untouched (warn).
  local csettings="$HOME/.copilot/settings.json" ctmp
  if ! command -v jq >/dev/null 2>&1; then
    echo "  model default   -- jq not found; skipping Copilot model default (add \"model\":\"auto\" by hand)"
  elif [ -f "$csettings" ] && ! jq empty "$csettings" >/dev/null 2>&1; then
    echo "  model default   -- $csettings isn't plain JSON (JSONC comments?); NOT modified. Add \"model\":\"auto\" by hand."
  else
    [ -f "$csettings" ] || echo '{}' > "$csettings"
    if jq -e 'has("model")' "$csettings" >/dev/null 2>&1; then
      echo "  model default   -- Copilot settings.json already sets model=$(jq -r .model "$csettings"); left alone"
    else
      ctmp="$(mktemp)"
      jq '.model = "auto"' "$csettings" > "$ctmp" && mv "$ctmp" "$csettings"
      echo "  model default   -> Copilot settings.json model=auto"
    fi
  fi
  mkdir -p "$HOME/.copilot/hooks"
  local chook="$HOME/.copilot/hooks/core-rules.json"
  if [ -f "$chook" ] && ! cmp -s "$REPO_DIR/hooks/copilot/core-rules.json" "$chook"; then
    cp "$chook" "$chook.bak"
    echo "  (existing hook differed; backed up to $chook.bak)"
  fi
  cp "$REPO_DIR/hooks/copilot/core-rules.json" "$chook"
  echo "  hook            -> ~/.copilot/hooks/core-rules.json (postToolUse, 10-min throttle)"
  # gateguard: universal script + repo-owned preToolUse wiring (like core-rules).
  # UNVERIFIED: the Copilot CLI wasn't available to test against locally — the
  # wire format follows the docs + the proven core-rules.json shape.
  mkdir -p "$HOME/.copilot/scripts"
  cp "$REPO_DIR/hooks/gateguard.js" "$HOME/.copilot/scripts/gateguard.js"
  echo "  gateguard script-> ~/.copilot/scripts/gateguard.js"
  local ghook="$HOME/.copilot/hooks/pretooluse-gateguard.json"
  if [ -f "$ghook" ] && ! cmp -s "$REPO_DIR/hooks/copilot/pretooluse-gateguard.json" "$ghook"; then
    cp "$ghook" "$ghook.bak"
    echo "  (existing gateguard hook differed; backed up to $ghook.bak)"
  fi
  cp "$REPO_DIR/hooks/copilot/pretooluse-gateguard.json" "$ghook"
  echo "  gateguard hook  -> ~/.copilot/hooks/pretooluse-gateguard.json (preToolUse on create|edit)"
  echo "  done. Hooks need jq + node at runtime. Start a NEW copilot session to load."
}

install_codex() {
  echo "Codex (user scope: ~/.codex; skills in ~/.agents/skills)"
  copy_skills "$HOME/.agents/skills"
  install_digest "$HOME/.codex/core-rules.md"
  install_instructions "$HOME/.codex/AGENTS.md"
  # Plan-mode default: raise reasoning effort in Plan mode only, leaving the
  # execution model + effort untouched. Codex has no plan-mode *model* swap
  # (no opusplan analog), so effort is the only phase-specific lever.
  insert_toml_default "$HOME/.codex/config.toml" "plan_mode_reasoning_effort" "high"
  need_jq
  local hooks="$HOME/.codex/hooks.json" tmp
  mkdir -p "$HOME/.codex"
  [ -f "$hooks" ] || echo '{"hooks":{}}' > "$hooks"
  if grep -q 'core-rules\.md' "$hooks"; then
    echo "  hook            -- already present in hooks.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/codex/hooks.json" \
      '.hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + $h[0].hooks.UserPromptSubmit)' \
      "$hooks" > "$tmp" && mv "$tmp" "$hooks"
    echo "  hook            -> merged into $hooks (UserPromptSubmit, per turn)"
  fi
  # gateguard + delivery-gate share the universal scripts with Claude; Codex's
  # Stop payload and apply_patch PreToolUse are Claude-shaped, so the same code
  # runs here (dialect sniffed at runtime).
  mkdir -p "$HOME/.codex/scripts"
  cp "$REPO_DIR/hooks/gateguard.js" "$HOME/.codex/scripts/gateguard.js"
  cp "$REPO_DIR/hooks/delivery-gate.js" "$HOME/.codex/scripts/delivery-gate.js"
  echo "  scripts         -> ~/.codex/scripts/{gateguard,delivery-gate}.js"
  if grep -q 'gateguard' "$hooks"; then
    echo "  gateguard hook  -- already present in hooks.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/codex/pretooluse-gateguard.json" \
      '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse)' \
      "$hooks" > "$tmp" && mv "$tmp" "$hooks"
    echo "  gateguard hook  -> merged into $hooks (PreToolUse on apply_patch; GATEGUARD_DISABLED=1 to turn off)"
  fi
  if grep -q 'delivery-gate' "$hooks"; then
    echo "  delivery hook   -- already present in hooks.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/codex/stop-delivery-gate.json" \
      '.hooks.Stop = ((.hooks.Stop // []) + $h[0].hooks.Stop)' \
      "$hooks" > "$tmp" && mv "$tmp" "$hooks"
    echo "  delivery hook   -> merged into $hooks (Stop; warn-only, DELIVERY_GATE_BLOCK=1 to enforce)"
  fi
  echo "  done. Hooks need node at runtime. Start a new codex session to load."
}

[ $# -eq 1 ] || usage
case "$1" in
  claude)  install_claude ;;
  copilot) install_copilot ;;
  codex)   install_codex ;;
  all)     install_claude; echo; install_copilot; echo; install_codex ;;
  *)       usage ;;
esac
