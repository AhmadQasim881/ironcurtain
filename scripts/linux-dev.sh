#!/usr/bin/env bash
#
# Launch a Linux development container for testing IronCurtain.
#
# Uses Docker-in-Docker (DinD) so that IronCurtain's Linux code path
# (UDS bind mounts, --network=none) works correctly. The outer macOS
# Docker socket is NOT forwarded — the container runs its own dockerd.
#
# Expects a separate Linux-dedicated clone of the repo to avoid native
# module conflicts between macOS and Linux:
#
#   git clone git@github.com:provos/ironcurtain ~/src/ironcurtain-linux
#
# Usage:
#   ./scripts/linux-dev.sh              # interactive shell
#   ./scripts/linux-dev.sh --rebuild    # rebuild the image, then shell
#   ./scripts/linux-dev.sh npm test     # run a command and exit
#
# Override the clone location:
#   LINUX_PROJECT_DIR=~/src/ic-linux ./scripts/linux-dev.sh
#
# API keys: the credentials IronCurtain reads (CREDENTIAL_VARS) are forwarded
# into the container as environment variables, taken from your shell
# environment or, failing that, from the trusted env files the CLI itself
# reads: $IRONCURTAIN_ENV_FILE, then ~/.ironcurtain/.env ($IRONCURTAIN_HOME/.env).
# Like the CLI, the script never reads a .env in the repository.
#
# Node.js: the image must provide a Node.js major that package.json
# "engines" allows (SUPPORTED_NODE_MAJORS). The image build fails on any
# other, and an existing image with an unsupported Node.js (one built before
# this check, with Node 22) is rebuilt automatically. The container then
# rebuilds the clone's native modules (isolated-vm, node-pty) when they do not
# load with the image's Node.js.
#

set -euo pipefail

IMAGE_NAME="ironcurtain-linux-dev"
CONTAINER_NAME="ironcurtain-dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LINUX_PROJECT_DIR="${LINUX_PROJECT_DIR:-$HOME/src/ironcurtain-linux}"
REPO_URL="git@github.com:provos/ironcurtain.git"

# Node.js majors package.json "engines" allows (^24.0.0 || ^26.0.0).
# test/dev-environment.test.ts keeps this list in sync with package.json.
SUPPORTED_NODE_MAJORS="24 26"

# Credentials IronCurtain loads (src/config/trusted-env.ts): the provider API
# keys and the `-e` pass-through names of the bundled mcp-servers.json.
CREDENTIAL_VARS=(
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  GOOGLE_GENERATIVE_AI_API_KEY
  OPENROUTER_API_KEY
  ZAI_API_KEY
  GITHUB_PERSONAL_ACCESS_TOKEN
)

