"use strict";

/* ============================================================
 * 会记 v2 — 会议记录 PWA
 * 纯前端：录音 / 实时转写 / 智能总结 / 本地保存(IndexedDB) / 导出
 * ============================================================ */

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = "huiji-settings-v2";
const DB_NAME = "huiji-db";
const DB_VERSION = 1;

/* ---------------- 状态 ---------------- */
const state = {
  recording: false,
  startedAt: 0,
  timer: null,
  mediaRecorder: null,
  mediaStream: null,
  recognition: null,
  chunks: [],
  audioBlob: null,
  audioUrl: "",
  transcript: [],            // [{speaker, text, time}]
  interimText: "",           // 实时未定稿文字
  currentId: null,           // 当前会议 id
  currentTitle: "",
  speakers: ["人物 1", "人物 2", "人物 3"],
  speakerIndex: 1,
  settings: { language: "zh-CN", autoSave: true, darkMode: null },
};

/* ---------------- 工具函数 ---------------- */
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const formatTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const formatDate = (d = new Date()) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
const formatClock = (d = new Date()) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------------- 深色模式 ---------------- */
function applyDark() {
  const pref = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = state.settings.darkMode === null ? pref : state.settings.darkMode;
  document.documentElement.classList.toggle("dark", dark);
  $("#darkToggle").textContent = dark ? "☀" : "☾";
}

/* ---------------- 设置 ---------------- */
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.settings = { ...state.settings, ...saved };
    state.speakers[0] = saved.defaultSpeaker || "人物 1";
  } catch {}
  $("#speakerNameInput").value = state.speakers[0];
  $("#languageSelect").value = state.settings.language;
  $("#autoSaveInput").checked = state.settings.autoSave;
  applyDark();
  updateSpeakerLabel();
}

function saveSettings() {
  state.speakers[0] = $("#speakerNameInput").value.trim() || "人物 1";
  state.settings = {
    language: $("#languageSelect").value,
    autoSave: $("#autoSaveInput").checked,
    darkMode: state.settings.darkMode,
    defaultSpeaker: state.speakers[0],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  updateSpeakerLabel();
}

/* ---------------- IndexedDB（会议 + 音频） ---------------- */
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meetings")) db.createObjectStore("meetings", { keyPath: "id" });
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idb(mode, store, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    const out = fn(s);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  }));
}

const dbGetAll = (store) => idb("readonly", store, (s) => s.getAll());
const dbGet = (store, key) => idb("readonly", store, (s) => s.get(key));
const dbPut = (store, val) => idb("readwrite", store, (s) => s.put(val));
const dbDel = (store, key) => idb("readwrite", store, (s) => s.delete(key));

async function listMeetings() {
  try {
    const all = await dbGetAll("meetings");
    return all.sort((a, b) => b.created - a.created);
  } catch { return []; }
}

async function getAudioBlob(id) {
  try { const row = await dbGet("audio", id); return row ? row.blob : null; } catch { return null; }
}

async function deleteMeeting(id) {
  await dbDel("meetings", id);
  await dbDel("audio", id);
}

/* 从旧版 localStorage 迁移历史（huiji-history-v1 → IndexedDB） */
function migrateOldHistory() {
  try {
    const raw = localStorage.getItem("huiji-history-v1");
    if (!raw) return;
    const old = JSON.parse(raw);
    if (!Array.isArray(old) || !old.length) return;
    dbGetAll("meetings").then((existing) => {
      if (existing.length) return; // 已有新数据，不重复迁移
      const jobs = old.map((item) => {
        const transcript = item.transcript || [];
        const date = item.date || formatDate();
        return dbPut("meetings", {
          id: item.id || uid(),
          title: item.title || `会议 · ${date}`,
          date,
          time: item.time || "",
          duration: item.duration || "",
          transcript,
          summary: item.summary || buildSummary(transcript),
          created: item.created || Date.now(),
        });
      });
      Promise.all(jobs).then(() => { localStorage.removeItem("huiji-history-v1"); renderHistory(); });
    }).catch(() => {});
  } catch {}
}

/* ============================================================
 * 断句（智能分句：终止标点 + 长句连接词切分）
 * ============================================================ */
const CONNECTORS = ["并且", "然后", "同时", "以及", "而且", "但是", "所以", "另外", "此外", "接着", "随后", "接下来", "最终", "其中"];

