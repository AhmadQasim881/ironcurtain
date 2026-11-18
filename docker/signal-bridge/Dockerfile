# Both builder and runtime are immutable official multi-platform index pins.
FROM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS build
ENV GOTOOLCHAIN=local
WORKDIR /upstream
# A named local context contains the 35 official, blob-verified source files
# from commit 74253a3a41c2cade40fd4a53cf3fb7a3fdf305dc, not the huge test assets.
COPY --from=signal-source / /upstream/
COPY upstream.sha256 upstream-auth.patch ironcurtain_auth.go healthcheck.go /recipe/
RUN sha256sum --check /recipe/upstream.sha256 \
    && test "$(find . -type f | wc -l)" -eq 35 \
    && test -z "$(find . ! -type f ! -type d -print -quit)" \
    && git apply --check /recipe/upstream-auth.patch \
    && git apply /recipe/upstream-auth.patch \
    && cp /recipe/ironcurtain_auth.go src/ironcurtain_auth.go \
    && gofmt -w src/main.go src/api/api.go src/ironcurtain_auth.go
WORKDIR /upstream/src
# API and plugin must use the identical compiler, dependency tree and flags.
# Dependencies are the exact pinned upstream go.mod/go.sum; no toolchain update.
RUN go mod download \
    && go build -trimpath -o /out/signal-cli-rest-api main.go ironcurtain_auth.go \
    && go build -trimpath -buildmode=plugin -o /out/signal-cli-rest-api_plugin_loader.so plugin_loader.go \
    && go build -trimpath -o /out/jsonrpc2-helper ./scripts \
    && go build -trimpath -o /out/ironcurtain-signal-health /recipe/healthcheck.go /recipe/ironcurtain_auth.go

FROM bbernhard/signal-cli-rest-api@sha256:2cf09d66a86fdd210e42ee91662216364acc27da1163a8c44167a77ea3a6559a
USER root
COPY --from=build /out/signal-cli-rest-api /usr/bin/signal-cli-rest-api
COPY --from=build /out/signal-cli-rest-api_plugin_loader.so /usr/bin/signal-cli-rest-api_plugin_loader.so
COPY --from=build /out/jsonrpc2-helper /usr/bin/jsonrpc2-helper
COPY --from=build /upstream/LICENSE /usr/share/licenses/ironcurtain-signal-bridge/upstream-LICENSE
COPY --from=build /out/ironcurtain-signal-health /usr/local/bin/ironcurtain-signal-health
COPY --chmod=0555 entrypoint.sh /usr/local/bin/ironcurtain-signal-entrypoint
RUN mkdir -p /run/ironcurtain-signal-auth \
    && chmod 0755 /run/ironcurtain-signal-auth \
    && test -d /run && test ! -L /run \
    && chown signal-api:signal-api /run
LABEL org.ironcurtain.signal-bridge-auth="1" \
      org.ironcurtain.signal-source-commit="74253a3a41c2cade40fd4a53cf3fb7a3fdf305dc" \
      org.ironcurtain.signal-upstream-version="0.101"
ENV MODE=json-rpc PORT=8080 \
    IRONCURTAIN_SIGNAL_CREDENTIALS_FILE=/run/ironcurtain-signal-auth/credentials.json
USER signal-api
ENTRYPOINT ["/usr/local/bin/ironcurtain-signal-entrypoint"]
CMD []
HEALTHCHECK --interval=20s --timeout=10s --retries=3 CMD ["/usr/local/bin/ironcurtain-signal-health"]
