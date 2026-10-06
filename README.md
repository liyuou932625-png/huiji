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

**永久链接（推荐）**：<https://liyuou932625-png.github.io/huiji/>

- 由 GitHub Pages 托管，**永久免费、不会失效**（二维码 `tools/pages-qr.png`）
- 手机打开 → 添加到主屏幕 = 桌面应用（独立于浏览器，关标签页不影响）
- 基础功能（录音/浏览器转写/规则整理/历史/导出）永久可用，**历史存在手机本地**（IndexedDB）
- **AI 自动发现，无需配置**：电脑端会把当前地址自动发布到 `backend-url.txt`，
  手机打开时自动拉取并连接 → AI 精准转写（说话人分离）/ 校错 / 总结直接可用，地址变了也不用改
- 前提：电脑开机（已配置登录+开机自启）

**电脑本机算力版（临时隧道）**：

```bash
./phone.sh   # 一键：Ollama + 网页/转写后端 + 公网隧道 + 看护（自动恢复）
```

- 打印的 `https://xxx.trycloudflare.com` 是临时地址，看护进程会在失效时自动换新并刷新 `tools/current-url.txt` 和 `tools/phone-qr.png`
- 手机填到设置里即可用 AI 精准转写（说话人分离）/ AI 校错 / AI 总结
- 注意：免费隧道地址是临时的，电脑重启后跑一次 `./phone.sh` 即可

## 模型与依赖来源

转写管线来自 [zxkane/audio-transcriber](https://github.com/zxkane/audio-transcriber) skill（FunASR + CAM++），
会议纪要/导出格式参考 [shalomb/agent-skills](https://github.com/shalomb/agent-skills) meeting-notes，
PWA 策略参考 [jwynia/agent-skills](https://github.com/jwynia/agent-skills) pwa-development。
