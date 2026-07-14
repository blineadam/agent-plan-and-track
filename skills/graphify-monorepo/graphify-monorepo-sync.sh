#!/usr/bin/env bash
# graphify-monorepo-sync.sh: keep a MERGED multi-workspace graphify graph current,
# and keep the per-harness instruction files honest about how to refresh it.
#
# Why this exists
#   graphify's own `graphify <harness> install` writes "after code changes, run
#   `graphify update .`" into CLAUDE.md / AGENTS.md / copilot-instructions.md. On a
#   monorepo whose root graph is a MERGE of several workspace graphs, that line is
#   wrong: `graphify update .` rebuilds the root as one corpus and destroys the merge.
#   This script is the correct refresh (update each workspace -> merge -> cluster) and
#   re-asserts a "## Graphify monorepo override" block that supersedes that line.
#
# Subcommands
#   setup <ws1> <ws2> [ws3...]   record the workspace list, scaffold this script + the
#                                pre-push hook into the repo, write the override block.
#                                Run once, from the monorepo root, after you have built
#                                each workspace graph (see SKILL.md, "One-time build").
#   sync [--label] [--workspaces "a b"]
#                                update each workspace graph (AST-only), re-merge into
#                                the root, re-cluster, and re-assert the override block.
#                                This is the day-to-day / git-hook entry point.
#   write-instructions           only (re)write the override block into existing files.
#   install-hook                 only (re)install the warn-only pre-push hook.
#
# Config (graphify-monorepo.conf, next to this script; written by `setup`)
#   WORKSPACES=(server ui)   workspace dirs merged into the root graph (>=2).
#   CLUSTER_NO_LABEL=1       1 = skip LLM community naming during sync (AST-only, no API
#                            cost, CI/hook-safe; default). 0 or `sync --label` to name.
#
# Env
#   SYNC_WORKSPACES="a b"     restrict the update step to a subset (merge still uses all).
#   GRAPHIFY_MONOREPO_SKIP=1  make the pre-push hook a no-op for one push.
#
# Notes
#   - The override is a `## Graphify monorepo override` H2 placed right after graphify's
#     own `## graphify` section. `graphify <harness> install` rewrites only its own
#     section, up to the next H2, so it stops at our heading and leaves the override
#     intact. Each sync re-asserts the whole H2 in place (heading to next H2), the same
#     section-replace mechanic graphify uses, so it stays idempotent and never drifts.
#   - Nothing here depends on GitHub, PRs, or a `.git` dir. Without `.git` the hook is
#     skipped and agents refresh via the override instruction instead.
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
CONF_NAME="graphify-monorepo.conf"
ENGINE_NAME="graphify-monorepo-sync.sh"
OVR_HEADING="## Graphify monorepo override"
OVR_NOTE="<!-- Managed by ${ENGINE_NAME}; re-asserted on every sync. Edit the skill, not here. -->"
# Instruction files graphify writes, relative to the repo root. The override is
# re-asserted into whichever of these already exist.
INSTRUCTION_FILES=("CLAUDE.md" "AGENTS.md" ".github/copilot-instructions.md")

die() { echo "graphify-monorepo: $*" >&2; exit 1; }
info() { echo "graphify-monorepo: $*"; }

# Write $1 (a temp file) back to $2 by rewriting $2 in place. This preserves $2's
# existing mode and owner, and any symlink at $2 (config files are often symlinked from
# a dotfiles repo). A plain `mv` would instead stamp the temp file's 0600 mode onto $2
# and replace a symlink with a regular file.
write_back() {
  local tmp="$1" file="$2"
  cat "$tmp" > "$file"; rm -f "$tmp"
}

# ROOT is the repo the graph lives in. For sync/write-instructions/install-hook the
# script sits at the repo root (scaffolded there by setup), so its own dir is ROOT.
# `setup` overrides this to $PWD so it can scaffold from the user-scope skill copy.
ROOT="$(dirname "$SELF")"
# Fallback: if this copy has no config beside it (e.g. someone ran the user-scope skill
# copy directly) but the current directory is a configured repo, operate on that repo.
[ -f "$ROOT/$CONF_NAME" ] || { [ -f "$PWD/$CONF_NAME" ] && ROOT="$PWD"; }

