#!/usr/bin/env bash
# Fetch the docx/pdf/pptx/xlsx skills live from anthropics/skills and install
# them for whichever of Claude Code, Codex, and GitHub Copilot are present on
# this machine, or remove them again.
#
# Usage: ./install-office-skills.sh [install|uninstall]
#
# The verb defaults to install when omitted: README.md, AGENTS.md, and the
# CI install workflow all invoke this script with no arguments and must keep
# working, so a missing arg is not an error here the way it is in install.sh
# (which requires exactly one arg). More than one argument is still an
# error. This is a deliberate divergence from install.sh's usage() shape,
# made only for the zero-arg default.
#
# Separate from install.sh: these 4 skills carry an upstream LICENSE.txt that
# forbids redistribution outside Anthropic's own Services, so this repo never
# vendors them under skills/. Instead this script shells out to the
# third-party `skills` npm CLI (vercel-labs/skills) to install them straight
# from Anthropic's own repo at install time, so nothing restricted is ever
# stored here. That fetch needs network access and npx (Node/npm); uninstall
# needs neither, since it only deletes directories already on disk. The
# npx-existence and Node-minimum-version gates below therefore run only on
# the install path: making a cleanup depend on a toolchain it never uses
# would strand anyone whose Node install is gone, broken, or never present.
#
# Each detected harness gets its own `skills add --agent <id> -g` global
# install, rather than a single shared fetch copied by hand into each
# destination. Codex and GitHub Copilot both resolve to the same shared
# ~/.agents/skills directory: GitHub's own docs for Copilot CLI agent skills
# (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
# list ~/.agents/skills as an officially supported personal-skills location
# alongside ~/.copilot/skills, and the `skills` CLI's own agent registry
# treats any agent whose skills directory is ".agents/skills" as sharing that
# one canonical global path. When both are present the two installs write the
# same files there, which is harmless. Re-running is also safe: the CLI wipes
# and re-fetches each skill's own directory on every install (`--copy` is not
# a diff/merge), so a re-run does real work but always converges on the same
# content, not a no-op in the sense of touching nothing. A user's own local
# edits to a copy-installed skill are lost the same way on the next install;
# that is by design, not a bug to fix here.
#
# Uninstall deletes the four SKILLS names as direct children of the three
# known destinations (~/.claude/skills, ~/.agents/skills, ~/.copilot/skills),
# sweeping all three unconditionally rather than gating on which harness is
# currently detected: gating on harness detection would strand orphaned
# skill directories on a machine whose harness has already been removed.
# Deletion is name-based, so it cannot tell an orphaned copy of one of these
# four skills apart from a same-named skill a user hand-authored themselves;
# that is an accepted limitation of a name-only uninstall, not a bug.
# Uninstall never reads, writes, or deletes .plan-and-track-manifest or
# .plan-and-track-pruned in any destination. Those belong to install.sh and
# record a different, much larger set of skills this script never touches.
# Uninstall also leaves ~/.agents/.skill-lock.json alone on purpose. That
# lock belongs to the pinned third-party `skills` CLI, which tracks it one
# skill name at a time and never reconciles an entry against what is on
# disk: `addSkillToLock` upserts an entry, `removeSkillFromLock` deletes
# one, and nothing prunes (read in its dist/cli.mjs at skills@1.5.19). So
# these four entries persist until the same skills are installed again,
# which rewrites them. Hand-editing another tool's state file is worse than
# leaving an entry that names a directory no longer there. Recheck this
# when SKILLS_CLI moves.
#
# PARITY: this script and install-office-skills.ps1 must stay in lockstep.
set -euo pipefail

SOURCE_REPO="https://github.com/anthropics/skills"
SKILLS=(docx pdf pptx xlsx)
# Pinned, reviewed version of the third-party fetch tool (vercel-labs/skills),
# which itself declares a Node >=22.20.0 engine requirement.
SKILLS_CLI="skills@1.5.19"
SKILLS_CLI_MIN_NODE="22.20.0"

usage() {
  echo "Usage: $0 [install|uninstall]" >&2
  exit 1
}

[ $# -le 1 ] || usage
verb="${1:-install}"
case "$verb" in
  install|uninstall) ;;
  *)                  usage ;;
esac

if [ "$verb" = uninstall ]; then
  DESTS=(
    "$HOME/.claude/skills"
    "$HOME/.agents/skills"
    "$HOME/.copilot/skills"
  )
  for dest in "${DESTS[@]}"; do
    [ -d "$dest" ] || continue
    removed=()
    for s in "${SKILLS[@]}"; do
      target="$dest/$s"
      if [ -e "$target" ] || [ -L "$target" ]; then
        rm -rf "$target"
        removed+=("$s")
      fi
    done
    if [ "${#removed[@]}" -gt 0 ]; then
      echo "$dest:"
      for s in "${removed[@]}"; do echo "  removed $s"; done
    else
      echo "  $dest -- nothing to remove"
    fi
  done
  echo "done."
  exit 0
fi

command -v npx >/dev/null 2>&1 || { echo "error: npx is required (install Node.js)" >&2; exit 1; }
node -e '
  const [have, want] = process.argv.slice(1).map(v => v.split(".").map(Number));
  let ok = true;
  for (let i = 0; i < 3; i++) {
    if (have[i] > want[i]) break;
    if (have[i] < want[i]) { ok = false; break; }
  }
  process.exit(ok ? 0 : 1);
' "$(node --version | sed 's/^v//')" "$SKILLS_CLI_MIN_NODE" \
  || { echo "error: $SKILLS_CLI requires Node >=$SKILLS_CLI_MIN_NODE (found $(node --version))" >&2; exit 1; }

have_claude=false have_codex=false have_copilot=false
command -v claude >/dev/null 2>&1 && have_claude=true
command -v codex >/dev/null 2>&1 && have_codex=true
[ -d "$HOME/.copilot" ] && have_copilot=true

if ! $have_claude && ! $have_codex && ! $have_copilot; then
  echo "No Claude Code, Codex, or Copilot installation detected; nothing to do." >&2
  exit 0
fi

skill_args=()
for s in "${SKILLS[@]}"; do skill_args+=(--skill "$s"); done

install_for() {
  local agent="$1"
  npx --yes "$SKILLS_CLI" add "$SOURCE_REPO" "${skill_args[@]}" --agent "$agent" -g --copy -y
}

if $have_claude; then
  echo "Claude Code:"
  install_for claude-code
else
  echo "  Claude Code -- not detected, skipped"
fi
if $have_codex; then
  echo "Codex:"
  install_for codex
else
  echo "  Codex       -- not detected, skipped"
fi
if $have_copilot; then
  echo "Copilot:"
  install_for github-copilot
else
  echo "  Copilot     -- not detected, skipped"
fi

echo "done."
