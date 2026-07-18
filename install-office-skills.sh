#!/usr/bin/env bash
# Fetch the docx/pdf/pptx/xlsx skills live from anthropics/skills and install
# them for whichever of Claude Code, Codex, and GitHub Copilot are present on
# this machine.
#
# Usage: ./install-office-skills.sh
#
# Separate from install.sh: these 4 skills carry an upstream LICENSE.txt that
# forbids redistribution outside Anthropic's own Services, so this repo never
# vendors them under skills/. Instead this script shells out to the
# third-party `skills` npm CLI (vercel-labs/skills) to install them straight
# from Anthropic's own repo at install time, so nothing restricted is ever
# stored here. Requires network access and npx (Node/npm).
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
# same files there, which is harmless; re-running either install is also a
# harmless no-op.
set -euo pipefail

SOURCE_REPO="https://github.com/anthropics/skills"
SKILLS=(docx pdf pptx xlsx)
# Pinned, reviewed version of the third-party fetch tool (vercel-labs/skills),
# which itself declares a Node >=22.20.0 engine requirement.
SKILLS_CLI="skills@1.5.19"
SKILLS_CLI_MIN_NODE="22.20.0"

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