load_config() {
  local conf="$ROOT/$CONF_NAME"
  [ -f "$conf" ] || die "no $CONF_NAME at $ROOT. Run '$ENGINE_NAME setup <ws1> <ws2> ...' first."
  # shellcheck disable=SC1090
  source "$conf"
  [ "${#WORKSPACES[@]}" -ge 2 ] || die "$CONF_NAME must list >=2 WORKSPACES (a single workspace needs no merge; use 'graphify update .')."
  CLUSTER_NO_LABEL="${CLUSTER_NO_LABEL:-1}"
}

# The override section, emitted to stdout. Kept workspace-agnostic on purpose: it points
# at this script rather than enumerating workspaces, so it never drifts when the
# workspace list changes. Starts with the H2 heading (the anchor) and ends at its last
# body line; callers add the trailing blank that separates it from the next section.
emit_override_block() {
  cat <<EOF
$OVR_HEADING

$OVR_NOTE

The root \`graphify-out/graph.json\` is a MERGED multi-workspace graph. Do not run
\`graphify update .\` on this repo: it rebuilds the root as a single corpus and destroys
the merge.

After code changes, refresh the graph with:

\`\`\`sh
./$ENGINE_NAME sync
\`\`\`

That updates each affected workspace graph, re-merges them into the root, and
re-clusters. Query the merged graph explicitly:

\`\`\`sh
graphify query "<question>" --graph graphify-out/graph.json
\`\`\`
EOF
}

# Insert or re-assert the override H2 in one instruction file, idempotently:
#   - our heading already present -> replace our whole section (heading to next H2 / EOF)
#   - graphify's `## graphify` section present -> insert our H2 right after it
#   - neither -> append at EOF
# Anchoring on our own heading (not an inner marker) is what makes this survive a
# `graphify <harness> install`: that installer replaces graphify's section only up to
# the next H2, which is our heading, so it can never swallow part of our block.
write_override_into() {
  local file="$1" block tmp
  block="$(mktemp)"; emit_override_block > "$block"
  tmp="$(mktemp)"
  if grep -qE '^## Graphify monorepo override[[:space:]]*$' "$file"; then
    awk -v src="$block" '
      /^## Graphify monorepo override[[:space:]]*$/ {
        while ((getline l < src) > 0) print l; close(src); print ""; drop=1; next
      }
      drop && /^## / { drop=0 }
      drop { next }
      { print }
    ' "$file" > "$tmp"
  elif grep -qE '^## graphify[[:space:]]*$' "$file"; then
    awk -v src="$block" '
      /^## graphify[[:space:]]*$/ { print; ingf=1; next }
      ingf && /^## / { while ((getline l < src) > 0) print l; close(src); print ""; ingf=0 }
      { print }
      END { if (ingf) { while ((getline l < src) > 0) print l; close(src); print "" } }
    ' "$file" > "$tmp"
  else
    { cat "$file"; echo ""; cat "$block"; echo ""; } > "$tmp"
  fi
  write_back "$tmp" "$file"
  rm -f "$block"
}

cmd_write_instructions() {
  local file found=0
  for file in "${INSTRUCTION_FILES[@]}"; do
    if [ -f "$ROOT/$file" ]; then
      write_override_into "$ROOT/$file"
      info "override block re-asserted in $file"
      found=1
    fi
  done
  [ "$found" = 1 ] || info "no instruction files present yet (${INSTRUCTION_FILES[*]}); run 'graphify <harness> install' first."
}