function smartChunk(part, maxLen = 60, minLen = 24) {
  const out = [];
  let rest = part;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    let cut = -1;
    for (const c of CONNECTORS) {
      const idx = window.lastIndexOf(c);
      if (idx >= minLen && idx + c.length > cut) cut = idx + c.length;
    }
    for (const p of ["，", "；", ",", ";"]) {
      const idx = window.lastIndexOf(p);
      if (idx >= minLen && idx + 1 > cut) cut = idx + 1;
    }
    if (cut <= 0) cut = maxLen; // 找不到分隔点就硬切
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function splitSentences(text) {
  if (!text) return [];
  const t = String(text).replace(/\s+/g, " ").trim();
  if (!t) return [];
  // 按终止标点切分（保留标点）
  const parts = t.split(/(?<=[。！？!?…])/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length > 60) out.push(...smartChunk(p));
    else out.push(p);
  }
  return out.filter((s) => s.length >= 2);
}

/* ============================================================
 * 智能总结（启发式：关键词 + 位置 + 动作项 + 负责人）
 * ============================================================ */
const MEETING_KEYWORDS = [
  "决定", "安排", "完成", "负责", "确认", "跟进", "截止", "提交", "整理", "落实", "推进",
  "方案", "问题", "风险", "目标", "时间", "预算", "计划", "下周", "本周", "明天", "周五",
  "讨论", "达成", "同意", "重点", "注意", "协调", "部署", "上线", "版本", "客户", "需求",
];
const ACTION_WORDS = ["需要", "负责", "完成", "确认", "安排", "跟进", "提交", "整理", "落实", "推进", "协调", "准备", "尽快", "务必", "记得"];
const SURNAMES = "王李张刘陈杨赵黄周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤";

function containsSurname(sentence) {
  for (const ch of sentence) if (SURNAMES.includes(ch)) return true;
  return false;
}

function scoreSentence(sentence, index, total) {
  let score = 0;
  for (const kw of MEETING_KEYWORDS) if (sentence.includes(kw)) score += 2;
  if (containsSurname(sentence)) score += 1;
  const n = sentence.length;
  if (n >= 10 && n <= 60) score += 2;
  else if (n >= 6) score += 1;
  if (index === 0) score += 3;
  if (index === total - 1) score += 2;
  return score;
}

function extractActions(sentences) {
  const actions = [];
  const seen = new Set();
  for (const s of sentences) {
    if (!ACTION_WORDS.some((w) => s.includes(w))) continue;
    let name = "";
    // ① 明确指派：由/让/请/交给 + 姓名 + 动作词
    let m = s.match(/(?:由|让|请|交给)([\u4e00-\u9fa5]{1,4})(?:负责|跟进|处理|完成|确认|落实|推进|协调)/);
    if (m) {
      name = m[1];
    } else {
      // ② 姓名 + 动作词（姓名必须以姓氏开头，避免"先确认"这类误判）
      m = s.match(/([\u4e00-\u9fa5]{1,4})(?:负责|跟进|处理|完成|落实|推进|协调)([^。！？!?]*)/);
      if (m && m[1] && SURNAMES.includes(m[1][0]) && !m[1].includes("确认")) name = m[1];
    }
    let label = s.replace(/\s+/g, " ").trim();
    if (name) label = label.replace(new RegExp(`由${name}`), "");
    if (label.length > 34) label = label.slice(0, 34) + "…";
    if (name) label = `${name}：${label}`;
    const key = label.slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(label);
  }
  return actions.slice(0, 5);
}

function buildSummary(transcript) {
  const text = transcript.map((i) => i.text).join(" ");
  if (!text.trim()) return { oneLine: "等待会议内容", actions: [], points: [], segments: [] };
  const sentences = splitSentences(text);
  const scored = sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s, i, sentences.length) }))
    .sort((a, b) => b.score - a.score);
  const points = [];
  const seen = new Set();
  for (const { s } of scored) {
    const key = s.slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(s);
    if (points.length >= 3) break;
  }
  const actions = extractActions(sentences);
  const first = sentences[0] || "";
  const oneLine = ((first.length <= 60 ? first : (points[0] || first)) || "会议内容已记录。").replace(/[。！？!?…]+$/, "") + "。";
  return { oneLine, actions, points, segments: sentences };
}

