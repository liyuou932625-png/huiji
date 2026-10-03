#!/usr/bin/env bash
# 会记 — 本地启动脚本：Ollama（本机 AI 算力）+ 静态网页服务器
# 用法：./start.sh   （Ctrl+C 停止）
set -e
cd "$(dirname "$0")"

OLLAMA_BIN="$PWD/ollama-runtime/bin/ollama"
MODELS_DIR="$PWD/ollama-runtime/models"
PORT="${PORT:-8000}"

# 1) 启动 Ollama（后台常驻；若已在运行则跳过）
if curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "✔ Ollama 已在运行"
else
  echo "→ 启动 Ollama 服务..."
  nohup env OLLAMA_MODELS="$MODELS_DIR" OLLAMA_ORIGINS="*" OLLAMA_HOST=127.0.0.1:11434 \
    "$OLLAMA_BIN" serve >"$PWD/ollama-runtime/serve.log" 2>&1 &
  for i in $(seq 1 20); do
    curl -s --max-time 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
  echo "✔ Ollama 已启动（模型：qwen2.5:3b-instruct）"
fi

# 2) 网页 + 精准转写后端（localhost 才是安全上下文，麦克风可用）
#    后端同时提供：静态网页 / Ollama 代理 / FunASR 精准转写（说话人分离）
echo "→ 启动网页+转写服务 http://localhost:$PORT ..."
if [ ! -x "$PWD/asr-venv/bin/python" ]; then
  echo "⚠ 未找到 asr-venv，回退到纯静态服务器（无精准转写）"
  exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$PWD"
fi
exec "$PWD/asr-venv/bin/python" "$PWD/asr_server.py"