cmd_sync() {
  local label=0 subset=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) label=1 ;;
      --workspaces) shift; subset="${1:-}" ;;
      *) die "sync: unknown argument '$1'" ;;
    esac
    shift
  done
  load_config
  cd "$ROOT"

  # Which workspaces to re-extract this run (default all; merge always uses all).
  local update_list=("${WORKSPACES[@]}")
  [ -n "${SYNC_WORKSPACES:-}" ] && read -ra update_list <<< "$SYNC_WORKSPACES"
  [ -n "$subset" ] && read -ra update_list <<< "$subset"

  # Reject any update-list entry that is not a configured workspace: the merge always
  # uses WORKSPACES, so updating a stray or typo'd dir would leave the real one stale.
  local w c ok
  for w in "${update_list[@]}"; do
    ok=0
    for c in "${WORKSPACES[@]}"; do [ "$w" = "$c" ] && { ok=1; break; }; done
    [ "$ok" = 1 ] || die "'$w' is not a configured workspace (WORKSPACES: ${WORKSPACES[*]}). Check --workspaces / SYNC_WORKSPACES."
  done

  local ws
  for ws in "${update_list[@]}"; do
    [ -d "$ROOT/$ws" ] || die "workspace '$ws' not found under $ROOT."
    info "updating workspace graph: $ws"
    graphify update "./$ws" --no-cluster
  done

  # Merge every configured workspace graph into the root (unchanged ones reuse their
  # existing graph.json). Missing one means that workspace was never built.
  local graphs=()
  for ws in "${WORKSPACES[@]}"; do
    [ -f "$ROOT/$ws/graphify-out/graph.json" ] || die "no graph for workspace '$ws' ($ws/graphify-out/graph.json). Build it once (see SKILL.md) before syncing."
    graphs+=("./$ws/graphify-out/graph.json")
  done
  mkdir -p graphify-out
  info "merging ${#graphs[@]} workspace graphs into graphify-out/graph.json"
  graphify merge-graphs "${graphs[@]}" --out ./graphify-out/graph.json

  local cargs=(cluster-only . --graph ./graphify-out/graph.json --no-viz)
  if [ "$label" = 1 ] || [ "${CLUSTER_NO_LABEL:-1}" != 1 ]; then
    info "clustering merged graph (with community labeling)"
  else
    cargs+=(--no-label)
    info "clustering merged graph (AST-only, no labeling)"
  fi
  graphify "${cargs[@]}"

  cmd_write_instructions
  info "sync complete."
}

# Write the warn-only pre-push hook and, when a .git dir exists and no other
# hooksPath is configured, point core.hooksPath at ./githooks so clones inherit it.
cmd_install_hook() {
  local hookdir="$ROOT/githooks" hook="$ROOT/githooks/pre-push"
  local marker="graphify-monorepo: refresh the merged graph before push"
  # Don't clobber a pre-push the repo already maintains: only (re)write our own.
  if [ -e "$hook" ] && ! grep -q "$marker" "$hook" 2>/dev/null; then
    info "githooks/pre-push already exists and isn't ours; leaving it untouched. Add a call to '$ENGINE_NAME sync' in it to enable auto-refresh."
    return 0
  fi
  mkdir -p "$hookdir"
  cat > "$hook" <<EOF
#!/usr/bin/env bash
# graphify-monorepo: refresh the merged graph before push (warn-only, never blocks).
set -uo pipefail
[ "\${GRAPHIFY_MONOREPO_SKIP:-}" = "1" ] && exit 0
root="\$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [ -x "\$root/$ENGINE_NAME" ]; then
  "\$root/$ENGINE_NAME" sync || echo "graphify-monorepo: sync failed; push continues" >&2
  if [ -n "\$(git -C "\$root" status --porcelain -- graphify-out CLAUDE.md AGENTS.md .github/copilot-instructions.md 2>/dev/null)" ]; then
    echo "graphify-monorepo: graph refreshed but NOT part of this push (a pre-push hook cannot add it)." >&2
    echo "graphify-monorepo: commit the refreshed files and push again to ship a current graph." >&2
  fi
fi
exit 0
EOF
  chmod +x "$hook"
  info "wrote githooks/pre-push (warn-only)."

  # `.git` is a directory in a normal repo but a FILE in a linked worktree or submodule;
  # -e covers both, so we don't wrongly treat those as non-git and skip hook wiring.
  if [ ! -e "$ROOT/.git" ]; then
    info "no git repo at $ROOT (no .git); skipping hook wiring. Agents will refresh via the override instruction."
    return 0
  fi
  local current
  current="$(git -C "$ROOT" config --local core.hooksPath 2>/dev/null || true)"
  if [ -z "$current" ]; then
    git -C "$ROOT" config core.hooksPath githooks
    info "set core.hooksPath=githooks (pre-push active here). core.hooksPath is local git config and is NOT cloned; run './$ENGINE_NAME install-hook' in each fresh clone to activate it."
  elif [ "$current" = "githooks" ]; then
    info "core.hooksPath already githooks; pre-push active."
  else
    info "core.hooksPath is '$current' (managed elsewhere); left as-is. Add a call to '$ENGINE_NAME sync' in that pre-push to enable auto-refresh."
  fi
}

