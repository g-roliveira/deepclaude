#!/usr/bin/env bash
# deepclaude — Use Claude Code with DeepSeek or Anthropic
# Usage: deepclaude [--backend ds|anthropic] [--remote] [--effort level] [--status] [--cost] [--benchmark]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

# --- Config ---
DEEPSEEK_URL="https://api.deepseek.com/anthropic"
BACKEND="${CHEAPCLAUDE_DEFAULT_BACKEND:-ds}"
ACTION="launch"
SWITCH_BACKEND=""
EFFORT_LEVEL=""
PROXY_PID=""
SESSION_LOG=""

init_session_log() {
    local label="interactive" arg next
    local args=("$@")
    for ((i = 0; i < ${#args[@]}; i++)); do
        arg="${args[$i]}"
        if [[ "$arg" == "--resume" || "$arg" == "--resume-session" ]]; then
            next="${args[$((i + 1))]:-}"
            if [[ -n "$next" && "$next" != -* ]]; then label="$next"; fi
            break
        elif [[ "$arg" == --resume=* ]]; then
            label="${arg#--resume=}"
            break
        elif [[ "$arg" == "--continue" ]]; then
            label="continue"
            break
        fi
    done
    [[ "$label" =~ ^[a-zA-Z0-9._-]+$ ]] || label="interactive"
    local log_dir="$SCRIPT_DIR/.deepclaude/logs"
    mkdir -p "$log_dir"
    SESSION_LOG="$log_dir/claude-${label}-$(date +%Y%m%d-%H%M%S)-pid$$.log"
    {
        echo "started_at=$(date --iso-8601=seconds)"
        echo "session_label=$label"
        echo "launcher_pid=$$"
        echo "backend=$BACKEND"
        echo "working_directory=$PWD"
        echo "proxy_logs=stderr"
        echo "--- proxy events ---"
    } >> "$SESSION_LOG"
}

close_session_log() {
    if [[ -n "$SESSION_LOG" ]]; then
        {
            echo "--- session ended ---"
            echo "ended_at=$(date --iso-8601=seconds)"
            echo "proxy_pid=${PROXY_PID:-none}"
        } >> "$SESSION_LOG"
    fi
}

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b) BACKEND="$2"; shift 2 ;;
        --switch|-s)  ACTION="switch"; SWITCH_BACKEND="$2"; shift 2 ;;
        --effort)     EFFORT_LEVEL="$2"; shift 2 ;;
        --remote|-r)  ACTION="remote"; shift ;;
        --status)     ACTION="status"; shift ;;
        --cost)       ACTION="cost"; shift ;;
        --benchmark)  ACTION="benchmark"; shift ;;
        --help|-h)    ACTION="help"; shift ;;
        --)           shift; break ;;
        *)            break ;;
    esac
done

cleanup_proxy() {
    if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
        kill "$PROXY_PID" 2>/dev/null || true
        echo "  Proxy stopped."
    fi
}
trap 'cleanup_proxy; close_session_log' EXIT

mask_key() {
    local k="$1"
    if [[ -z "$k" ]]; then echo "MISSING"; else echo "set (****${k: -4})"; fi
}

resolve_backend() {
    local url="" key="" opus="" sonnet="" haiku="" subagent=""
    case "$BACKEND" in
        ds|deepseek)
            key="${DEEPSEEK_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: DEEPSEEK_API_KEY not set" >&2; exit 1; }
            url="$DEEPSEEK_URL"
            opus="deepseek-flash[1m]"; sonnet="deepseek-flash[1m]"
            haiku="deepseek-flash[1m]"; subagent="deepseek-flash[1m]"
            export DEEPCLAUDE_VISION_MODEL="deepseek-flash"
            ;;
        anthropic) ;;
        *) echo "ERROR: Unknown backend '$BACKEND'. Use: ds, deepseek, anthropic" >&2; exit 1 ;;
    esac
    RESOLVED_URL="$url"; RESOLVED_KEY="$key"
    RESOLVED_OPUS="$opus"; RESOLVED_SONNET="$sonnet"
    RESOLVED_HAIKU="$haiku"; RESOLVED_SUBAGENT="$subagent"
}

