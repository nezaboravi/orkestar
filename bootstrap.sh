#!/bin/sh
set -eu

# One-command installer for macOS and Linux. It keeps its runtime isolated in
# the user's home and never edits shell startup files.

NODE_VERSION="v24.20.0"
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET_HOME=${HOME}
PROJECT=""
PROJECT_ONLY=0
NO_LAUNCH=0
USE_HERDR=0
STRUCTURAL_ONLY=0
CONFLICT="fail"
HARNESS="auto"

usage() {
  cat <<'EOF'
agent-orchestra bootstrap

Usage: ./bootstrap.sh [options]

Options:
  --home PATH          Override the target home (clean-room testing)
  --project PATH       Install project-local agents into PATH
  --project-only       Leave global configuration untouched (requires --project)
  --conflict POLICY    fail, skip, or backup (default: fail)
  --harness NAME       auto, codex, claude, kimi, or opencode (default: auto)
  --herdr              Open the selected CLI inside a project Herdr session
  --no-launch          Verify setup without opening the selected CLI
  --structural-only    Do not require an authenticated provider
  --help               Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) [ "$#" -ge 2 ] || { echo "ERROR: --home requires a path" >&2; exit 2; }; TARGET_HOME=$2; shift 2 ;;
    --project) [ "$#" -ge 2 ] || { echo "ERROR: --project requires a path" >&2; exit 2; }; PROJECT=$2; shift 2 ;;
    --project-only) PROJECT_ONLY=1; shift ;;
    --conflict) [ "$#" -ge 2 ] || { echo "ERROR: --conflict requires a policy" >&2; exit 2; }; CONFLICT=$2; shift 2 ;;
    --harness) [ "$#" -ge 2 ] || { echo "ERROR: --harness requires a name" >&2; exit 2; }; HARNESS=$2; shift 2 ;;
    --herdr) USE_HERDR=1; shift ;;
    --no-launch) NO_LAUNCH=1; shift ;;
    --structural-only) STRUCTURAL_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$CONFLICT" in fail|skip|backup) ;; *) echo "ERROR: --conflict must be fail, skip, or backup" >&2; exit 2 ;; esac
case "$HARNESS" in auto|codex|claude|kimi|opencode) ;; *) echo "ERROR: --harness must be auto, codex, claude, kimi, or opencode" >&2; exit 2 ;; esac
[ "$PROJECT_ONLY" -eq 0 ] || [ -n "$PROJECT" ] || { echo "ERROR: --project-only requires --project" >&2; exit 2; }

