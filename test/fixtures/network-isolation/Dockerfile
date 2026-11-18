# Test image for test/network-isolation.integration.test.ts, built by the CI
# job "network-isolation" (.github/workflows/ci.yml) and passed to the suite
# as NETWORK_ISOLATION_TEST_IMAGE.
#
# The suite starts it with --network=none and --cap-drop=ALL and drives only
# bash, socat, curl, pgrep and sleep inside it, so it does not need the full
# agent base image (docker/Dockerfile.base). coreutils supplies a sleep that
# accepts "infinity" and fractions; procps supplies pgrep.
FROM alpine:3.22
RUN apk add --no-cache bash coreutils curl procps socat
# The suite bind-mounts a host directory that mkdtemp created with mode 0700
# and connects to Unix sockets in it. With every capability dropped, root in
# the container cannot override those modes, so the container runs as the
# host user that owns the directory: build with --build-arg TEST_UID="$(id -u)".
ARG TEST_UID=1000
USER ${TEST_UID}
