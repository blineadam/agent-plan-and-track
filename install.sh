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
#   - a previously installed skill/agent whose repo source was removed is pruned
#     on reinstall, tracked via a `.plan-and-track-manifest` in each managed dir;
#     only names a prior install recorded are ever touched (a name the manifest
#     never recorded, including user-added and office skills, is never pruned),
#     and a missing manifest prunes nothing.
#     Limitation: the prune is direct-children only, so a renamed file INSIDE a
#     still-installed skill dir, or a renamed hook script under the scripts dir,
#     is out of scope.
#
# PARITY: install.ps1 is the Windows (PowerShell) sibling of this script and must
# stay in lockstep. Any change to the managed surface here (skills, agents (the
# Claude .md copies, the Codex TOML rendering, and the Copilot .agent.md
# rendering), the core-rules digest, the instructions managed block, hook
# wiring + __SCRIPTS__ substitution, model/effort defaults, the TOML upsert,
# the global gitignore entries, the manifest-based stale prune keyed by
# .plan-and-track-manifest) must be mirrored there.
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

# All three harnesses wire hooks that shell out to `node <script>.js` at
# runtime, so check once up front and fail before writing anything, rather
# than letting a missing node surface later as a silent hook failure.
need_node() {
  command -v node >/dev/null 2>&1 || { echo "error: node is required (brew install node, or see https://nodejs.org)" >&2; exit 1; }
}

# Non-Copilot skills: installed by install_claude and install_codex, skipped by
# install_copilot. Everything else under skills/ is portable and installs everywhere.
NON_COPILOT_SKILLS=("skill-comply")

# Per-destination manifest file name (see prune_stale below) recording exactly
# what this repo installed there last time, so a stale prune only ever touches a
# name it previously recorded, never one it never installed.
MANIFEST_NAME=".plan-and-track-manifest"

is_copilot_excluded() {
  local name="$1" s
  for s in "${NON_COPILOT_SKILLS[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

# Newline-separated skill dir basenames. scope=all lists every skills/*/;
# scope=portable skips the non-Copilot ones. Mirrors copy_skills' loop.
skill_names() {
  local scope="$1" dir name
  for dir in "$REPO_DIR"/skills/*/; do
    name="$(basename "$dir")"
    [ "$scope" = portable ] && is_copilot_excluded "$name" && continue
    printf '%s\n' "$name"
  done
}

# Newline-separated installed agent filenames for extension $1 (md|toml).
# Empty when the repo has no agents/ dir.
agent_names() {
  local ext="$1" f name
  [ -d "$REPO_DIR/agents" ] || return 0
  for f in "$REPO_DIR"/agents/*.md; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .md)"
    printf '%s\n' "$name.$ext"
  done
}

# Remove repo-owned installed copies whose source left the repo, tracked by
# a per-dest manifest. Quarantines into a dot-attic rather than deleting:
# the manifest tracks NAME ownership, and a user could have installed their
# own content at a name this repo used to own, which git cannot restore. A
# failed prune warns and continues; it must never abort an install whose
# copies already succeeded. A failed quarantine also drops that entry from
# the rewritten manifest, so the item is never re-pruned: errs toward keeping
# content. No .bak (git covers repo content; the attic covers everything
# else). Rails confine deletion to direct children.
prune_stale() {
  local dest="$1" expected="$2" attic entry manifest
  manifest="$dest/$MANIFEST_NAME"
  attic="$dest/.plan-and-track-pruned"
  [ -d "$dest" ] || return 0
  # A symlinked manifest or attic would redirect our rewrite/quarantine at an
  # external target, so refuse the whole prune for this dest and leave state
  # untouched: the confinement guarantee outranks pruning one anomalous dir.
  if [ -L "$manifest" ]; then
    echo "  warn            -> $manifest is a symlink; skipping prune for $dest" >&2
    return 0
  fi
  if [ -L "$attic" ]; then
    echo "  warn            -> $attic is a symlink; skipping prune for $dest" >&2
    return 0
  fi
  if [ -f "$manifest" ]; then
    while IFS= read -r entry || [ -n "$entry" ]; do
      entry="${entry%$'\r'}"
      case "$entry" in ''|'#'*|*/*|*\\*|.*) continue ;; esac
      # Case-insensitive on purpose (parity with install.ps1's -contains): after a case-only
      # rename on a case-insensitive filesystem (macOS default), a case-sensitive match would
      # false-prune the wanted dir.
      printf '%s\n' "$expected" | grep -qixF -- "$entry" && continue
      # -e is false for a dangling symlink, so also accept -L or a stale link never prunes.
      { [ -e "$dest/$entry" ] || [ -L "$dest/$entry" ]; } || continue
      mkdir -p "$attic" || { echo "  warn            -> cannot make attic in $dest, kept $entry" >&2; continue; }
      rm -rf "${attic:?}/$entry"
      if mv "${dest:?}/$entry" "$attic/$entry" 2>/dev/null; then
        echo "  pruned          -> $dest/$entry (repo source removed; quarantined)"
      else
        echo "  warn            -> could not quarantine $dest/$entry, left in place" >&2
      fi
    done < "$manifest"
  fi
  # Atomic, fail-open rewrite: a sibling temp renamed over the manifest, so a
  # partial or failed write warns instead of aborting the installer (set -e).
  if { printf '%s\n' "# plan-and-track manifest v1"; printf '%s\n' "$expected"; } > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"; then
    :
  else
    rm -f "$manifest.tmp" 2>/dev/null || :
    echo "  warn            -> could not rewrite $manifest" >&2
  fi
}

