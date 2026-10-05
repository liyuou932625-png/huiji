#!/usr/bin/env bash
# 会记服务看护（watchdog）：Ollama + 网页/转写后端 + 公网隧道，任一异常自动重启。
# 隧道地址变化时自动写入 tools/current-url.txt（新地址）。
# 用法：./watchdog.sh &   （或直接跑 ./phone.sh 会一并启动）
cd "$(dirname "$0")/.."
BASE="$PWD"
LOG="$BASE/tools/watchdog.log"
OLLAMA_BIN="$BASE/ollama-runtime/bin/ollama"
VENV_PY="$BASE/asr-venv/bin/python"
TUN_BIN="$BASE/tools/cloudflared"
FFMPEG_DIR="/home/liyuou/bin"
mkdir -p "$BASE/tools"

kill_port() { # 按端口找 PID 杀掉（避免误杀本脚本）
  local pids
  pids=$(ss -ltnp 2>/dev/null | awk -v p="$1" '$4 ~ ":"p"$" {match($0, /pid=[0-9]+/); if (RSTART) print substr($0, RSTART+4, RLENGTH-4)}' | sort -u)
  [ -n "$pids" ] && kill $pids 2>/dev/null
}

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

while true; do
  # 1) Ollama
  if ! curl -s --max-time 3 -o /dev/null http://127.0.0.1:11434/api/tags; then
    log "Ollama 掉线，重启"
    nohup env OLLAMA_MODELS="$BASE/ollama-runtime/models" OLLAMA_ORIGINS="*" OLLAMA_HOST=127.0.0.1:11434 \
      "$OLLAMA_BIN" serve >>"$LOG" 2>&1 &
  fi
  # 2) 网页 + 转写后端
  if ! curl -s --max-time 3 -o /dev/null http://127.0.0.1:8000/api/health; then
    log "后端掉线，重启"
    kill_port 8000
    sleep 1
    nohup env PATH="$FFMPEG_DIR:$PATH" PYTHONIOENCODING=utf-8 "$VENV_PY" "$BASE/asr_server.py" >>"$LOG" 2>&1 &
  fi
  # 3) 公网隧道：当前地址不可达才重启（地址变化时更新 current-url.txt）
  CUR=$(cat "$BASE/tools/current-url.txt" 2>/dev/null)
  if [ -n "$CUR" ] && curl -s --max-time 15 -o /dev/null "$CUR"; then
    :
  else
    log "隧道不可达，重启"
    for pid in $(pgrep -f "cloudflared tunnel" 2>/dev/null); do
      [ "$pid" != "$$" ] && kill "$pid" 2>/dev/null
    done
    sleep 2
    nohup "$TUN_BIN" tunnel --url http://localhost:8000 --protocol http2 --no-autoupdate \
      --logfile "$BASE/tools/tunnel-web.log" --loglevel info >>"$LOG" 2>&1 &
    sleep 12
    U=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$BASE/tools/tunnel-web.log" | tail -1)
    if [ -n "$U" ]; then
      echo "$U" > "$BASE/tools/current-url.txt"
      log "新隧道地址: $U"
      # 顺带刷新二维码
      if [ -f "$BASE/tools/phone-qr.png" ]; then
        PYTHONPATH=/home/liyuou/dsh/.pylibs "$VENV_PY" - <<PY 2>/dev/null || true
import qrcode
img = qrcode.make("$U")
img.save("$BASE/tools/phone-qr.png")
PY
      fi
    fi
  fi
  sleep 25
done