set_model_env() {
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$RESOLVED_OPUS"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$RESOLVED_SONNET"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$RESOLVED_HAIKU"
    export CLAUDE_CODE_SUBAGENT_MODEL="$RESOLVED_SUBAGENT"
    # DeepSeek's official Claude Code integration reserves headroom for
    # compaction, tool results, reasoning, and completion tokens.
    export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
    if [[ -n "$EFFORT_LEVEL" ]]; then
        export CLAUDE_CODE_EFFORT_LEVEL="$EFFORT_LEVEL"
    fi
}

show_status() {
    echo ""
    echo "  deepclaude — Backend Status"
    echo "  ============================"
    echo ""
    echo "  Keys:"
    echo "    DEEPSEEK_API_KEY:    $(mask_key "${DEEPSEEK_API_KEY:-}")"
    echo ""
    echo "  Backends:"
    echo "    deepclaude                  # DeepSeek V4.1 Flash (default)"
    echo "    deepclaude -b anthropic     # Normal Claude Code"
    echo "    deepclaude --remote         # Remote control + DeepSeek"
    echo ""
    local proxy_status
    proxy_status=$(curl -s http://127.0.0.1:3200/_proxy/status 2>/dev/null) || proxy_status=""
    if [[ -n "$proxy_status" ]]; then
        echo "  Proxy: running"
        echo "    $proxy_status"
    else
        echo "  Proxy: not running"
    fi
    echo ""
}

show_cost() {
    echo ""
    echo "  Token pricing estimates (USD, DeepSeek peak rates)"
    echo "  ======================="
    echo ""
    echo "  Provider        Input/M    Output/M   Cache Hit/M"
    echo "  ----------      --------   --------   -----------"
    echo "  DeepSeek        \$0.30      \$1.20      \$0.006"
    echo "  Anthropic       \$3.00      \$15.00     \$0.30"
    echo ""
    echo "  Estimates exclude search/fetch charges and off-peak discounts."
    echo ""
}

show_help() {
    echo "deepclaude — Claude Code with DeepSeek or Anthropic"
    echo ""
    echo "Usage: deepclaude [options] [-- claude-args...]"
    echo ""
    echo "Options:"
    echo "  -b, --backend <ds|anthropic>          Backend (default: ds; ds alias: deepseek)"
    echo "  -r, --remote                        Remote control mode (browser URL)"
    echo "  --status                             Show keys and backends"
    echo "  --cost                               Pricing comparison"
    echo "  --benchmark                          Latency test"
    echo "  -s, --switch <backend>               Switch proxy mid-session"
    echo "  --effort <level>                      Reasoning effort: low|medium|high|xhigh|max|auto"
    echo "  -h, --help                           This help"
    echo ""
    echo "Environment variables:"
    echo "  DEEPSEEK_API_KEY      DeepSeek API key (required for ds)"
    echo "  CHEAPCLAUDE_DEFAULT_BACKEND  Default backend (default: ds)"
}

do_switch() {
    local backend="$SWITCH_BACKEND"
    case "$backend" in
        ds|deepseek)   backend="deepseek" ;;
        anthropic)     backend="anthropic" ;;
    *) echo "ERROR: Unknown backend '$backend'. Use: ds, deepseek, anthropic" >&2; exit 1 ;;
    esac
    local resp
    resp=$(curl -sX POST http://127.0.0.1:3200/_proxy/mode -d "backend=$backend" 2>/dev/null) || {
        echo "  Proxy not running. Start with: deepclaude" >&2; exit 1
    }
    echo "  $resp"
}

