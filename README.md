# 会记

手机会议记录网页，支持录音、实时转写、会议重点整理和重点图片导出。

## 功能

- 录音 + 实时转写（Web Speech API）
- 会议全文整理：自动加标点、去口语填充词（本地 AI 优先，无 AI 时规则兜底）
- 会议重点总结：**用简洁的话概括，不照搬原文**（本地 AI 生成；无 AI 时用关键词启发式兜底）
- 行动项提取、重点图片导出、Markdown/TXT 导出
- 历史归档（IndexedDB 本地保存，含录音回放）

## 本地 AI（可选，用本机算力）

AI 通过 [Ollama](https://ollama.com) 跑在**本机**，数据不出设备。当前仓库自带 Ollama 运行时（`ollama-runtime/`，免 root 绿色版），用法：

```bash
# 1. 启动 Ollama 服务（后台常驻）
OLLAMA_MODELS=ollama-runtime/models OLLAMA_ORIGINS="*" OLLAMA_HOST=127.0.0.1:11434 \
  ollama-runtime/bin/ollama serve

# 2. 拉取模型（已下载 qwen2.5-3b-instruct-q4_k_m.gguf 时用本地创建代替）
ollama-runtime/bin/ollama pull qwen2.5:3b-instruct

# 3. 本地静态服务器打开本页（localhost 才是安全上下文，麦克风可用）
python3 -m http.server 8000 --directory .
# 浏览器打开 http://localhost:8000
```

然后到「设置」里点「检测 AI」，即可使用「AI 整理全文」和「AI 总结」。

> 提示：默认模型 `qwen2.5:3b-instruct` 在纯 CPU 上约 15-25 token/s；追求更好效果可在设置里换成 `qwen2.5:7b`（更慢）。
> 手机浏览器打开时（非 localhost）无法访问本机 Ollama，会自动退回本地规则整理。

## 发布

这是静态网页项目，可直接部署到 GitHub Pages、Netlify 或 Vercel（部署版不带本机 AI，AI 功能需通过 localhost 使用）。
