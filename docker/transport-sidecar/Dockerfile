# IronCurtain transport sidecar (macOS Docker Desktop, `tcp-sidecar` topology).
#
# The sidecar bridges a session's --internal network to the host-side MCP and
# MITM proxies (and, in PTY mode, the terminal), so it relays every tool call
# and the agent's CONNECT streams: it is part of the isolation boundary. It is
# therefore never pulled by name. src/docker/transport-sidecar-image.ts builds
# this file through the build-hash-labelled image cache and creates the
# sidecar from the immutable image ID the build resolved to, read-only, as
# nobody, with every capability dropped and no new privileges.
#
# Base: the Docker Official alpine image. socat comes from Alpine's main
# repository; apk verifies each package against the signing keys the base
# image ships. Changing this file changes the build hash, so the next session
# rebuilds the image.
FROM alpine:3.22
RUN apk add --no-cache socat
LABEL org.opencontainers.image.title="IronCurtain transport sidecar"
# socat needs no privilege: every relayed port is unprivileged and nothing is
# written to the filesystem.
USER 65534:65534
ENTRYPOINT ["socat"]
