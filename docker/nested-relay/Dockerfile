# syntax=docker/dockerfile:1.7
# Go toolchain: one exact, supported release. The relay image is cached on
# users' machines by a hash of this file, main.go and go.mod, so a new toolchain
# reaches them only through an edit here. Move go.mod's `go` line to the same
# release in the same change: CI's `go test` runs that release, and
# scripts/check-go-toolchain.ts fails until the two agree (and, in its weekly
# run, once the release is out of support or behind its latest patch).
#
# Before a release the stage must also be pinned by the verified digest of the
# multi-platform golang:<release>-bookworm index
# (golang:1.26.11-bookworm@sha256:<64 hex>): the release runs
# `check:go-toolchain --strict`, which refuses an undigested golang stage. Never
# commit a placeholder digest: no registry serves it, so the image could not be
# built on users' machines.
FROM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS build
WORKDIR /src
COPY go.mod main.go ./
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/ironcurtain-fixed-relay ./main.go

FROM scratch
COPY --from=build /out/ironcurtain-fixed-relay /ironcurtain-fixed-relay
LABEL org.opencontainers.image.title="IronCurtain fixed-target relay" \
      org.opencontainers.image.source="https://github.com/provos/ironcurtain" \
      org.opencontainers.image.version="1" \
      com.ironcurtain.docker-workload.component="fixed-relay"
USER 65532:65532
ENTRYPOINT ["/ironcurtain-fixed-relay"]
