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
#     file is repo-owned and overwritten, with a *.bak backup if it differed
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
  install_digest "$HOME/.claude/core-rules.md"
  install_instructions "$HOME/.claude/CLAUDE.md"
  # strategic-compact auto-suggest hook (Claude-only): script + PreToolUse hook.
  mkdir -p "$HOME/.claude/scripts"
  cp "$REPO_DIR/hooks/claude/suggest-compact.js" "$HOME/.claude/scripts/suggest-compact.js"
  echo "  compact script  -> ~/.claude/scripts/suggest-compact.js"
  # delivery-gate pre-finish Stop hook (Claude-only): script + Stop hook.
  cp "$REPO_DIR/hooks/claude/delivery-gate.js" "$HOME/.claude/scripts/delivery-gate.js"
  echo "  delivery script -> ~/.claude/scripts/delivery-gate.js"
  # gateguard fact-forcing edit gate (Claude-only): script + PreToolUse hook.
  cp "$REPO_DIR/hooks/claude/gateguard.js" "$HOME/.claude/scripts/gateguard.js"
  echo "  gateguard script-> ~/.claude/scripts/gateguard.js"
  need_jq
  local settings="$HOME/.claude/settings.json" tmp
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
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
  mkdir -p "$HOME/.copilot/hooks"
  local chook="$HOME/.copilot/hooks/core-rules.json"
  if [ -f "$chook" ] && ! cmp -s "$REPO_DIR/hooks/copilot/core-rules.json" "$chook"; then
    cp "$chook" "$chook.bak"
    echo "  (existing hook differed; backed up to $chook.bak)"
  fi
  cp "$REPO_DIR/hooks/copilot/core-rules.json" "$chook"
  echo "  hook            -> ~/.copilot/hooks/core-rules.json (postToolUse, 10-min throttle)"
  echo "  done. Hook needs jq at runtime. Start a NEW copilot session to load."
}

install_codex() {
  echo "Codex (user scope: ~/.codex; skills in ~/.agents/skills)"
  copy_skills "$HOME/.agents/skills"
  install_digest "$HOME/.codex/core-rules.md"
  install_instructions "$HOME/.codex/AGENTS.md"
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
  echo "  done. Start a new codex session to load."
}

[ $# -eq 1 ] || usage
case "$1" in
  claude)  install_claude ;;
  copilot) install_copilot ;;
  codex)   install_codex ;;
  all)     install_claude; echo; install_copilot; echo; install_codex ;;
  *)       usage ;;
esac