cmd_setup() {
  ROOT="$PWD"
  [ $# -ge 2 ] || die "setup needs >=2 workspace dirs: '$ENGINE_NAME setup <ws1> <ws2> [ws3...]'"
  local ws missing=0
  for ws in "$@"; do
    [ -d "$ROOT/$ws" ] || { echo "  missing workspace dir: $ws" >&2; missing=1; }
    [ -f "$ROOT/$ws/graphify-out/graph.json" ] || { echo "  no graph yet for: $ws ($ws/graphify-out/graph.json); build it first (see SKILL.md)" >&2; missing=1; }
  done
  [ "$missing" = 0 ] || die "build each workspace graph before setup (extract -> that workspace's graphify-out/graph.json)."

  # Scaffold this engine into the repo root (so the committed hook works in every
  # clone) unless it is already running from there.
  if [ "$(dirname "$SELF")" != "$ROOT" ]; then
    cp "$SELF" "$ROOT/$ENGINE_NAME"
    chmod +x "$ROOT/$ENGINE_NAME"
    info "scaffolded $ENGINE_NAME into repo root."
  fi

  local conf="$ROOT/$CONF_NAME" quoted=""
  # Serialize each name with %q so a workspace dir containing spaces or shell
  # metacharacters can't break or inject when load_config sources this file.
  for ws in "$@"; do quoted="$quoted${quoted:+ }$(printf '%q' "$ws")"; done
  cat > "$conf" <<EOF
# graphify-monorepo config. Workspaces merged into the root graphify-out/graph.json.
# Regenerate/refresh with: ./$ENGINE_NAME sync
WORKSPACES=($quoted)
# 1 = skip LLM community naming during sync (AST-only, no API cost, hook/CI-safe).
# Set 0 (or run: ./$ENGINE_NAME sync --label) to name communities.
CLUSTER_NO_LABEL=1
EOF
  info "wrote $CONF_NAME (WORKSPACES=$*)."

  cmd_install_hook
  # Build the root graph from the existing workspace graphs and write the override.
  cmd_sync
  cat <<EOF

Setup complete. Next:
  - Review and commit: $ENGINE_NAME, $CONF_NAME, githooks/pre-push, graphify-out/,
    and the "## Graphify monorepo override" block added to your instruction files.
  - After code changes, run: ./$ENGINE_NAME sync   (the pre-push hook also runs it and
    warns when the refresh needs its own commit).
  - In each fresh clone, run: ./$ENGINE_NAME install-hook   (core.hooksPath is local
    git config, so cloning copies the hook file but not its activation).
  - Keep running 'graphify <harness> install' for query guidance; the override block
    survives it and supersedes the wrong 'graphify update .' line.
EOF
}

main() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift || true
  case "$sub" in
    setup)              cmd_setup "$@" ;;
    sync)               cmd_sync "$@" ;;
    write-instructions) cmd_write_instructions ;;
    install-hook)       cmd_install_hook ;;
    ""|-h|--help|help)
      grep -E '^#( |$)' "$SELF" | sed -E 's/^# ?//' | head -40 ;;
    *) die "unknown subcommand '$sub' (setup|sync|write-instructions|install-hook)" ;;
  esac
}

main "$@"
