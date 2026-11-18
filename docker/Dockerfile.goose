# IronCurtain builds every image under a build-hash tag and passes the exact
# base build it resolved (ironcurtain-base:build-<hash>), so a concurrent build
# from another checkout cannot swap the base under this one. The default keeps
# a manual `docker build` working against the moving alias.
ARG IRONCURTAIN_BASE_IMAGE=ironcurtain-base:latest
FROM ${IRONCURTAIN_BASE_IMAGE}

# Install Goose CLI
# The binary is distributed as a single statically-linked Rust executable.
# Downloaded from GitHub releases and placed in /usr/local/bin/.
USER root

# Pinned to the version qualified with this IronCurtain release
# (GOOSE_CLI_VERSION in src/docker/agent-cli-version.ts; a test ties the two).
ARG GOOSE_VERSION=1.26.1
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) GOOSE_ARCH=x86_64 ;; \
      arm64) GOOSE_ARCH=aarch64 ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/block/goose/releases/download/v${GOOSE_VERSION}/goose-${GOOSE_ARCH}-unknown-linux-gnu.tar.bz2" \
      -o /tmp/goose.tar.bz2 && \
    tar -xjf /tmp/goose.tar.bz2 -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/goose && \
    rm -f /tmp/goose.tar.bz2 && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Entrypoint: bridges UDS proxy, writes Goose config, hands off to CMD.
# It sources the shared UID/GID remap helper, so that must be present too.
COPY entrypoint-uid-remap.sh /usr/local/bin/ironcurtain-uid-remap.sh
COPY entrypoint-goose.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Pre-create Goose's config directory and its session store. The session
# store is the conversation-state bind mount target (goose-state on the host);
# creating it here as codespace keeps the runtime from creating a root-owned
# ~/.local/share/goose for the mount.
USER codespace
RUN mkdir -p /home/codespace/.config/goose /home/codespace/.local/share/goose/sessions

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