# The IronCurtain home: $IRONCURTAIN_HOME when it is absolute (the CLI
# rejects a relative one), else ~/.ironcurtain.
ironcurtain_home_dir() {
  case "${IRONCURTAIN_HOME:-}" in
    /*) printf '%s' "$IRONCURTAIN_HOME" ;;
    *) printf '%s' "$HOME/.ironcurtain" ;;
  esac
}

# Succeeds when $1 is one of SUPPORTED_NODE_MAJORS.
is_supported_node_major() {
  case " $SUPPORTED_NODE_MAJORS " in
    *" ${1:-none} "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints the value of $2 in the dotenv file $1 without executing the file:
# only `NAME=value` and `export NAME=value` lines count, a quoted value ends
# at its closing quote, an unquoted one at the first whitespace (so a trailing
# comment or CR is dropped), and the last assignment wins.
dotenv_value() {
  local file=$1 name=$2 line value found=1
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    case "$line" in
      "$name="*) value="${line#"$name="}" ;;
      *) continue ;;
    esac
    case "$value" in
      \"*) value="${value#\"}" && value="${value%%\"*}" ;;
      \'*) value="${value#\'}" && value="${value%%\'*}" ;;
      *) value="${value%%[[:space:]]*}" ;;
    esac
    found=0
  done <"$file"
  [ "$found" -eq 0 ] && printf '%s' "$value"
}

# Fills ENV_ARGS with `-e NAME` for every credential that has a value and
# exports the values taken from the env files. A non-empty value already in
# the environment wins, as it does for the CLI; $IRONCURTAIN_ENV_FILE (when
# absolute) wins over the home file.
collect_credentials() {
  local env_files=() var file value
  case "${IRONCURTAIN_ENV_FILE:-}" in
    /*) env_files+=("$IRONCURTAIN_ENV_FILE") ;;
  esac
  env_files+=("$(ironcurtain_home_dir)/.env")

  ENV_ARGS=()
  for var in "${CREDENTIAL_VARS[@]}"; do
    if [ -z "${!var:-}" ]; then
      for file in "${env_files[@]}"; do
        if value="$(dotenv_value "$file" "$var")" && [ -n "$value" ]; then
          printf -v "$var" '%s' "$value"
          export "${var?}"
          break
        fi
      done
    fi
    if [ -n "${!var:-}" ]; then
      ENV_ARGS+=(-e "$var")
    fi
  done
}

# Sourced (test/dev-environment.test.ts): define the helpers above, run nothing.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

# --- Ensure the Linux clone exists ---
if [ ! -d "$LINUX_PROJECT_DIR/.git" ]; then
  echo "Linux clone not found at $LINUX_PROJECT_DIR"
  echo "Cloning from $REPO_URL ..."
  git clone "$REPO_URL" "$LINUX_PROJECT_DIR"
fi

# --- Sync current branch to the Linux clone ---
CURRENT_BRANCH="$(git -C "$MAC_PROJECT_DIR" rev-parse --abbrev-ref HEAD)"
echo "Syncing branch '$CURRENT_BRANCH' to Linux clone..."
git -C "$LINUX_PROJECT_DIR" fetch origin
git -C "$LINUX_PROJECT_DIR" checkout "$CURRENT_BRANCH" 2>/dev/null \
  || git -C "$LINUX_PROJECT_DIR" checkout -b "$CURRENT_BRANCH" "origin/$CURRENT_BRANCH" 2>/dev/null \
  || git -C "$LINUX_PROJECT_DIR" checkout -b "$CURRENT_BRANCH"
git -C "$LINUX_PROJECT_DIR" reset --hard "origin/$CURRENT_BRANCH" 2>/dev/null || true

# --- Build the dev image if needed ---
build_image() {
  echo "Building $IMAGE_NAME image..."
  docker build -t "$IMAGE_NAME" --build-arg "SUPPORTED_NODE_MAJORS=$SUPPORTED_NODE_MAJORS" \
    -f - "$MAC_PROJECT_DIR" <<'DOCKERFILE'
FROM docker:28-dind

# Node.js and build tools (needed for native modules like isolated-vm and
# node-pty). docker:28-dind is Alpine 3.22, whose `nodejs` package is
# Node 22, which IronCurtain does not support; `nodejs-current` is Node 24.
RUN apk add --no-cache \
      nodejs-current npm \
      python3 make g++ linux-headers \
      bash sudo shadow curl git

# Fail the build unless Node.js is a major package.json "engines" allows.
ARG SUPPORTED_NODE_MAJORS
RUN major="$(node -p 'process.versions.node.split(".")[0]')" \
 && case " $SUPPORTED_NODE_MAJORS " in \
      *" $major "*) echo "Node.js $(node --version)" ;; \
      *) echo "Node.js $(node --version) is not supported; IronCurtain needs a major in: $SUPPORTED_NODE_MAJORS" >&2; exit 1 ;; \
    esac

# package.json "allowScripts" denies onnxruntime-node's install script, but
# only npm 11.19 and later enforce it; this skips it with any npm (it only
# downloads optional CUDA binaries).
ENV ONNXRUNTIME_NODE_INSTALL=skip

# Install tsx globally and Aikido safe-chain
RUN npm install -g tsx @aikidosec/safe-chain

# Create a non-root dev user
RUN groupadd -g 1000 dev && useradd -m -u 1000 -g dev -s /bin/bash dev && \
    usermod -aG docker dev && \
    echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev

WORKDIR /workspace
DOCKERFILE
}

# Prints the Node.js major of the existing image (empty when it has none).
image_node_major() {
  docker run --rm --entrypoint node "$IMAGE_NAME" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

# Build if the image doesn't exist, has an unsupported Node.js, or --rebuild requested
if [ "${1:-}" = "--rebuild" ]; then
  shift
  build_image
elif ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  build_image
else
  existing_major="$(image_node_major)"
  if ! is_supported_node_major "$existing_major"; then
    echo "$IMAGE_NAME has Node.js ${existing_major:-(none)}; IronCurtain needs one of: $SUPPORTED_NODE_MAJORS. Rebuilding."
    build_image
  fi
fi

# --- Collect credentials to forward ---
collect_credentials

# --- Remove stale container if present ---
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "Removing existing $CONTAINER_NAME container..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

# --- Launch ---
echo "Starting Linux dev container (Docker-in-Docker)..."
echo "  Project: $LINUX_PROJECT_DIR -> /workspace"
echo ""

exec docker run -it --rm \
  --name "$CONTAINER_NAME" \
  --privileged \
  -e DOCKER_TLS_CERTDIR="" \
  -e DOCKER_HOST="unix:///var/run/docker.sock" \
  -v "$LINUX_PROJECT_DIR:/workspace" \
  -v "$(ironcurtain_home_dir):/home/dev/.ironcurtain" \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  "$IMAGE_NAME" \
  sh -c '
    # Start the Docker daemon in the background
    dockerd-entrypoint.sh dockerd &>/var/log/dockerd.log &

    # Wait for the daemon to be ready
    echo -n "Waiting for Docker daemon"
    for i in $(seq 1 30); do
      if docker info >/dev/null 2>&1; then
        echo " ready."
        break
      fi
      echo -n "."
      sleep 1
    done
    if ! docker info >/dev/null 2>&1; then
      echo " failed!"
      echo "Docker daemon did not start. Check /var/log/dockerd.log"
      exit 1
    fi

    # Fix workspace ownership for the dev user
    chown dev:dev /workspace 2>/dev/null || true

    # Install dependencies when node_modules is missing. When it exists but a
    # native module does not load (built on another platform, or for the
    # Node.js of an older image: rebuilding the image keeps the node_modules
    # of this clone), rebuild them: npm install skips packages it has already
    # installed, and npm rebuild recompiles them for this Node.js.
    if [ ! -d /workspace/node_modules ]; then
      echo "Installing dependencies (Linux native modules)..."
      su dev -c "cd /workspace && npm install && npm run build"
    elif ! su dev -c "cd /workspace && node -e \"require('"'"'node-pty'"'"'); require('"'"'isolated-vm'"'"')\"" 2>/dev/null; then
      echo "Rebuilding dependencies for Node.js $(node --version) (a native module does not load)..."
      su dev -c "cd /workspace && npm install && npm rebuild && npm run build"
    fi

    # API keys arrive as environment variables (CREDENTIAL_VARS in
    # scripts/linux-dev.sh); the CLI never reads a .env in /workspace.

    if [ $# -gt 0 ]; then
      exec su dev -c "cd /workspace && $*"
    else
      echo ""
      echo "=== IronCurtain Linux Dev Shell ($(node --version)) ==="
      echo "Run:  npm test              # all tests"
      echo "      npm run build         # compile TypeScript"
      echo "      npm start \"task\"      # run with a task"
      echo "      docker info           # verify Docker access"
      echo ""
      exec su dev -c "cd /workspace && exec bash --login"
    fi
  ' sh "$@"