case "$TARGET_HOME" in /*) ;; *) TARGET_HOME="$(pwd)/$TARGET_HOME" ;; esac
if [ -n "$PROJECT" ]; then
  case "$PROJECT" in /*) ;; *) PROJECT="$(pwd)/$PROJECT" ;; esac
  [ -d "$PROJECT" ] || { echo "ERROR: project directory does not exist: $PROJECT" >&2; exit 1; }
fi

RUNTIME_DIR="$TARGET_HOME/.local/share/agent-orchestra"
BIN_DIR="$RUNTIME_DIR/bin"
NPM_PREFIX="$RUNTIME_DIR/npm"
mkdir -p "$BIN_DIR" "$NPM_PREFIX"
PATH="$BIN_DIR:$NPM_PREFIX/bin:$TARGET_HOME/.opencode/bin:$TARGET_HOME/.local/bin:$PATH"
export PATH HOME="$TARGET_HOME" USERPROFILE="$TARGET_HOME"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

install_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    major=$(node -p 'Number(process.versions.node.split(".")[0])')
    [ "$major" -ge 20 ] && return 0
  fi

  need curl
  need tar
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in Darwin) platform="darwin" ;; Linux) platform="linux" ;; *) fail "supported systems are macOS and Linux; use bootstrap.ps1 on Windows" ;; esac
  case "$arch" in arm64|aarch64) architecture="arm64" ;; x86_64|amd64) architecture="x64" ;; *) fail "unsupported architecture: $arch" ;; esac

  archive="node-${NODE_VERSION}-${platform}-${architecture}.tar.gz"
  node_dir="$RUNTIME_DIR/node-${NODE_VERSION}-${platform}-${architecture}"
  if [ ! -x "$node_dir/bin/node" ]; then
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT HUP INT TERM
    base="https://nodejs.org/dist/${NODE_VERSION}"
    step "Installing isolated Node.js ${NODE_VERSION}"
    curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"
    curl -fsSL --retry 3 "$base/$archive" -o "$temporary/$archive"
    expected=$(awk -v file="$archive" '$2 == file { print $1; exit }' "$temporary/SHASUMS256.txt")
    [ -n "$expected" ] || fail "Node.js checksum is missing for $archive"
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/$archive" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$temporary/$archive" | awk '{print $1}')
    elif command -v openssl >/dev/null 2>&1; then actual=$(openssl dgst -sha256 "$temporary/$archive" | awk '{print $NF}')
    else fail "SHA-256 verification requires sha256sum, shasum, or openssl"
    fi
    [ "$actual" = "$expected" ] || fail "Node.js checksum did not match"
    mkdir -p "$node_dir"
    tar -xzf "$temporary/$archive" -C "$node_dir" --strip-components=1
    rm -rf "$temporary"
    trap - EXIT HUP INT TERM
  fi
  PATH="$node_dir/bin:$PATH"
  export PATH
}

install_herdr() {
  command -v herdr >/dev/null 2>&1 && return 0
  need curl
  step "Installing Herdr into the isolated runtime"
  curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR="$BIN_DIR" sh
  command -v herdr >/dev/null 2>&1 || fail "Herdr installation did not produce an executable"
}

install_opencode() {
  command -v opencode >/dev/null 2>&1 && return 0
  step "Installing OpenCode into the isolated runtime"
  npm install --global --prefix "$NPM_PREFIX" opencode-ai
  command -v opencode >/dev/null 2>&1 || fail "OpenCode installation did not produce an executable"
}

install_codex() {
  command -v codex >/dev/null 2>&1 && return 0
  need curl
  step "Installing Codex into the isolated runtime"
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
  command -v codex >/dev/null 2>&1 || fail "Codex installation did not produce an executable"
}

codex_authenticated() {
  command -v codex >/dev/null 2>&1 && codex login status >/dev/null 2>&1
}

claude_authenticated() {
  command -v claude >/dev/null 2>&1 && claude auth status 2>/dev/null | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true'
}

install_lenka() {
  package_cache="$RUNTIME_DIR/packages"
  local_prefix="$TARGET_HOME/.local"
  mkdir -p "$package_cache"
  package_name=$(npm pack --silent --pack-destination "$package_cache" "$REPO_DIR")
  package_path="$package_cache/$package_name"
  [ -f "$package_path" ] || fail "npm did not create the Lenka package archive"
  npm install --global --prefix "$local_prefix" "$package_path"
  installed_root=$(npm root --global --prefix "$local_prefix")/agent-orchestra
  [ -d "$installed_root" ] || fail "Lenka package was not installed"
  [ ! -L "$installed_root" ] || fail "Lenka installation must be a standalone package, not a repository symlink"
  "$local_prefix/bin/lenka" --help >/dev/null
  printf 'Lenka command: %s\n' "$local_prefix/bin/lenka"
}

step "Preparing portable runtime"
install_node
if [ "$USE_HERDR" -eq 1 ]; then install_herdr; fi
if [ "${LENKA_CLI_ACTIVE:-0}" != "1" ] && [ -d "$REPO_DIR/.git" ]; then
  step "Installing the Lenka command"
  install_lenka
fi

case "$HARNESS" in
  codex) install_codex ;;
  claude) command -v claude >/dev/null 2>&1 || fail "Claude Code is not installed; install it or choose another harness" ;;
  kimi) command -v kimi >/dev/null 2>&1 || fail "Kimi Code CLI is not installed; install it or choose another harness" ;;
  opencode) install_opencode ;;
  auto)
    if ! command -v codex >/dev/null 2>&1 && ! command -v claude >/dev/null 2>&1 && ! command -v kimi >/dev/null 2>&1 && ! command -v opencode >/dev/null 2>&1; then
      install_codex
    fi
    ;;
esac

step "Detected tools"
node --version
if [ "$USE_HERDR" -eq 1 ]; then herdr --version; fi

if [ "$HARNESS" = "auto" ]; then CANDIDATES="codex claude kimi opencode"; else CANDIDATES="$HARNESS"; fi
SELECTED_HARNESS=""
for candidate in $CANDIDATES; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  if [ "$candidate" = "codex" ] && ! codex_authenticated && [ "$STRUCTURAL_ONLY" -eq 0 ]; then continue; fi
  if [ "$candidate" = "claude" ] && ! claude_authenticated && [ "$STRUCTURAL_ONLY" -eq 0 ]; then continue; fi

  step "Trying the $candidate harness"
  set -- install --home "$TARGET_HOME" --conflict "$CONFLICT" --tool "$candidate"
  if [ -n "$PROJECT" ]; then set -- "$@" --project "$PROJECT"; fi
  if [ "$PROJECT_ONLY" -eq 1 ]; then set -- "$@" --project-only; fi
  if [ "$STRUCTURAL_ONLY" -eq 1 ]; then set -- "$@" --structural; fi
  if node "$REPO_DIR/orchestra.mjs" "$@"; then
    SELECTED_HARNESS="$candidate"
    break
  fi
  [ "$HARNESS" = "auto" ] || fail "$candidate is installed but has no executable model route"
  printf 'WARN: %s was not executable; trying the next configured harness.\n' "$candidate" >&2
done

if [ -z "$SELECTED_HARNESS" ]; then
  fail "no authenticated harness worked; sign in to Codex, Claude Code, Kimi Code, or an OpenCode provider, then run bootstrap again"
fi

"$SELECTED_HARNESS" --version
printf 'Harness: %s\n' "$SELECTED_HARNESS"

if [ "$STRUCTURAL_ONLY" -eq 1 ]; then
  step "Verifying the installed team structurally"
  set -- doctor --home "$TARGET_HOME" --installed --structural --tool "$SELECTED_HARNESS"
else
  step "Verifying the installed team with authenticated model routes"
  set -- doctor --home "$TARGET_HOME" --installed --tool "$SELECTED_HARNESS"
fi
if [ -n "$PROJECT" ]; then set -- "$@" --project "$PROJECT"; fi
if [ "$PROJECT_ONLY" -eq 1 ]; then set -- "$@" --project-only; fi
node "$REPO_DIR/orchestra.mjs" "$@"

printf '\nREADY: agent-orchestra is installed and verified.\n'
if [ "$NO_LAUNCH" -eq 1 ]; then exit 0; fi

launch_dir=${PROJECT:-$REPO_DIR}
if [ -n "$PROJECT" ]; then
  runtime_manifest="$PROJECT/.agent-orchestra/runtime/$SELECTED_HARNESS.json"
else
  runtime_manifest="$TARGET_HOME/.agent-orchestra/runtime/$SELECTED_HARNESS.json"
fi
[ -f "$runtime_manifest" ] || fail "$SELECTED_HARNESS runtime manifest is missing: $runtime_manifest"
primary_model=$(node -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(manifest.primary?.model || "");' "$runtime_manifest")
reasoning_effort=$(node -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(manifest.primary?.reasoningEffort || "");' "$runtime_manifest")
[ -n "$primary_model" ] || fail "No verified $SELECTED_HARNESS coordination model was recorded for Lenka"
printf 'Conductor model: %s\n' "$primary_model"
if [ -n "$reasoning_effort" ]; then printf 'Reasoning effort: %s\n' "$reasoning_effort"; fi
cd "$launch_dir"
harness_binary=$(command -v "$SELECTED_HARNESS")
export AGENT_ORCHESTRA_HARNESS="$SELECTED_HARNESS"
export AGENT_ORCHESTRA_HARNESS_BINARY="$harness_binary"
export AGENT_ORCHESTRA_PRIMARY_MODEL="$primary_model"
export AGENT_ORCHESTRA_REASONING_EFFORT="$reasoning_effort"
if [ "$USE_HERDR" -eq 1 ]; then
  session_name=$(node "$REPO_DIR/session-name.mjs" "$launch_dir")
  printf 'Herdr session: %s\n' "$session_name"
  step "Opening the selected CLI inside the project Herdr session"
  herdr_config="$RUNTIME_DIR/herdr.toml"
  node -e 'const fs = require("node:fs"); const [file, shell] = process.argv.slice(1); fs.writeFileSync(file, `[terminal]\ndefault_shell = ${JSON.stringify(shell)}\nshell_mode = "non_login"\nnew_cwd = "current"\n`);' "$herdr_config" "$REPO_DIR/harness-launcher.mjs"
  export HERDR_CONFIG_PATH="$herdr_config"
  exec herdr --session "$session_name"
fi
step "Opening Lenka directly in $SELECTED_HARNESS"
exec node "$REPO_DIR/harness-launcher.mjs"
