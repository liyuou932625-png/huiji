#!/usr/bin/env bash
# 会记 — 手机版一键启动：本地网页 + cloudflared 公网 HTTPS 隧道
# 手机无需大模型：连不上本机 Ollama 时自动用规则断句 + 启发式总结
# 用法：./phone.sh   → 打印手机可访问的 HTTPS 地址 + 二维码
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"

# 1) 本地网页服务（若未运行）
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "→ 启动网页服务 :${PORT} ..."
  python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory "$PWD" >/dev/null 2>&1 &
  sleep 1
fi

# 2) 重启 cloudflared 隧道（http2，规避沙箱/UDP 屏蔽）
pkill -f "cloudflared tunnel --url http://localhost:${PORT}" 2>/dev/null || true
sleep 1
rm -f tools/tunnel-web.log
./tools/cloudflared tunnel --url "http://localhost:${PORT}" \
  --protocol http2 --no-autoupdate --logfile tools/tunnel-web.log --loglevel info &
TUNNEL_PID=$!

# 3) 等隧道就绪（最多 90 秒），拿到可用的 HTTPS 地址
URL=""
for i in $(seq 1 45); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" tools/tunnel-web.log 2>/dev/null | tail -1)
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

echo ""
echo "=============================================="
echo " 手机版地址（HTTPS，可直接安装到主屏幕）："
echo "   $URL"
echo "=============================================="

# 4) 生成二维码（需 qrcode 库；装到 .pylibs 或本机 python 均可）
PYTHONPATH=/home/liyuou/dsh/.pylibs python3 - "$URL" <<'PY' 2>/dev/null || true
import sys
try:
    import qrcode
    qrcode.make(sys.argv[1]).save("tools/phone-qr.png")
    print("二维码已保存: tools/phone-qr.png（手机扫码即开）")
except Exception:
    pass
PY

echo "隧道进程 PID: $TUNNEL_PID（日志 tools/tunnel-web.log；Ctrl+C 或 pkill cloudflared 停止）"
