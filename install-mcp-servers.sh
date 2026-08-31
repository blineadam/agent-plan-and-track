#!/usr/bin/env bash
# Install the chrome-devtools MCP server (github.com/ChromeDevTools/chrome-devtools-mcp)
# for whichever of Claude Code, Codex, and GitHub Copilot are present on this
# machine, skipping any harness that already has a server by that name, or
# remove it again.
#
# Usage: ./install-mcp-servers.sh [install|uninstall]
#
# The verb defaults to install when omitted, and more than one argument is
# still an error, same shape as install-office-skills.sh.
#
# Separate from install.sh: this script drives each harness through its own
# CLI (`mcp add`/`mcp get`/`mcp remove`), which install.sh's shared JSON/TOML
# merge machinery has no need to know about. Exact install-office-skills.sh
# precedent (a third-party integration kept out of the shared installer).
#
# Detection is command -v <cli> for all three harnesses. That matches
# install-office-skills.sh for Claude Code and Codex but diverges for
# Copilot, which that script detects by [ -d "$HOME/.copilot" ]. The
# divergence is deliberate, not a copy error: this script drives every
# harness through its own CLI rather than writing files directly, so a
# harness whose CLI isn't on PATH is unusable here regardless of whether its
# config directory exists.
#
# Every harness CLI call is made from a fresh empty temporary directory that
# is removed on exit, because Claude Code and GitHub
# Copilot both resolve project-scoped MCP config relative to the working
# directory and neither exposes a scope flag on `mcp get`. Run from a repo
# carrying a .mcp.json that declares this server and an unscoped presence
# check would report it already configured, silently skipping the user-scope
# install this script exists to perform, and `mcp remove -s user` would then
# fail on a server that was never in user scope. Codex is unaffected (its
# MCP config is ~/.codex/config.toml only), but the cd covers all three so
# the script behaves the same wherever it is invoked from. $HOME is not a
# safe choice here: a user who has run an agent from their home directory can
# have a ~/.mcp.json, which would shadow the user-scope entry exactly the way
# a repository's does. A directory this script just created cannot.
#
# Uninstall also gates each harness on the same command -v detection, rather
# than sweeping known destinations unconditionally the way
# install-office-skills.sh's uninstall path does. This is a second deliberate
# divergence: removal here goes through the harness's own `mcp remove`
# subcommand, not direct file deletion, so there is no orphaned-directory
# case to sweep the way there is for the office skills (whose uninstall
# deletes on-disk skill directories directly).
#
# This script never runs npx itself; the add commands below hand
# `npx -y chrome-devtools-mcp@latest` to the harness as the command it should
# launch its MCP server with, and npx only actually runs later, when that
# harness starts the server over piped stdio. The install path still gates on
# npx existing, because a config naming a command the machine does not have
# is an unusable server that fails at first use with the harness's own error
# rather than this script's. Uninstall does not gate: making a cleanup depend
# on a toolchain it never uses would strand anyone whose Node install is
# gone. Node is not implied by a harness being present, since not every
# harness CLI is itself a Node program.
#
# All three harnesses' add commands pass -y to npx, even though upstream
# documents -y only for Copilot: a harness launches an MCP server over piped
# stdio, and npx's first-run "ok to install?" prompt has nowhere to go on
# that channel, so without -y a harness starting the server for the first
# time on a machine without the package cached would hang instead of
# launching. -y is a no-op once the package is already cached.
#
# The package pin is @latest, not a fixed version, which otherwise goes
# against this repo's pin-external-tools convention (see
# install-office-skills.sh's SKILLS_CLI). That convention governs a tool this
# script itself shells out to; this string is config data handed to the
# harness to run later, not a tool this script runs, so the convention
# doesn't apply here the same way. @latest also matches what upstream
# documents and what this repo's owner already has installed on all three
# harnesses.
#
# Requires each harness's own CLI (claude, codex, copilot) already on PATH,
# Node.js LTS, and a current-stable-or-newer Chrome install (all three
# required by chrome-devtools-mcp itself, not by this script). This script
# never hand-edits ~/.claude.json, ~/.codex/config.toml, or
# ~/.copilot/mcp-config.json; each harness's own CLI is the only writer of
# its own config.
#
# PARITY: this script and install-mcp-servers.ps1 must stay in lockstep, with
# one deliberate behavioral divergence. The .ps1 registers Codex with the
# Windows form the upstream README documents in its Windows 11 section
# (launching npx through cmd, with SystemRoot and PROGRAMFILES in the server's
# environment). That guidance is Windows-only and Codex-only, so it has no
# counterpart here and its absence is not drift.
set -euo pipefail

MCP_NAME="chrome-devtools"
MCP_PACKAGE="chrome-devtools-mcp@latest"

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

if [ "$verb" = install ]; then
  command -v npx >/dev/null 2>&1 \
    || { echo "error: npx is required (install Node.js); every harness launches this server through npx" >&2; exit 1; }
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cd "$workdir" || { echo "error: cannot enter the temporary working directory ($workdir)" >&2; exit 1; }

have_claude=false have_codex=false have_copilot=false
command -v claude >/dev/null 2>&1 && have_claude=true
command -v codex >/dev/null 2>&1 && have_codex=true
command -v copilot >/dev/null 2>&1 && have_copilot=true

if ! $have_claude && ! $have_codex && ! $have_copilot; then
  echo "No Claude Code, Codex, or Copilot installation detected; nothing to do." >&2
  exit 0
fi

mcp_present() {
  "$1" mcp get "$MCP_NAME" >/dev/null 2>&1
}

add_for() {
  case "$1" in
    claude)  claude mcp add "$MCP_NAME" --scope user -- npx -y "$MCP_PACKAGE" >/dev/null ;;
    codex)   codex mcp add "$MCP_NAME" -- npx -y "$MCP_PACKAGE" >/dev/null ;;
    copilot) copilot mcp add "$MCP_NAME" -- npx -y "$MCP_PACKAGE" >/dev/null ;;
  esac
}

remove_for() {
  case "$1" in
    claude)  claude mcp remove "$MCP_NAME" -s user >/dev/null ;;
    codex)   codex mcp remove "$MCP_NAME" >/dev/null ;;
    copilot) copilot mcp remove "$MCP_NAME" >/dev/null ;;
  esac
}

report() {
  printf "  %-11s -- %s\n" "$1" "$2"
}

dispatch() {
  local cli="$1" label="$2" detected="$3"

  if ! $detected; then
    report "$label" "not detected, skipped"
    return
  fi

  if [ "$verb" = install ]; then
    if mcp_present "$cli"; then
      report "$label" "already configured, skipped"
    else
      add_for "$cli"
      report "$label" "added"
    fi
  else
    if mcp_present "$cli"; then
      remove_for "$cli"
      report "$label" "removed"
    else
      report "$label" "not configured, skipped"
    fi
  fi
}

dispatch claude "Claude Code" "$have_claude"
dispatch codex "Codex" "$have_codex"
dispatch copilot "Copilot" "$have_copilot"

echo "done."