/* ---------------- 渲染 ---------------- */
function updateSpeakerLabel() {
  $("#activeSpeakerLabel").textContent = `当前：${state.speakers[state.speakerIndex - 1]}`;
}

function renderTranscript() {
  const list = $("#transcriptList");
  if (!state.transcript.length && !state.interimText) {
    list.innerHTML = '<div class="empty-transcript"><span class="empty-icon">◌</span><p>开始录音后，文字会实时显示在这里</p></div>';
    $("#speakerCount").textContent = "0 位发言人";
    return;
  }
  list.innerHTML = state.transcript.map((item, index) => `
    <article class="transcript-item">
      <button class="speaker-avatar ${item.color || ""}" data-index="${index}" title="点击切换发言人">${escapeHtml(item.speaker.slice(-1))}</button>
      <div class="transcript-body">
        <div class="speaker-meta">
          <button class="speaker-name speaker-edit" data-index="${index}">${escapeHtml(item.speaker)}</button>
          <span class="speaker-time">${escapeHtml(item.time)}</span>
        </div>
        <p class="transcript-text">${escapeHtml(item.text)}</p>
      </div>
    </article>
  `).join("") + (state.interimText
    ? `<article class="transcript-item interim"><span class="speaker-avatar interim-dot"></span><div class="transcript-body"><p class="transcript-text">${escapeHtml(state.interimText)}</p></div></article>`
    : "");
  $("#speakerCount").textContent = `${new Set(state.transcript.map((i) => i.speaker)).size} 位发言人`;
}

function renderSummary() {
  const s = buildSummary(state.transcript);
  $("#oneLineSummary").textContent = s.oneLine;
  $("#actionList").innerHTML = s.actions.length
    ? s.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")
    : '<li class="empty-state">暂无行动项</li>';
  $("#keyPoints").innerHTML = s.points.length
    ? s.points.map((p, i) => `<div class="key-point"><span class="point-number">0${i + 1}</span><span>${escapeHtml(p)}</span></div>`).join("")
    : '<div class="empty-state">录音结束后，这里会出现会议重点。</div>';
  $("#imageButton").disabled = !state.transcript.length;
  $("#exportButtons").hidden = !state.transcript.length;
}

/* ---------------- 录音 / 转写 ---------------- */
function updateRecordingUi() {
  $("#recordButton").classList.toggle("is-recording", state.recording);
  $("#recordButtonLabel").textContent = state.recording ? "结束录音" : "开始录音";
  $("#recordButton").setAttribute("aria-label", state.recording ? "结束录音" : "开始录音");
  $("#recordStatus").classList.toggle("recording", state.recording);
  $("#recordStatus").innerHTML = `<span></span>${state.recording ? "正在录音" : "待开始"}`;
  $("#waveform").classList.toggle("active", state.recording);
}

function setupSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  const rec = new SR();
  rec.lang = state.settings.language;
  rec.continuous = true;
  rec.interimResults = true;               // 实时转写
  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const r = event.results[i];
      if (r.isFinal) appendTranscript(r[0].transcript);
      else interim += r[0].transcript;
    }
    state.interimText = interim.trim();
    renderTranscript();
  };
  rec.onerror = (e) => {
    if (e.error === "no-speech") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      showToast("麦克风权限被拒绝，请在浏览器设置中允许");
    } else if (e.error === "network") {
      showToast("语音识别网络异常，录音仍会继续");
    } else {
      showToast("语音转写暂不可用，但录音仍会继续保存");
    }
  };
  rec.onend = () => {
    if (state.recording) {
      try { rec.start(); } catch {}
    }
  };
  state.recognition = rec;
  return true;
}

function appendTranscript(text) {
  const clean = text.trim();
  if (!clean) return;
  const speaker = state.speakers[state.speakerIndex - 1];
  state.transcript.push({
    speaker,
    initial: speaker.slice(-1),
    color: state.speakerIndex === 2 ? "orange" : state.speakerIndex === 3 ? "green" : "",
    text: clean,
    time: formatTime(Math.floor((Date.now() - state.startedAt) / 1000)),
  });
  renderTranscript();
  renderSummary();
}

