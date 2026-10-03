#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
会记 v4 后端（单端口 8000）：
  1. 静态站点：提供 PWA 前端
  2. POST /api/transcribe  精准转写（FunASR + CAM++ 说话人分离，异步任务）
  3. GET  /api/transcribe/<job>  轮询任务结果
  4. GET  /api/tags / POST /api/chat  Ollama 代理（手机端经隧道也能用本机 AI）
  5. GET  /api/health  健康检查

转写脚本来自 audio-transcribe skill（FunASR SeACo-Paraformer + FSMN VAD + CAM++）。
模型缓存重定向到工作区 asr-models/，首次调用会自动下载。
"""
import http.client
import json
import os
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

BASE = Path(__file__).resolve().parent
JOBS_DIR = BASE / ".asr-jobs"
MODEL_CACHE = BASE / "asr-models"
SCRIPTS_DIR = BASE / "asr-scripts"
VENV_PY = BASE / "asr-venv" / "bin" / "python"
OLLAMA = ("127.0.0.1", 11434)
FFMPEG_DIR = str(Path.home() / "bin")  # ffmpeg 所在目录

JOBS_DIR.mkdir(exist_ok=True)
MODEL_CACHE.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=None)
JOBS = {}          # job_id -> dict
JOB_QUEUE = queue.Queue()


# ---------------- CORS ----------------
@app.after_request
def add_cors(resp):
    if request.path.startswith("/api/"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/api/", methods=["OPTIONS"])
@app.route("/api/<path:rest>", methods=["OPTIONS"])
def api_options(rest=""):
    return ("", 204)


# ---------------- 静态站点 ----------------
MIME_OVERRIDES = {
    ".webmanifest": "application/manifest+json",
    ".webm": "audio/webm",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
}


@app.route("/")
def index():
    return send_from_directory(BASE, "index.html")


@app.route("/<path:name>")
def static_files(name):
    ext = Path(name).suffix
    mime = MIME_OVERRIDES.get(ext)
    return send_from_directory(BASE, name, mimetype=mime)


# ---------------- Ollama 代理 ----------------
def proxy_ollama(method, path, body_bytes=None, timeout=600):
    conn = http.client.HTTPConnection(*OLLAMA, timeout=timeout)
    headers = {}
    if body_bytes is not None:
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=body_bytes, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


@app.route("/api/tags", methods=["GET"])
def ollama_tags():
    try:
        status, data = proxy_ollama("GET", "/api/tags", timeout=10)
        if status != 200:
            return jsonify({"error": f"ollama {status}"}), 502
        return Response(data, mimetype="application/json")
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"ollama unreachable: {e}"}), 502


@app.route("/api/chat", methods=["POST"])
def ollama_chat():
    raw = request.get_data()
    try:
        body = json.loads(raw)
    except Exception:  # noqa: BLE001
        return jsonify({"error": "bad json"}), 400
    stream = bool(body.get("stream"))
    try:
        status, data = proxy_ollama("POST", "/api/chat", raw, timeout=600)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"ollama unreachable: {e}"}), 502
    if stream:
        def gen():
            # 简单转发：一次读回全部再按行吐出（Ollama 非流式时也兼容）
            for line in data.decode("utf-8", "replace").splitlines():
                yield line + "\n"
        return Response(gen(), mimetype="application/x-ndjson")
    return Response(data, mimetype="application/json")


# ---------------- 精准转写（异步任务） ----------------
@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"error": "缺少音频文件字段 file"}), 400
    lang = request.form.get("lang", "zh")
    ns = request.form.get("num_speakers", "").strip()
    hotwords = request.form.get("hotwords", "").strip()
    correct = request.form.get("correct", "").strip() in ("1", "true", "on")
    if lang not in ("zh", "zh-basic"):
        lang = "zh"
    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir()
    ext = Path(f.filename).suffix.lower() or ".webm"
    audio_path = job_dir / ("input" + ext)
    f.save(audio_path)
    JOBS[job_id] = {
        "id": job_id,
        "status": "queued",
        "segments": None,
        "speakers": 0,
        "error": None,
        "progress": "排队中…",
        "created": time.time(),
        "lang": lang,
        "num_speakers": int(ns) if ns.isdigit() and 1 <= int(ns) <= 12 else None,
        "correct": correct,
    }
    if hotwords:
        (job_dir / "hotwords.txt").write_text(hotwords.replace(",", "\n"), encoding="utf-8")
    JOB_QUEUE.put(job_id)
    return jsonify({"job_id": job_id})


@app.route("/api/transcribe/<job_id>", methods=["GET"])
def transcribe_status(job_id):
    j = JOBS.get(job_id)
    if not j:
        return jsonify({"error": "job not found"}), 404
    return jsonify({
        "status": j["status"],
        "progress": j.get("progress", ""),
        "segments": j.get("segments"),
        "speakers": j.get("speakers"),
        "error": j.get("error"),
    })


def normalize_segments(transcript):
    """把 raw transcript（speaker 为聚类 id）重编号为按首现顺序的 1..K"""
    order = {}
    out = []
    for s in transcript:
        spk = s.get("speaker", 0)
        if spk not in order:
            order[spk] = len(order) + 1
        out.append({
            "speaker": order[spk],
            "start_ms": int(s.get("start_ms", 0)),
            "end_ms": int(s.get("end_ms", 0)),
            "text": s.get("text", "").strip(),
        })
    return out


def ollama_chat_sync(messages, timeout=240):
    """调用本机 Ollama（OpenAI 兼容）"""
    import urllib.request
    body = json.dumps({
        "model": "qwen2.5:3b-instruct",
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 2048},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"http://{OLLAMA[0]}:{OLLAMA[1]}/api/chat", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (data.get("message") or {}).get("content", "")


def correct_segments(segments, model_ok):
    """可选：用本机 qwen 修正每段同音字错误（保留说话人/时间戳结构）。
    批量每 4 段一次调用；Ollama 不可用时原样返回。"""
    if not model_ok or not segments:
        return segments
    out = []
    BATCH = 4
    for i in range(0, len(segments), BATCH):
        batch = segments[i:i + BATCH]
        items = "\n".join(f"{k}: {s['text']}" for k, s in enumerate(batch))
        prompt = (
            "你是中文语音转写校对助手。下面是语音识别出来的句子（可能有个别同音字错误，"
            "如「会以」应为「会议」、「得上现」应为「的上线」）。请只修正错别字，"
            "不要改写、增删内容、不要加标点以外的修改。只输出 JSON（不要代码块）："
            '{"0": "修正后的句子", "1": "修正后的句子", ...}\n\n'
            f"句子：\n{items}"
        )
        try:
            raw = ollama_chat_sync([{"role": "user", "content": prompt}])
            fixed = {}
            start = raw.find("{")
            end = raw.rfind("}")
            if start >= 0 and end > start:
                parsed = json.loads(raw[start:end + 1])
                if isinstance(parsed, dict):
                    fixed = {str(k): str(v).strip() for k, v in parsed.items() if str(v).strip()}
            for k, s in enumerate(batch):
                t = fixed.get(str(k))
                s["text"] = t if t else s["text"]
                out.append(s)
        except Exception as e:  # noqa: BLE001
            print(f"  [correct] batch {i} failed: {e}")
            out.extend(batch)
    return out


def run_job(job_id):
    j = JOBS[job_id]
    job_dir = JOBS_DIR / job_id
    audio = next(job_dir.glob("input.*"))
    raw_json = job_dir / "raw.json"
    log_path = job_dir / "out.log"

    cmd = [
        str(VENV_PY), str(SCRIPTS_DIR / "transcribe.py"),
        str(audio),
        "--lang", j["lang"],
        "--no-detect-gender",
        "--model-cache-dir", str(MODEL_CACHE),
        "--json-out", str(raw_json),
    ]
    if j["num_speakers"]:
        cmd += ["--num-speakers", str(j["num_speakers"])]
    hotwords_file = job_dir / "hotwords.txt"
    if hotwords_file.exists():
        cmd += ["--hotwords", str(hotwords_file)]

    env = dict(os.environ)
    env["PATH"] = FFMPEG_DIR + os.pathsep + env.get("PATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    env["MODELSCOPE_CACHE"] = str(MODEL_CACHE)

    j["status"] = "running"
    j["progress"] = "准备模型（首次会下载，需几分钟）…"
    try:
        with open(log_path, "wb") as logf:
            proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=str(job_dir))
            # 轻量进度跟踪：读日志尾
            while proc.poll() is None:
                tail = log_tail(log_path)
                if tail:
                    j["progress"] = tail
                time.sleep(2)
            proc.wait()
        if proc.returncode != 0:
            j["status"] = "error"
            j["error"] = (log_tail(log_path) or "转写失败")[-500:]
            return
        if not raw_json.exists():
            j["status"] = "error"
            j["error"] = "没有生成转写结果"
            return
        segments = normalize_segments(json.loads(raw_json.read_text(encoding="utf-8")))
        if j["correct"] and segments:
            j["progress"] = "AI 校对错别字…"
            try:
                _, data = proxy_ollama("GET", "/api/tags", timeout=10)
                segments = correct_segments(segments, True)
            except Exception:  # noqa: BLE001
                pass
        j["segments"] = segments
        j["speakers"] = len({s["speaker"] for s in segments}) if segments else 0
        j["status"] = "done"
    except Exception as e:  # noqa: BLE001
        j["status"] = "error"
        j["error"] = str(e)[-500:]


def log_tail(log_path, n=6):
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-n:]).strip()
    except Exception:  # noqa: BLE001
        return ""


def worker():
    while True:
        job_id = JOB_QUEUE.get()
        try:
            run_job(job_id)
        except Exception as e:  # noqa: BLE001
            j = JOBS.get(job_id)
            if j:
                j["status"] = "error"
                j["error"] = str(e)[-500:]


@app.route("/api/health", methods=["GET"])
def health():
    ollama_ok = False
    try:
        status, _ = proxy_ollama("GET", "/api/tags", timeout=5)
        ollama_ok = status == 200
    except Exception:  # noqa: BLE001
        pass
    return jsonify({"ok": True, "ollama": ollama_ok, "jobs": JOB_QUEUE.qsize()})


if __name__ == "__main__":
    threading.Thread(target=worker, daemon=True).start()
    print(f"会记 v4 后端启动: http://127.0.0.1:8000  (venv: {VENV_PY.name})")
    app.run(host="127.0.0.1", port=8000, threaded=True)