run_benchmark() {
    echo ""
    echo "  Latency Benchmark (1 request each)"
    echo "  ==================================="
    for name in deepseek; do
        local url="" key="" model=""
        case "$name" in
            deepseek)   url="$DEEPSEEK_URL"; key="${DEEPSEEK_API_KEY:-}"; model="deepseek-flash" ;;
        esac
        if [[ -z "$key" ]]; then echo "  $name: SKIP (no key)"; continue; fi
        local start_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url/v1/messages" \
            -H "x-api-key: $key" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
            -d "{\"model\":\"$model\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply: ok\"}]}" \
            --max-time 30 2>/dev/null || echo "timeout")
        local end_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local elapsed=$((end_ms - start_ms))
        if [[ "$status" == "200" ]]; then
            echo "  $name: OK (${elapsed}ms)"
        else
            echo "  $name: FAIL ($status, ${elapsed}ms)"
        fi
    done
    echo ""
}

launch_claude() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        init_session_log "$@"
        echo "  Launching Claude Code (normal Anthropic backend)..."
        unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
        unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
        unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
        unset CLAUDE_CODE_EFFORT_LEVEL
        claude "$@"
        return
    fi

    resolve_backend
    init_session_log "$@"

    echo "  Starting model proxy for $BACKEND..."
    echo "  Endpoint: $RESOLVED_URL"
    echo "  Model: $RESOLVED_OPUS (main) + $RESOLVED_HAIKU (subagents)"
    echo ""

    local port_file
    port_file=$(mktemp)
    local proxy_args=("$SCRIPT_DIR/proxy/start-proxy.js" "$RESOLVED_URL" "$RESOLVED_KEY" "$BACKEND")
    node "${proxy_args[@]}" > "$port_file" 2>> "$SESSION_LOG" &
    PROXY_PID=$!

    local tries=0
    while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
        sleep 0.2
        tries=$((tries + 1))
    done

    if [[ ! -s "$port_file" ]]; then
        echo "ERROR: Proxy failed to start" >&2
        rm -f "$port_file"
        exit 1
    fi

    local proxy_port
    proxy_port=$(head -1 "$port_file")
    rm -f "$port_file"

    echo "  Proxy on :$proxy_port -> $RESOLVED_URL"
    echo "  Cost tracking: curl http://127.0.0.1:$proxy_port/_proxy/cost"
    echo ""

    export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
    export ANTHROPIC_API_KEY="$RESOLVED_KEY"
    unset ANTHROPIC_AUTH_TOKEN
    set_model_env

    claude "$@"
}

launch_remote() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        init_session_log "$@"
        echo "  Launching remote control (Anthropic)..."
        unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
        unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
        unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
        unset CLAUDE_CODE_EFFORT_LEVEL ANTHROPIC_API_KEY
        claude remote-control "$@"
        return
    fi

    resolve_backend
    init_session_log "$@"

    echo "  Starting model proxy for $BACKEND..."

    local port_file
    port_file=$(mktemp)
    local proxy_args=("$SCRIPT_DIR/proxy/start-proxy.js" "$RESOLVED_URL" "$RESOLVED_KEY" "$BACKEND")
    node "${proxy_args[@]}" > "$port_file" 2>> "$SESSION_LOG" &
    PROXY_PID=$!

    local tries=0
    while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
        sleep 0.2
        tries=$((tries + 1))
    done

    if [[ ! -s "$port_file" ]]; then
        echo "ERROR: Proxy failed to start" >&2
        rm -f "$port_file"
        exit 1
    fi

    local proxy_port
    proxy_port=$(head -1 "$port_file")
    rm -f "$port_file"

    echo "  Proxy on :$proxy_port -> $RESOLVED_URL"
    echo "  Launching remote control via $BACKEND..."
    echo ""

    export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
    set_model_env
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

    claude remote-control "$@"
}

# --- Main ---
case "$ACTION" in
    status)    show_status ;;
    cost)      show_cost ;;
    benchmark) run_benchmark ;;
    help)      show_help ;;
    switch)    do_switch ;;
    remote)    launch_remote "$@" ;;
    launch)    launch_claude "$@" ;;
esac