async function startRecording() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showToast("手机录音需要通过 HTTPS 打开此网页");
    $("#recordHint").textContent = "当前地址不是 HTTPS，浏览器不会开放手机麦克风。";
    return;
  }
  if (!window.MediaRecorder) {
    showToast("当前浏览器不支持录音，请更换 Chrome 或 Safari");
    return;
  }
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.audioBlob = null;
    state.transcript = [];
    state.interimText = "";
    state.currentId = uid();
    state.currentTitle = `会议 · ${formatDate()} ${formatClock()}`;
    $("#meetingTitle").value = state.currentTitle;
    const recorder = new MediaRecorder(state.mediaStream);
    state.mediaRecorder = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size) state.chunks.push(e.data); };
    recorder.onstop = () => {
      state.audioBlob = new Blob(state.chunks, { type: recorder.mimeType || "audio/webm" });
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = URL.createObjectURL(state.audioBlob);
      $("#audioPreview").src = state.audioUrl;
      $("#audioDownload").href = state.audioUrl;
      $("#audioResult").hidden = false;
      saveCurrentMeeting();   // 音频就绪后再保存（含录音）
    };
    state.recording = true;
    state.startedAt = Date.now();
    renderTranscript();
    renderSummary();
    updateRecordingUi();
    state.timer = setInterval(() => { $("#recordTime").textContent = formatTime(Math.floor((Date.now() - state.startedAt) / 1000)); }, 1000);
    recorder.start();
    if (setupSpeechRecognition()) {
      try { state.recognition.start(); } catch {}
    } else {
      showToast("录音已开始，当前浏览器不支持实时转写");
    }
  } catch {
    state.recording = false;
    updateRecordingUi();
    showToast("没有获得麦克风权限，请在浏览器设置中允许访问");
  }
}

function meetingPayload() {
  const title = $("#meetingTitle").value.trim() || `会议 · ${formatDate()} ${formatClock()}`;
  return {
    id: state.currentId || uid(),
    title,
    date: formatDate(),
    time: formatClock(),
    duration: $("#recordTime").textContent,
    transcript: state.transcript,
    summary: buildSummary(state.transcript),
    created: Date.now(),
  };
}

function stopRecording() {
  state.recording = false;
  clearInterval(state.timer);
  state.interimText = "";
  if (state.recognition) {
    try { state.recognition.stop(); } catch {}
    state.recognition = null;
  }
  const dur = formatTime(Math.floor((Date.now() - state.startedAt) / 1000));
  $("#recordTime").textContent = dur;
  updateRecordingUi();
  renderTranscript();
  renderSummary();
  if (state.mediaRecorder?.state === "recording") state.mediaRecorder.stop();
  state.mediaStream?.getTracks().forEach((t) => t.stop());
  state.mediaStream = null;
  state.mediaRecorder = null;
  // 注意：保存逻辑在 recorder.onstop 回调里执行（音频 blob 就绪后）
}

function saveCurrentMeeting() {
  const payload = meetingPayload();
  if (state.audioBlob) {
    dbPut("audio", { id: payload.id, blob: state.audioBlob }).catch(() => {});
  }
  if (state.settings.autoSave && state.transcript.length) {
    dbPut("meetings", payload).then(() => { renderHistory(); showToast("录音、文字和会议重点已保存"); }).catch(() => {});
  } else if (!state.transcript.length) {
    showToast("录音已保存，但没有识别到文字，可手动添加记录");
  }
  state.currentId = null;
}

/* ---------------- 历史 ---------------- */
function renderHistory() {
  listMeetings().then((items) => {
    $("#historyList").innerHTML = items.length
      ? items.map((m) => `
          <button class="history-item" data-id="${m.id}">
            <strong>${escapeHtml(m.title || m.summary.oneLine)}</strong>
            <span>${escapeHtml(m.date)} ${escapeHtml(m.time)} · ${m.duration} · ${m.transcript.length} 条记录</span>
            <span class="history-actions">
              <span class="chip" data-action="detail">详情</span>
              <span class="chip" data-action="export">导出</span>
              <span class="chip danger" data-action="delete">删除</span>
            </span>
          </button>`).join("")
      : '<div class="empty-state history-empty">还没有保存的会议</div>';
  });
}

