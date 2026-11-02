#!/usr/bin/env bash
# Regtest stack for the gateway: bitcoind, electrs, the RGB proxy and
# rgb-node-api (see compose.yaml).
#
#   ./regtest/regtest.sh start                       fresh chain, all services up
#   ./regtest/regtest.sh stop                        stop and delete all data
#   ./regtest/regtest.sh mine <blocks>               mine to the miner wallet
#   ./regtest/regtest.sh sendtoaddress <addr> <btc>  pay from the miner wallet
#
# Host ports: rgb-node-api on REGTEST_RGB_NODE_API_PORT (34000), electrs on
# REGTEST_ELECTRUM_PORT (50001).
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=(docker compose -f compose.yaml)
BITCOIN_CLI=("${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=dev -rpcpassword=dev)
RGB_NODE_API_PORT="${REGTEST_RGB_NODE_API_PORT:-34000}"
ELECTRUM_PORT="${REGTEST_ELECTRUM_PORT:-50001}"
INITIAL_BLOCKS=103
TIMEOUT=180

_die() {
    echo "regtest: $*" >&2
    exit 1
}

_is_port_bound() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# _wait <what> <command...>: retry the command until it succeeds or TIMEOUT.
_wait() {
    local what=$1
    shift
    local start
    start=$(date +%s)
    until "$@" >/dev/null 2>&1; do
        if [ $(($(date +%s) - start)) -gt "$TIMEOUT" ]; then
            "${COMPOSE[@]}" logs >&2
            _die "timed out waiting for $what"
        fi
        sleep 1
    done
}

# Reach a service on the compose network from inside the bitcoind container.
_service_port_open() {
    "${COMPOSE[@]}" exec -T bitcoind nc -z "$1" "$2"
}

_mine() {
    "${BITCOIN_CLI[@]}" -rpcwallet=miner -generate "$1" >/dev/null
}

_start() {
    _stop
    for port in "$RGB_NODE_API_PORT" "$ELECTRUM_PORT"; do
        if _is_port_bound "$port"; then
            _die "port $port is already bound, services can't be started"
        fi
    done
    # bitcoind first, so dependent services do not fail on an unavailable RPC.
    "${COMPOSE[@]}" up -d bitcoind
    _wait bitcoind "${BITCOIN_CLI[@]}" getblockchaininfo
    "${BITCOIN_CLI[@]}" createwallet miner >/dev/null
    _mine "$INITIAL_BLOCKS"
    # Builds the rgb-node-api image on first use.
    "${COMPOSE[@]}" up -d
    _wait electrs _service_port_open electrs 50001
    _wait proxy _service_port_open proxy 3000
    _wait rgb-node-api curl --fail --silent "http://127.0.0.1:$RGB_NODE_API_PORT/healthcheck"
    echo "rgb-node-api: http://127.0.0.1:$RGB_NODE_API_PORT  electrs: tcp://127.0.0.1:$ELECTRUM_PORT"
}

_stop() {
    "${COMPOSE[@]}" down -v --remove-orphans
}

case "${1:-}" in
    start)
        _start
        ;;
    stop)
        _stop
        ;;
    mine)
        [ -n "${2:-}" ] || _die "usage: $0 mine <blocks>"
        _mine "$2"
        ;;
    sendtoaddress)
        [ -n "${3:-}" ] || _die "usage: $0 sendtoaddress <address> <amount>"
        "${BITCOIN_CLI[@]}" -rpcwallet=miner sendtoaddress "$2" "$3"
        ;;
    *)
        _die "usage: $0 start|stop|mine <blocks>|sendtoaddress <address> <amount>"
        ;;
esac
