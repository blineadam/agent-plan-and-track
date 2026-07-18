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
# third-party `skills` npm CLI (vercel-labs/skills) to clone them straight
# from Anthropic's own repo at install time, so nothing restricted is ever
# stored here. Requires network access and npx (Node/npm).
#
# Each harness is detected independently, and the shared fetch step runs
# whenever at least one is detected, regardless of which: `--agent codex` in
# the fetch below is only a directory-routing label the fetch tool uses (it
# writes to .agents/skills/ relative to cwd), not a dependency on the codex
# CLI actually being installed.
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

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

skill_args=()
for s in "${SKILLS[@]}"; do skill_args+=(--skill "$s"); done

(cd "$scratch" && npx --yes "$SKILLS_CLI" add "$SOURCE_REPO" "${skill_args[@]}" --agent codex --copy -y)

fetched="$scratch/.agents/skills"
[ -d "$fetched" ] || { echo "error: fetch did not produce $fetched" >&2; exit 1; }

install_into() {
  local dest="$1" label="$2" s names=""
  mkdir -p "$dest"
  for s in "${SKILLS[@]}"; do
    cp -R "$fetched/$s" "$dest/"
    names="$names${names:+,}$s"
  done
  echo "  $label -> $dest/{$names}"
}

$have_claude  && install_into "$HOME/.claude/skills" "claude Code"
$have_claude  || echo "  Claude Code -- not detected, skipped"
$have_codex   && install_into "$HOME/.agents/skills" "codex      "
$have_codex   || echo "  Codex       -- not detected, skipped"
$have_copilot && install_into "$HOME/.copilot/skills" "copilot    "
$have_copilot || echo "  Copilot     -- not detected, skipped"

echo "done."