# Portable skills: every skills/*/ dir except the non-Copilot ones, so a new
# skill is picked up by re-installing with no install.sh edit.
copy_skills() {
  local dest="$1" dir name names=""
  mkdir -p "$dest"
  for dir in "$REPO_DIR"/skills/*/; do
    name="$(basename "$dir")"
    is_copilot_excluded "$name" && continue
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

# Map $2, a comma-separated agents/*.md "tools:" frontmatter value (e.g.
# "Read, Grep, Glob"), to Copilot's own tool-alias vocabulary via the closed
# alias table (Read->read, Grep/Glob->search, Edit/Write/MultiEdit->edit,
# Bash->execute, WebFetch/WebSearch->web), deduped in first-occurrence order.
# An unknown source tool name is warned to stderr and dropped, never aborts.
# Returns the comma-space-joined, double-quoted elements for a YAML flow
# array (caller wraps in "[...]").
copilot_tools() {
  local src="$1" tools="$2" IFS=',' t alias out="" seen=","
  for t in $tools; do
    t="${t#"${t%%[![:space:]]*}"}"
    t="${t%"${t##*[![:space:]]}"}"
    [ -z "$t" ] && continue
    case "$t" in
      Read)                   alias="read" ;;
      Grep|Glob)               alias="search" ;;
      Edit|Write|MultiEdit)    alias="edit" ;;
      Bash)                    alias="execute" ;;
      WebFetch|WebSearch)      alias="web" ;;
      *)
        echo "  warn            -> $src: unknown tool '$t'; dropped from Copilot render" >&2
        continue
        ;;
    esac
    case "$seen" in
      *",$alias,"*) continue ;;
    esac
    seen="$seen$alias,"
    out="$out${out:+, }\"$alias\""
  done
  printf '%s' "$out"
}

# Render one agents/*.md source ($1) into a Copilot-native agent file at $2,
# per the GA custom-agents doc's own example frontmatter shape. Like
# render_codex_agent, model is left UNSET (no Claude->Copilot model
# translation); effort is dropped entirely (Copilot's agent frontmatter has no
# effort field). tools renders as a YAML flow array of double-quoted aliases
# via copilot_tools.
render_copilot_agent() {
  local src="$1" dest="$2" name description tools
  name="$(frontmatter_field "$src" name)"
  description="$(frontmatter_field "$src" description)"
  tools="$(copilot_tools "$src" "$(frontmatter_field "$src" tools)")"
  {
    printf -- '---\n'
    printf 'name: %s\n' "$name"
    printf 'description: "%s"\n' "$(toml_escape "$description")"
    printf 'tools: [%s]\n' "$tools"
    printf -- '---\n\n'
    agent_body "$src"
  } > "$dest"
}

# Copilot-native mirror of copy_codex_agents: same source (agents/*.md),
# rendered into Copilot's one-agent-file-per-agent format at
# $dest/<name>.agent.md instead of TOML, since Copilot has no Claude-style
# Markdown subagent file either. Every agents/*.md is rendered, so adding one
# needs no edit here. No-op if the repo has no agents/ dir.
copy_copilot_agents() {
  local dest="$1" f name names=""
  [ -d "$REPO_DIR/agents" ] || return 0
  mkdir -p "$dest"
  for f in "$REPO_DIR"/agents/*.md; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .md)"
    render_copilot_agent "$f" "$dest/$name.agent.md"
    names="$names${names:+,}$name"
  done
  [ -n "$names" ] && echo "  agents (copilot)-> $dest/{$names}"
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
  local non_copilot_skill
  for non_copilot_skill in "${NON_COPILOT_SKILLS[@]}"; do
    cp -R "$REPO_DIR/skills/$non_copilot_skill" "$HOME/.claude/skills/"
    echo "  skill (non-Copilot) -> ~/.claude/skills/$non_copilot_skill"
  done
  prune_stale "$HOME/.claude/skills" "$(skill_names all)"
  copy_agents "$HOME/.claude/agents"
  prune_stale "$HOME/.claude/agents" "$(agent_names md)"
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
  # plan-gate plan-and-track enforcement (Claude-only script): + PreToolUse hook.
  cp "$REPO_DIR/hooks/claude/plan-gate.js" "$HOME/.claude/scripts/plan-gate.js"
  echo "  plan-gate script-> ~/.claude/scripts/plan-gate.js"
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
  if grep -q 'plan-gate' "$settings"; then
    echo "  plan-gate hook  -- already present in settings.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/claude/pretooluse-plan-gate.json" "$cscripts") \
      '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse)' \
      "$settings" > "$tmp" && write_back "$tmp" "$settings"
    echo "  plan-gate hook  -> merged into $settings (PreToolUse on Skill+todo.md edits; PLANGATE_DISABLED=1 to turn off)"
  fi
  echo "  done. New Claude Code sessions pick this up automatically."
}

install_copilot() {
  echo "GitHub Copilot (user scope: ~/.copilot)"
  copy_skills "$HOME/.copilot/skills"
  prune_stale "$HOME/.copilot/skills" "$(skill_names portable)"
  copy_copilot_agents "$HOME/.copilot/agents"
  prune_stale "$HOME/.copilot/agents" "$(agent_names "agent.md")"
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
  local non_copilot_skill
  for non_copilot_skill in "${NON_COPILOT_SKILLS[@]}"; do
    cp -R "$REPO_DIR/skills/$non_copilot_skill" "$HOME/.agents/skills/"
    echo "  skill (non-Copilot) -> ~/.agents/skills/$non_copilot_skill"
  done
  prune_stale "$HOME/.agents/skills" "$(skill_names all)"
  copy_codex_agents "$HOME/.codex/agents"
  prune_stale "$HOME/.codex/agents" "$(agent_names toml)"
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
  # gateguard + delivery-gate, plus the Codex-specific warn-only plan gate.
  # Codex's Stop payload and apply_patch PreToolUse are Claude-shaped, so the
  # universal scripts run here unchanged (dialect sniffed at runtime).
  cp "$REPO_DIR/hooks/core-rules-digest.js" "$cscripts/core-rules-digest.js"
  cp "$REPO_DIR/hooks/gateguard.js" "$cscripts/gateguard.js"
  cp "$REPO_DIR/hooks/delivery-gate.js" "$cscripts/delivery-gate.js"
  cp "$REPO_DIR/hooks/codex/plan-gate-pilot.js" "$cscripts/plan-gate.js"
  echo "  scripts         -> ~/.codex/scripts/{core-rules-digest,gateguard,delivery-gate,plan-gate}.js"
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
  local plan_pre plan_post
  plan_pre="$(jq --arg command "node \"$cscripts/plan-gate.js\" --pre" '[.hooks.PreToolUse[]?.hooks[]?.command | select(. == $command)] | length > 0' "$hooks")"
  plan_post="$(jq --arg command "node \"$cscripts/plan-gate.js\" --post" '[.hooks.PostToolUse[]?.hooks[]?.command | select(. == $command)] | length > 0' "$hooks")"
  if [ "$plan_pre" = true ] && [ "$plan_post" = true ]; then
    echo "  plan-gate hook  -- already present in hooks.json"
  else
    tmp="$(mktemp)"
    jq --slurpfile h <(render_hook "$REPO_DIR/hooks/codex/plan-gate-pilot-hooks.json" "$cscripts") --argjson add_pre "$([ "$plan_pre" = true ] && echo false || echo true)" --argjson add_post "$([ "$plan_post" = true ] && echo false || echo true)" \
      'if $add_pre then .hooks.PreToolUse = ((.hooks.PreToolUse // []) + $h[0].hooks.PreToolUse) else . end | if $add_post then .hooks.PostToolUse = ((.hooks.PostToolUse // []) + $h[0].hooks.PostToolUse) else . end' \
      "$hooks" > "$tmp" && write_back "$tmp" "$hooks"
    echo "  plan-gate hook  -> repaired in $hooks (PreToolUse + PostToolUse on apply_patch; warn-only)"
  fi
  echo "  done. Hooks need node at runtime. Start a new codex session to load."
}

[ $# -eq 1 ] || usage
case "$1" in
  claude|copilot|codex|all) ;;
  *)                        usage ;;
esac

need_node
install_global_gitignore
echo

case "$1" in
  claude)  install_claude ;;
  copilot) install_copilot ;;
  codex)   install_codex ;;
  all)     install_claude; echo; install_copilot; echo; install_codex ;;
esac