async function loadHistory(id) {
  const all = await listMeetings();
  const item = all.find((m) => String(m.id) === String(id));
  if (!item) return;
  state.transcript = item.transcript;
  state.interimText = "";
  $("#meetingTitle").value = item.title || `会议 · ${item.date}`;
  renderTranscript();
  renderSummary();
  $("#historyModal").hidden = true;
  showToast("已载入历史会议");
}

async function openHistoryDetail(id) {
  const all = await listMeetings();
  const m = all.find((x) => String(x.id) === String(id));
  if (!m) return;
  const s = m.summary || buildSummary(m.transcript || []);
  $("#detailTitle").textContent = m.title || `会议 · ${m.date}`;
  $("#detailMeta").textContent = `${m.date} ${m.time} · 时长 ${m.duration} · ${(m.transcript || []).length} 条`;
  $("#detailTranscript").innerHTML = (m.transcript || []).map((t) =>
    `<p><b>${escapeHtml(t.speaker)}</b> <span class="t-time">${escapeHtml(t.time)}</span><br>${escapeHtml(t.text)}</p>`).join("") || '<p class="empty-state">无文字记录</p>';
  $("#detailSummary").innerHTML = `<p class="detail-line">${escapeHtml(s.oneLine)}</p>` +
    (s.actions.length ? `<p class="detail-label">行动项</p><ul>${s.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : "") +
    (s.points.length ? `<p class="detail-label">关键内容</p><ol>${s.points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ol>` : "");
  const audio = await getAudioBlob(id);
  const ap = $("#detailAudioWrap");
  if (audio) {
    const url = URL.createObjectURL(audio);
    $("#detailAudio").src = url;
    $("#detailAudioDownload").href = url;
    $("#detailAudioDownload").download = `会记-${m.date.replace(/\//g, "-")}-${m.time.replace(/:/g, "-")}.webm`;
    ap.hidden = false;
    if ($("#detailAudio").dataset.url) URL.revokeObjectURL($("#detailAudio").dataset.url);
    $("#detailAudio").dataset.url = url;
  } else {
    ap.hidden = true;
  }
  $("#historyDetailModal").hidden = false;
  state.detailId = id;
}

function currentExportText() {
  const s = buildSummary(state.transcript);
  const lines = [
    `# ${$("#meetingTitle").value.trim() || "会议记录"}`,
    "",
    `日期：${formatDate()} ${formatClock()}`,
    "",
    "## 一句话总结",
    s.oneLine,
    "",
    "## 行动项",
    ...(s.actions.length ? s.actions.map((a) => `- ${a}`) : ["- 无"]),
    "",
    "## 关键内容",
    ...(s.points.length ? s.points.map((p, i) => `${i + 1}. ${p}`) : ["- 无"]),
    "",
    "## 完整记录",
    ...state.transcript.map((t) => `**${t.speaker}**（${t.time}）：${t.text}`),
  ];
  return lines.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportMeeting(format) {
  if (!state.transcript.length) { showToast("还没有可导出的内容"); return; }
  const base = ($("#meetingTitle").value.trim() || "会议记录").replace(/[\\/:*?"<>|]/g, "-");
  downloadText(`${base}.${format}`, currentExportText());
  showToast(`已导出 ${format.toUpperCase()} 文件`);
}

function exportHistoryItem(id, format) {
  listMeetings().then((all) => {
    const m = all.find((x) => String(x.id) === String(id));
    if (!m) return;
    const s = m.summary || buildSummary(m.transcript || []);
    const lines = [
      `# ${m.title || `会议 · ${m.date}`}`,
      "",
      `日期：${m.date} ${m.time} · 时长 ${m.duration}`,
      "",
      "## 一句话总结",
      s.oneLine,
      "",
      "## 行动项",
      ...(s.actions.length ? s.actions.map((a) => `- ${a}`) : ["- 无"]),
      "",
      "## 关键内容",
      ...(s.points.length ? s.points.map((p, i) => `${i + 1}. ${p}`) : ["- 无"]),
      "",
      "## 完整记录",
      ...(m.transcript || []).map((t) => `**${t.speaker}**（${t.time}）：${t.text}`),
    ];
    const base = (m.title || `会议-${m.date}`).replace(/[\\/:*?"<>|]/g, "-");
    downloadText(`${base}.${format}`, lines.join("\n"));
    showToast(`已导出 ${format.toUpperCase()} 文件`);
  });
}

/* ---------------- 分享图 ---------------- */
function drawShareImage() {
  const canvas = $("#shareCanvas");
  const ctx = canvas.getContext("2d");
  const s = buildSummary(state.transcript);
  const dark = document.documentElement.classList.contains("dark");
  ctx.fillStyle = dark ? "#16181d" : "#f7f8fa";
  ctx.fillRect(0, 0, 1080, 1350);
  ctx.fillStyle = "#315efb"; ctx.fillRect(0, 0, 1080, 16);
  ctx.fillStyle = dark ? "#e8eaf0" : "#202631";
  ctx.font = "bold 56px Arial"; ctx.fillText("会议重点", 80, 140);
  ctx.fillStyle = "#88909b"; ctx.font = "26px Arial"; ctx.fillText("MEETING NOTES", 80, 185);
  ctx.fillStyle = "#e9efff"; ctx.fillRect(65, 245, 950, 220);
  ctx.fillStyle = "#88909b"; ctx.font = "bold 25px Arial"; ctx.fillText("一句话总结", 100, 305);
  ctx.fillStyle = "#274bd1"; ctx.font = "bold 36px Arial";
  wrapText(ctx, s.oneLine, 100, 360, 860, 44, 2);
  ctx.fillStyle = dark ? "#e8eaf0" : "#202631"; ctx.font = "bold 32px Arial"; ctx.fillText("关键内容", 80, 560);
  (s.points.length ? s.points : [s.oneLine]).slice(0, 4).forEach((point, i) => {
    const y = 660 + i * 135;
    ctx.fillStyle = "#ff8a5b"; ctx.font = "bold 27px Arial"; ctx.fillText(`0${i + 1}`, 82, y);
    ctx.fillStyle = "#4e5662"; ctx.font = "26px Arial";
    wrapText(ctx, point, 145, y, 860, 34, 2);
    ctx.strokeStyle = "#e5e8ed"; ctx.beginPath(); ctx.moveTo(80, y + 60); ctx.lineTo(1000, y + 60); ctx.stroke();
  });
  ctx.fillStyle = "#88909b"; ctx.font = "24px Arial"; ctx.fillText("由 会记 整理", 80, 1260);
  $("#downloadImageButton").href = canvas.toDataURL("image/png");
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const chars = String(text).split("");
  let line = "", lineCount = 0;
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = ch; y += lineHeight; lineCount++;
      if (lineCount >= maxLines) { ctx.fillText("…", x + ctx.measureText(line).width, y); return; }
    } else line = test;
  }
  if (line) ctx.fillText(line, x, y);
}

/* ---------------- Modal ---------------- */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

/* ---------------- 事件绑定 ---------------- */
$("#recordButton").addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));

$("#speakerButton").addEventListener("click", () => {
  state.speakerIndex = state.speakerIndex % state.speakers.length + 1;
  updateSpeakerLabel();
  showToast(`已切换到${state.speakers[state.speakerIndex - 1]}`);
});

$("#transcriptList").addEventListener("click", (event) => {
  const avatar = event.target.closest(".speaker-avatar[data-index]");
  if (avatar) {
    const i = Number(avatar.dataset.index);
    const item = state.transcript[i];
    if (!item) return;
    const cur = state.speakers.indexOf(item.speaker);
    const next = state.speakers[(cur + 1) % state.speakers.length];
    item.speaker = next;
    item.initial = next.slice(-1);
    item.color = next === state.speakers[1] ? "orange" : next === state.speakers[2] ? "green" : "";
    renderTranscript(); renderSummary();
    return;
  }
  const edit = event.target.closest(".speaker-edit");
  if (!edit) return;
  const index = Number(edit.dataset.index);
  const next = window.prompt("修改发言人名称", state.transcript[index].speaker);
  if (!next?.trim()) return;
  state.transcript[index].speaker = next.trim();
  state.transcript[index].initial = next.trim().slice(-1);
  renderTranscript(); renderSummary();
});

function copyText(text, msg) {
  navigator.clipboard?.writeText(text).then(() => showToast(msg)).catch(() => showToast("当前浏览器不支持自动复制，请长按选择文字"));
}

$("#copySummaryButton").addEventListener("click", () => {
  const s = buildSummary(state.transcript);
  const text = ["会议重点", "", `一句话总结：${s.oneLine}`, "", "行动项：", ...s.actions.map((a) => `• ${a}`), "", "关键内容：", ...s.points.map((p) => `• ${p}`)].join("\n");
  copyText(text, "会议重点已复制");
});

$("#copyTranscriptButton").addEventListener("click", () => {
  copyText(state.transcript.map((i) => `${i.speaker}：${i.text}`).join("\n") || "暂无文字记录", "文字记录已复制");
});

$("#imageButton").addEventListener("click", () => { drawShareImage(); openModal("#imageModal"); });
$("#closeModalButton").addEventListener("click", () => closeModal("#imageModal"));
$("#clearButton").addEventListener("click", () => {
  if (state.recording) return;
  state.transcript = [];
  state.interimText = "";
  $("#recordTime").textContent = "00:00";
  $("#audioResult").hidden = true;
  renderTranscript(); renderSummary();
  showToast("已清空本次记录");
});
$("#historyButton").addEventListener("click", () => { renderHistory(); openModal("#historyModal"); });
$("#historyList").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  const itemEl = event.target.closest(".history-item");
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  if (chip) {
    const action = chip.dataset.action;
    if (action === "detail") openHistoryDetail(id);
    else if (action === "export") exportHistoryItem(id, "md");
    else if (action === "delete") { if (window.confirm("确定删除这条会议记录（含录音）？")) deleteMeeting(id).then(() => renderHistory()); }
    return;
  }
  loadHistory(id);
});
$("#settingsButton").addEventListener("click", () => openModal("#settingsModal"));
$("#saveSettingsButton").addEventListener("click", () => { saveSettings(); closeModal("#settingsModal"); showToast("设置已保存"); });
$("#darkToggle").addEventListener("click", () => {
  state.settings.darkMode = document.documentElement.classList.contains("dark") ? false : true;
  applyDark();
  saveSettings();
});
document.querySelectorAll(".close-sheet").forEach((b) => b.addEventListener("click", () => b.closest(".modal-backdrop").hidden = true));
document.querySelectorAll(".modal-backdrop").forEach((b) => b.addEventListener("click", (e) => { if (e.target === b) b.hidden = true; }));

// 导出
$("#exportMdButton").addEventListener("click", () => exportMeeting("md"));
$("#exportTxtButton").addEventListener("click", () => exportMeeting("txt"));

// 历史详情
$("#detailExportMd").addEventListener("click", () => { if (state.detailId) exportHistoryItem(state.detailId, "md"); });
$("#detailExportTxt").addEventListener("click", () => { if (state.detailId) exportHistoryItem(state.detailId, "txt"); });
$("#detailDelete").addEventListener("click", async () => {
  if (!state.detailId) return;
  if (!window.confirm("确定删除这条会议记录（含录音）？")) return;
  await deleteMeeting(state.detailId);
  closeModal("#historyDetailModal");
  renderHistory();
  showToast("已删除");
});
$("#detailClose").addEventListener("click", () => closeModal("#historyDetailModal"));
$("#detailLoad").addEventListener("click", () => { if (state.detailId) loadHistory(state.detailId); });

/* ---------------- PWA 安装 ---------------- */
let deferredInstallPrompt;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("#installButton").hidden = false;
});
$("#installButton").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  await deferredInstallPrompt.prompt();
  deferredInstallPrompt = null;
  $("#installButton").hidden = true;
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
}

/* ---------------- 录音中离开页面提醒 ---------------- */
window.addEventListener("beforeunload", (e) => {
  if (state.recording) {
    e.preventDefault();
    e.returnValue = "";
    return "";
  }
});

/* ---------------- 初始化 ---------------- */
const now = new Date();
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
$("#dateStamp").innerHTML = `${now.getFullYear()} / ${String(now.getMonth() + 1).padStart(2, "0")} / ${String(now.getDate()).padStart(2, "0")}<br>星期${weekdays[now.getDay()]}`;
$("#meetingTitle").value = `会议 · ${formatDate()} ${formatClock()}`;
loadSettings();
renderTranscript();
renderSummary();
renderHistory();
migrateOldHistory();
