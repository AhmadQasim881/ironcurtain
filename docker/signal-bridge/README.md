# Authenticated Signal bridge

This image derives official Signal 0.101 and replaces its API with TLS and
admission before Gin's logger, recovery and routes. The image contract
`org.ironcurtain.signal-bridge-auth=1` means TLS plus admission on every route,
including health, OPTIONS, unknown paths and WebSocket upgrades. No Signal
identity, TLS private key or admission token is built into the image.

The runtime pins official multi-platform index
`bbernhard/signal-cli-rest-api@sha256:2cf09d66a86fdd210e42ee91662216364acc27da1163a8c44167a77ea3a6559a`.
The Go builder separately pins official Go 1.26.11 bookworm. Source commit is
`74253a3a41c2cade40fd4a53cf3fb7a3fdf305dc` (tag 0.101). `upstream.sha256` pins the
35 small official source files, including generated docs. The external source
context must contain exactly those relative paths; the recipe verifies every
SHA-256, exact regular-file count and absence of links/special entries before
applying `upstream-auth.patch`. No large upstream assets are needed or vendored.

From the repository root, `npm run build:signal-bridge` fetches and verifies
the pinned source and builds the image. It requires explicit approval for its
source/dependency downloads and image pulls/build. To reuse a verified source
context, run `npm run build:signal-bridge -- --source-dir=/absolute/path/to/source`.

After source-download approval, fetch only the manifest paths from
`https://raw.githubusercontent.com/bbernhard/signal-cli-rest-api/74253a3a41c2cade40fd4a53cf3fb7a3fdf305dc/`.
Verify with `sha256sum --check` from the context root. A verified local context
needs no further source download. After image-build/pull approval:

```sh
SIGNAL_SOURCE_CONTEXT='/absolute/path/to/verified/source-context'
DOCKER_CONFIG='/absolute/path/to/empty-public-docker-config'
export DOCKER_CONFIG

docker build \
  --build-context "signal-source=$SIGNAL_SOURCE_CONTEXT" \
  --tag ironcurtain-signal-bridge:0.101-auth1 \
  docker/signal-bridge
```

The build can pull the two pinned base images and download only dependencies
pinned by upstream `go.mod`/`go.sum`. `GOTOOLCHAIN=local` prohibits automatic
compiler upgrades. API and Lua plugin use identical compiler/dependency/flag
inputs. The loopback JSON-RPC helper is rebuilt from the same source. No Swagger
schema/tool download is needed. If the public Docker configuration needs a CLI
plugin, expose only an already installed executable; never copy user Docker
configuration or credentials.

The host mounts exactly one owner-private file read-only at
`/run/ironcurtain-signal-auth/credentials.json`. The exact schema is:

```json
{
  "version": 1,
  "token": "<64 lowercase hex>",
  "certPem": "<self-signed server PEM>",
  "keyPem": "<matching PKCS8 or RSA PEM>"
}
```

The bounded reader rejects links, non-regular/public files, more than 32768
bytes, duplicate/extra fields, trailing JSON, invalid tokens or TLS material,
expired or CA-marked certificates, missing serverAuth usage, or absent localhost/127.0.0.1
SANs. Tokens and keys never enter image layers, Docker arguments, environment
values or query parameters. Missing/wrong/duplicate/comma-joined/query-only
admission receives 401 before handlers or request logging. Gin redirects are
disabled so they cannot skip middleware. TLS has no HTTP fallback; the
WebSocket upgrade explicitly carries `X-IronCurtain-Signal-Auth: 1`.

The health helper reads the same file internally and verifies HTTPS with its
explicit certificate and server name localhost. It never passes a token to curl
or in a process argument. `--check-credentials` validates startup material
without opening a network connection.

The final image remains `USER signal-api` (1000). Native Linux can start the
wrapper as root with numeric `SIGNAL_BRIDGE_UID`/`SIGNAL_BRIDGE_GID`. It changes
ownership only of image/runtime paths `/etc/s6-overlay` and `/tmp/s6-runtime`
recursively, and of `/run` nonrecursively,
checks credentials as the target identity, then uses `setpriv` to execute
`/init`. It never chowns mounted Signal data or credentials. The pinned s6
scripts preserve this identity. Only `MODE=json-rpc` is supported;
`AUTO_RECEIVE_SCHEDULE` is refused. The additional JSON-RPC listener and API
client are both fixed to `127.0.0.1:6001` by the pinned source.

Offline standalone tests (run from this directory with an installed Go compiler):

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -count=1 \
  ironcurtain_auth.go healthcheck.go ironcurtain_auth_test.go
```

Built-image qualification also checks TLS/HTTP refusal, all-route admission and
upgrade headers, listeners, numeric identities, restart and teardown using only
synthetic material on a network with no Signal service access. Source tests and
labels alone do not qualify a runtime or live Signal delivery.
