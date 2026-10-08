#!/usr/bin/env bash
# 用 dshx 启动两个 DeepSeek Harness 检出：
#   shiguredo  shiguredo/deepseek-harness（时雨堂分支版）
#   official   deepseek-ai/deepseek-harness（官方上游版）
#
# 用法：
#   bash scripts/run-repos.sh shiguredo [dsh web 参数…]   默认
#   bash scripts/run-repos.sh official   [dsh web 参数…]
#   bash scripts/run-repos.sh both       [dsh web 参数…]
#
# 仓库首次启动时 dshx 会自动 clone 并构建（pnpm install + clean + build），需要等几分钟。
# both 模式给两个仓库各一个端口，日志写到 ~/.dshx/logs 下。
set -euo pipefail

SHIGUREDO_REPO=${SHIGUREDO_REPO:-shiguredo/deepseek-harness}
OFFICIAL_REPO=${OFFICIAL_REPO:-deepseek-ai/deepseek-harness}
SHIGUREDO_PORT=${SHIGUREDO_PORT:-7399}
OFFICIAL_PORT=${OFFICIAL_PORT:-7400}
LOGS=${DSHX_LOGS:-$HOME/.dshx/logs}

command -v dshx >/dev/null || {
  echo "找不到 dshx，先安装：deno install -g -n dshx --allow-net --allow-run --allow-env --allow-sys --allow-read --allow-write jsr:@mzk/dshx" >&2
  exit 1
}

# 前台启动：切到该仓库，然后把终端交给它
start() {
  dshx use "$1"
  shift
  exec dshx "$@"
}

# 等 dshx 真正读过 config 再切下一个，避免 config 竞态
wait_configured() {
  local log="$1"
  for _ in $(seq 1 60); do
    grep -q "^dshx:" "$log" 2>/dev/null && return 0
    sleep 1
  done
  echo "dshx 没有在 60 秒内开始同步，见 $log" >&2
  exit 1
}

start_both() {
  mkdir -p "$LOGS"
  local s_log="$LOGS/shiguredo.log" o_log="$LOGS/official.log" pids=()

  dshx use "$SHIGUREDO_REPO"
  dshx --no-open --port "$SHIGUREDO_PORT" "$@" >"$s_log" 2>&1 &
  pids+=($!)
  wait_configured "$s_log"

  dshx use "$OFFICIAL_REPO"
  dshx --no-open --port "$OFFICIAL_PORT" "$@" >"$o_log" 2>&1 &
  pids+=($!)

  trap 'kill "${pids[@]}" 2>/dev/null || true' INT TERM EXIT
  echo "dshx: shiguredo → http://127.0.0.1:$SHIGUREDO_PORT/   日志 $s_log"
  echo "dshx: official  → http://127.0.0.1:$OFFICIAL_PORT/   日志 $o_log"
  echo "dshx: 首次启动需要构建，等日志里出现 dsh web: http 即可。Ctrl-C 停止两个。"
  wait
}

case "${1:-shiguredo}" in
  shiguredo) shift || true; start "$SHIGUREDO_REPO" "$@" ;;
  official) shift || true; start "$OFFICIAL_REPO" "$@" ;;
  both) shift || true; start_both "$@" ;;
  -h | --help | help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "不认识 '${1}'。用法：bash scripts/run-repos.sh [shiguredo|official|both] [dsh web 参数…]" >&2
    exit 1
    ;;
esac
