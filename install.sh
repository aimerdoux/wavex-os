#!/usr/bin/env bash
# wavex-os one-liner installer for macOS + Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aimerdoux/wavex-os/main/install.sh | bash
#
# What it does:
#   1. Checks Node 20+, pnpm 8+, git, and the `claude` CLI
#      (@anthropic-ai/claude-code — required for BYOC inference).
#      Installs anything missing via Homebrew (macOS) or apt
#      (Debian/Ubuntu) + npm. On other distros, prints the missing
#      command and exits 1.
#   2. Clones the repo into $HOME/wavex-os (or $WAVEX_OS_DIR).
#   3. Runs `pnpm install`.
#   4. Starts `pnpm dev` and opens http://localhost:5173 in the default browser.
#
# Env overrides:
#   WAVEX_OS_DIR             — where to clone (default: $HOME/wavex-os)
#   ANTHROPIC_API_KEY        — Pool A inference key (optional; falls back to T1 stubs)
#   WAVEX_INFERENCE_MODE     — "apikey" if ANTHROPIC_API_KEY is set, else unset
#   WAVEX_SKIP_CLAUDE_CLI=1  — bypass the `claude` CLI install (you manage it elsewhere)
set -euo pipefail

WAVEX_OS_DIR="${WAVEX_OS_DIR:-$HOME/wavex-os}"
REPO_URL="${REPO_URL:-https://github.com/aimerdoux/wavex-os.git}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$1" >&2; exit 1; }

bold "wavex-os installer"

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  INSTALL_NODE="brew install node@20"
  INSTALL_PNPM="brew install pnpm"
  INSTALL_GIT="brew install git"
  PKG_MANAGER="brew"
elif [ "$OS" = "Linux" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    INSTALL_NODE="curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    INSTALL_PNPM="npm install -g pnpm@8"
    INSTALL_GIT="sudo apt-get install -y git"
    PKG_MANAGER="apt"
  else
    PKG_MANAGER="manual"
  fi
else
  die "Unsupported OS: $OS. Try the manual install at https://github.com/aimerdoux/wavex-os"
fi

# Claude CLI install is global via npm (works on macOS + Linux uniformly).
# We avoid forcing a specific shell-based installer because wavex-os runs in
# BYOC mode — every customer needs a working `claude` binary for the local
# tier-router to drive inference. Without it, the dev server boots but T2
# inference paths halt; nothing else in the stack can fall back for us.
INSTALL_CLAUDE_CLI="npm install -g @anthropic-ai/claude-code"

bold "[1/4] Checking prereqs"
need_install=()
command -v git  >/dev/null 2>&1 && ok "git installed"  || need_install+=("git")
command -v node >/dev/null 2>&1 && {
  node_major="$(node --version | sed 's/v//;s/\..*//')"
  if [ "$node_major" -ge 20 ]; then ok "node $(node --version)"
  else warn "node $(node --version) is too old; need v20+"; need_install+=("node"); fi
} || need_install+=("node")
command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm --version)" || need_install+=("pnpm")
# Claude CLI (@anthropic-ai/claude-code). BYOC requires it — the tier-router's
# T2 calls spawn this binary. Treat it as a hard prereq, but allow the user
# to skip auto-install via WAVEX_SKIP_CLAUDE_CLI=1 if they have it managed
# by a system package or version manager.
command -v claude >/dev/null 2>&1 && ok "claude $(claude --version 2>/dev/null | head -1 || echo 'installed')" || {
  if [ "${WAVEX_SKIP_CLAUDE_CLI:-0}" = "1" ]; then
    warn "claude CLI not found, WAVEX_SKIP_CLAUDE_CLI=1 — skipping (BYOC won't work until you install it)"
  else
    need_install+=("claude")
  fi
}

if [ "${#need_install[@]}" -gt 0 ]; then
  bold "[2/4] Installing missing tools: ${need_install[*]}"
  if [ "$PKG_MANAGER" = "brew" ] && ! command -v brew >/dev/null 2>&1; then
    note "Installing Homebrew first…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  for tool in "${need_install[@]}"; do
    case "$tool" in
      git)    eval "$INSTALL_GIT"  ;;
      node)   eval "$INSTALL_NODE" ;;
      pnpm)   eval "$INSTALL_PNPM" ;;
      claude) eval "$INSTALL_CLAUDE_CLI" \
                && note "After install: run 'claude login' once to authorize your Claude Max account." ;;
    esac
  done
  ok "tools installed"
else
  bold "[2/4] All prereqs already present"
fi

bold "[3/4] Cloning + installing"
if [ -d "$WAVEX_OS_DIR" ]; then
  note "$WAVEX_OS_DIR exists — pulling latest"
  cd "$WAVEX_OS_DIR"
  git pull --ff-only
