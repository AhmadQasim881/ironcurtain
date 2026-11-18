#!/bin/sh
set -eu

fail() {
    printf '%s\n' "[ironcurtain-signal] $1" >&2
    exit 1
}

[ "${IRONCURTAIN_SIGNAL_CREDENTIALS_FILE:-}" = '/run/ironcurtain-signal-auth/credentials.json' ] || fail 'credentials file must use the fixed private path'
[ "${MODE:-}" = 'json-rpc' ] || fail 'only json-rpc mode is supported'
[ -z "${AUTO_RECEIVE_SCHEDULE+x}" ] || fail 'AUTO_RECEIVE_SCHEDULE is not supported'
[ "${PORT:-8080}" = '8080' ] || fail 'the internal port must be 8080'

uid=${SIGNAL_BRIDGE_UID-1000}
gid=${SIGNAL_BRIDGE_GID-1000}
for value in "$uid" "$gid"; do
    case "$value" in ''|0*|*[!0-9]*) fail 'service UID and GID must be positive decimal integers' ;; esac
    [ "${#value}" -le 10 ] && [ "$value" -le 2147483647 ] || fail 'service UID or GID is out of range'
done

if [ "$(id -u)" = '0' ]; then
    [ -d /run ] && [ ! -L /run ] || fail 'image s6 run directory is unsafe'
    # s6 preinit uses /run even when S6_RUNTIME_PATH is configured. Change
    # only that image-owned directory, never its mounted credentials child.
    chown -h "$uid:$gid" /run
    [ -d /etc/s6-overlay ] && [ ! -L /etc/s6-overlay ] || fail 'image s6 configuration is unsafe'
    [ ! -L /tmp/s6-runtime ] || fail 'image s6 runtime is unsafe'
    mkdir -p /tmp/s6-runtime
    # These are image/runtime paths only. Never change ownership of mounted
    # Signal identity/data or credential files.
    chown -hR "$uid:$gid" /etc/s6-overlay /tmp/s6-runtime
    setpriv --reuid="$uid" --regid="$gid" --clear-groups /usr/local/bin/ironcurtain-signal-health --check-credentials
    exec setpriv --reuid="$uid" --regid="$gid" --clear-groups /init
fi

[ "$(id -u)" = "$uid" ] && [ "$(id -g)" = "$gid" ] || fail 'service identity does not match the configured UID and GID'
/usr/local/bin/ironcurtain-signal-health --check-credentials
exec /init
