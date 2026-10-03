# 会记

手机会议记录网页：录音 → **精准转写（说话人分离）** → AI 断句校错 → **简短总结 + 行动项** → 保存/导出。全部用本机算力。

## 功能

- 录音 + 实时转写（浏览器 Web Speech，实时预览）
- **AI 精准转写**（FunASR SeACo-Paraformer，中文 CER ≈ 2%）：识别更准
- **说话人分离**（CAM++）：自动分清几位说话人、谁在说什么（测试双人对话 100% 分对）
- **AI 校错**：用本机大模型修正识别错的同音字（「会以」→「会议」）
- 会议全文整理：AI 断句加标点、去口语填充词（无 AI 时规则兜底）
- 会议重点总结：**用简洁的话概括，不照搬原文**（本地 AI 生成）
- 行动项提取、重点图片导出、Markdown/TXT 导出
- 历史归档（IndexedDB 本地保存，含录音回放）

## 启动

```bash
./start.sh   # 一键：Ollama（AI 总结/校错）+ 网页与转写后端（端口 8000）
# 浏览器打开 http://localhost:8000
```

后端（`asr_server.py`）同时提供：静态网页、Ollama 代理（`/api/tags`、`/api/chat`，手机端也能用 AI）、
精准转写任务（`POST /api/transcribe` + 轮询）。首次精准转写会自动下载 FunASR 模型（约 1.3GB，一次性，缓存于 `asr-models/`）。

环境准备（一次性）：

```bash
uv python install 3.12
uv venv asr-venv --python 3.12
uv pip install --python asr-venv/bin/python --index-url https://download.pytorch.org/whl/cpu torch torchaudio
uv pip install --python asr-venv/bin/python funasr modelscope soundfile scikit-learn flask "scipy>=1.11"
# 应用聚类性能补丁（skill 自带）
./asr-venv/bin/python asr-scripts/patch_clustering.py --yes
```

## 手机版（可安装 App）

```bash
./phone.sh   # 本机服务 + cloudflared 隧道，打印手机地址和二维码
```

手机打开隧道地址 → 添加到主屏幕。**手机端同样可用精准转写和 AI 总结**（后端代理 Ollama，地址留空自动走同源）。

> 注意：免费隧道地址是临时的，`cloudflared` 重启后跑 `./phone.sh` 拿新地址。

## 模型与依赖来源

转写管线来自 [zxkane/audio-transcriber](https://github.com/zxkane/audio-transcriber) skill（FunASR + CAM++），
会议纪要/导出格式参考 [shalomb/agent-skills](https://github.com/shalomb/agent-skills) meeting-notes，
PWA 策略参考 [jwynia/agent-skills](https://github.com/jwynia/agent-skills) pwa-development。
