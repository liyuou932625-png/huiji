#!/usr/bin/env bash
# 会记 — 手机版一键启动：Ollama + 网页/转写后端 + 公网 HTTPS 隧道 + 看护进程
# 用法：./phone.sh   → 打印手机可访问的 HTTPS 地址 + 二维码（服务常驻，挂了自动重启）
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
OLLAMA_BIN="$PWD/ollama-runtime/bin/ollama"
VENV_PY="$PWD/asr-venv/bin/python"

# 1) Ollama（本机 AI 算力）
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:11434/api/tags"; then
  echo "✔ Ollama 已在运行"
else
  echo "→ 启动 Ollama ..."
  nohup env OLLAMA_MODELS="$PWD/ollama-runtime/models" OLLAMA_ORIGINS="*" OLLAMA_HOST=127.0.0.1:11434 \
    "$OLLAMA_BIN" serve >"$PWD/tools/ollama.log" 2>&1 &
  sleep 2
fi

# 2) 网页 + 精准转写后端（asr_server.py；无 venv 时退回静态服务器）
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/health"; then
  echo "✔ 网页+转写后端已在运行 (:${PORT})"
else
  echo "→ 启动网页+转写后端 :${PORT} ..."
  if [ -x "$VENV_PY" ]; then
    nohup env PATH="/home/liyuou/bin:$PATH" PYTHONIOENCODING=utf-8 "$VENV_PY" "$PWD/asr_server.py" \
      >"$PWD/tools/server.log" 2>&1 &
  else
    nohup python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory "$PWD" >/dev/null 2>&1 &
  fi
  sleep 2
fi

# 3) 隧道：若上次地址仍可用则保留，否则重启
CUR=$(cat "$PWD/tools/current-url.txt" 2>/dev/null || true)
if [ -n "$CUR" ] && curl -s -o /dev/null --max-time 15 "$CUR/"; then
  echo "✔ 隧道仍有效: $CUR"
  URL="$CUR"
else
  echo "→ 重启公网隧道 ..."
  for pid in $(pgrep -f "cloudflared tunnel" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  sleep 1
  rm -f "$PWD/tools/tunnel-web.log"
  nohup "$PWD/tools/cloudflared" tunnel --url "http://localhost:${PORT}" \
    --protocol http2 --no-autoupdate --logfile "$PWD/tools/tunnel-web.log" --loglevel info \
    >"$PWD/tools/tunnel.log" 2>&1 &
  URL=""
  for i in $(seq 1 45); do
    URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$PWD/tools/tunnel-web.log" 2>/dev/null | tail -1)
    if [ -n "$URL" ]; then
      CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$URL/" 2>/dev/null || true)
      if [ "$CODE" = "200" ]; then break; fi
    fi
    sleep 2
  done
  if [ -z "$URL" ] || [ "$CODE" != "200" ]; then
    echo "✘ 隧道未就绪（退出码 $CODE）。检查 tools/tunnel-web.log。"
    exit 1
  fi
  echo "$URL" > "$PWD/tools/current-url.txt"
fi

# 4) 看护进程（服务挂了自动重启；隧道地址变化自动更新并刷新二维码）
if ! pgrep -f "watchdog.sh" >/dev/null 2>&1; then
  nohup bash "$PWD/watchdog.sh" >/dev/null 2>&1 &
  echo "✔ 看护进程已启动（watchdog）"
fi

# 5) 把当前地址发布到 GitHub（手机端自动发现，无需手动填地址）
bash "$PWD/tools/publish-url.sh"

echo ""
echo "=============================================="
echo " 手机版地址（HTTPS，添加到主屏幕即 App）："
echo "   $URL"
echo "=============================================="
echo " 后端功能：AI 精准转写（说话人分离）/ AI 校错 / AI 总结（设置里地址留空即可）"
echo " 本机使用：http://localhost:${PORT}"
echo " 新地址记录在 tools/current-url.txt，二维码 tools/phone-qr.png"

# 5) 生成二维码
PYTHONPATH=/home/liyuou/dsh/.pylibs python3 - "$URL" <<'PY' 2>/dev/null || true
import sys
try:
    import qrcode
    qrcode.make(sys.argv[1]).save("tools/phone-qr.png")
    print("二维码已保存: tools/phone-qr.png（手机扫码即开）")
except Exception:
    pass
PY