else
  git clone "$REPO_URL" "$WAVEX_OS_DIR"
  cd "$WAVEX_OS_DIR"
fi
ok "cloned to $WAVEX_OS_DIR"

note "pnpm install (this can take 3–8 min on first run)…"
pnpm install
ok "deps installed"

note "building vendored wavex-os plugins (~30 s)…"
pnpm -r --filter "./vendor/wavex-os/*" build
ok "vendored plugins built"

# Compile @wavex-os/cloud-client (+ its @wavex-os/auth-shim dep) so the
# `wavex-os` bin has a runnable dist/cli.js. `pnpm install` already runs
# each package's `prepare` script, but we do this explicitly so the bin
# is guaranteed usable even if install ran with --ignore-scripts.
note "building wavex-os CLI…"
pnpm --filter @wavex-os/auth-shim --filter @wavex-os/cloud-client build
ok "wavex-os CLI built"

bold "[4/4] Configuring inference + starting dev server"

# Default: route Pool A (wizard's T2 enrichment) through the WaveX-hosted
# inference hub. Customers don't need their own Claude Max — the operator's
# subscription serves their onboarding inference under a session token.
# Override by editing ~/.wavex-os/inference.env or exporting env vars.
HUB_URL="${WAVEX_INFERENCE_HUB_URL:-https://catalogue-sea-such-manchester.trycloudflare.com}"
INFERENCE_ENV="$HOME/.wavex-os/inference.env"
mkdir -p "$(dirname "$INFERENCE_ENV")"
if [ ! -f "$INFERENCE_ENV" ]; then
  cat > "$INFERENCE_ENV" <<EOF
# wavex-os Pool A inference config (written by install.sh).
# Edit to change hub URL or switch to local-OAuth/api-key mode.
WAVEX_INFERENCE_MODE=hosted
WAVEX_INFERENCE_HUB_URL=$HUB_URL
EOF
  chmod 600 "$INFERENCE_ENV"
  ok "wrote $INFERENCE_ENV (hosted mode, hub=$HUB_URL)"
else
  ok "$INFERENCE_ENV already present — keeping existing config"
fi

# Put the `wavex-os` command on PATH so `wavex-os login` (device pairing
# with the cloud console) and the installer subcommands work from any
# shell. The bin lives in the @wavex-os/cloud-client package; we symlink
# it into a user-writable bin dir rather than touching system paths.
WAVEX_BIN_SRC="$WAVEX_OS_DIR/packages/cloud-client/bin/wavex-os.mjs"
if [ -f "$WAVEX_BIN_SRC" ]; then
  chmod +x "$WAVEX_BIN_SRC" 2>/dev/null || true
  LINK_DIR=""
  for cand in "$HOME/.local/bin" "/usr/local/bin"; do
    if [ -d "$cand" ] && [ -w "$cand" ]; then LINK_DIR="$cand"; break; fi
  done
  if [ -z "$LINK_DIR" ]; then
    LINK_DIR="$HOME/.local/bin"
    mkdir -p "$LINK_DIR"
  fi
  ln -sf "$WAVEX_BIN_SRC" "$LINK_DIR/wavex-os"
  ok "linked wavex-os → $LINK_DIR/wavex-os"
  case ":$PATH:" in
    *":$LINK_DIR:"*) : ;;
    *)
      warn "$LINK_DIR is not on your PATH."
      warn "Add it:  echo 'export PATH=\"$LINK_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
      warn "Until then, run the command as: $LINK_DIR/wavex-os login"
      ;;
  esac
  note "Pair this machine with the console:  wavex-os login"
else
  warn "wavex-os bin not found at $WAVEX_BIN_SRC — skipping PATH link"
fi

note "Vite UI on http://localhost:5173"
note "mock-core API on http://localhost:3101"
note ""
note "Press Ctrl+C to stop. Re-run with: cd $WAVEX_OS_DIR && pnpm dev"
note ""
note "Next steps:"
note "  1. claude login            ← authorize your Claude Max plan (BYOC inference)"
note "  2. wavex-os login          ← pair this machine with the console"
note ""
note "If you skipped the claude CLI install above, T2 inference will halt"
note "until you run:  npm install -g @anthropic-ai/claude-code && claude login"
note ""

# Open browser in background once Vite is up
(
  for _ in $(seq 1 60); do
    if curl -sf --max-time 1 http://localhost:5173 >/dev/null 2>&1; then
      if   command -v open    >/dev/null 2>&1; then open    http://localhost:5173
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:5173
      fi
      exit 0
    fi
    sleep 1
  done
) &

exec pnpm dev
