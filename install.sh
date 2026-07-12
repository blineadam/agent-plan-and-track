#!/usr/bin/env bash
# Install the plan-and-track agent rules, skills, and hooks into user-scope
# config for Claude Code, GitHub Copilot, and/or Codex.
#
# Usage: ./install.sh {claude|copilot|codex|all}
#
# Idempotent and non-destructive:
#   - skills are copied (this repo is the source of truth)
#   - the core-rules digest is copied; a differing existing file is backed up to *.bak
#   - existing instruction files (CLAUDE.md / AGENTS.md / copilot-instructions.md)
#     are never modified — merge rules/agent-guidelines.md into them manually
#   - hooks are merged/copied only if not already installed
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 {claude|copilot|codex|all}" >&2
  exit 1
}

need_jq() {
  command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)" >&2; exit 1; }
}

copy_skills() {
  local dest="$1"
  mkdir -p "$dest"
  cp -R "$REPO_DIR/skills/plan-and-track" "$REPO_DIR/skills/capture-lesson" "$dest/"
  echo "  skills          -> $dest/{plan-and-track,capture-lesson}"
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
  local dest="$1"
  if [ -f "$dest" ]; then
    echo "  instructions    -- $dest exists; NOT modified." \
         "Merge rules/agent-guidelines.md into it manually if desired."
  else
    mkdir -p "$(dirname "$dest")"
    cp "$REPO_DIR/rules/agent-guidelines.md" "$dest"
    echo "  instructions    -> $dest"
  fi
}

install_claude() {
  echo "Claude Code (user scope: ~/.claude)"
  copy_skills "$HOME/.claude/skills"
  install_digest "$HOME/.claude/core-rules.md"
  install_instructions "$HOME/.claude/CLAUDE.md"
  need_jq
  local settings="$HOME/.claude/settings.json" tmp
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  if grep -q 'core-rules\.md' "$settings"; then
    echo "  hook            -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h "$REPO_DIR/hooks/claude/settings-hooks.json" \
      '.hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + $h[0].hooks.UserPromptSubmit)' \
      "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "  hook            -> merged into $settings (UserPromptSubmit)"
  fi
  echo "  done. New Claude Code sessions pick this up automatically."
}

install_copilot() {
  echo "GitHub Copilot (user scope: ~/.copilot)"
  copy_skills "$HOME/.copilot/skills"
  install_digest "$HOME/.copilot/core-rules.md"
  install_instructions "$HOME/.copilot/copilot-instructions.md"
  mkdir -p "$HOME/.copilot/hooks"
  if [ -f "$HOME/.copilot/hooks/core-rules.json" ]; then
    echo "  hook            -- ~/.copilot/hooks/core-rules.json already exists; NOT modified"
  else
    cp "$REPO_DIR/hooks/copilot/core-rules.json" "$HOME/.copilot/hooks/core-rules.json"
    echo "  hook            -> ~/.copilot/hooks/core-rules.json (postToolUse, 10-min throttle)"
  fi
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
