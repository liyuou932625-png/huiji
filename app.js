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
  fullText: "",              // 整理后的完整文字（带标点）
  aiSummary: null,           // AI 生成的总结 {oneLine, actions, points, source:"ai"}
  currentId: null,           // 当前会议 id
  currentTitle: "",
  speakers: ["人物 1", "人物 2", "人物 3"],
  speakerIndex: 1,
  settings: { language: "zh-CN", autoSave: true, darkMode: null, aiUrl: "http://localhost:11434", aiModel: "qwen2.5:3b-instruct", aiAuto: true },
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
  $("#aiUrlInput").value = state.settings.aiUrl;
  $("#aiModelInput").value = state.settings.aiModel;
  $("#aiAutoInput").checked = state.settings.aiAuto;
  ai.url = state.settings.aiUrl;
  ai.model = state.settings.aiModel;
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
    aiUrl: $("#aiUrlInput").value.trim() || "http://localhost:11434",
    aiModel: $("#aiModelInput").value.trim() || ai.model,
    aiAuto: $("#aiAutoInput").checked,
  };
  ai.url = state.settings.aiUrl;
  ai.model = state.settings.aiModel;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  updateSpeakerLabel();
  updateAiUi();
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
 * 全文整理（断句/加标点）：AI 优先，规则兜底
 * ============================================================ */
function rawFullText() {
  return state.transcript.map((t) => t.text).filter(Boolean).join(" ");
}

/* 规则兜底：连接词后加逗号 + 按长度分句加句号（无 AI 时用） */
function fallbackPunctuate(text) {
  let t = String(text).replace(/\s+/g, " ").trim();
  if (!t) return "";
  for (const c of CONNECTORS) t = t.split(c).join(`${c}，`);
  t = t.replace(/，+/g, "，").replace(/，\s*$/g, "");
  const sentences = [];
  let rest = t;
  while (rest.length > 46) {
    const window = rest.slice(0, 46);
    let cut = -1;
    for (const p of ["，", ",", "；", ";"]) {
      const i = window.lastIndexOf(p);
      if (i > 24 && i + 1 > cut) cut = i + 1;
    }
    if (cut <= 0) cut = 46;
    sentences.push(rest.slice(0, cut).replace(/[,，;；\s]+$/, ""));
    rest = rest.slice(cut).trim();
  }
  if (rest) sentences.push(rest);
  return sentences.map((s) => s.replace(/[,，;；\s]+$/, "") + "。").join("\n");
}

/* 把长文本按标点切成不超过 maxChars 的块 */
function chunkText(text, maxChars) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = window.lastIndexOf("。");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf("？");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf("！");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf("；");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf("，");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf(" ");
    if (cut < maxChars * 0.4) cut = maxChars;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function ensureFullText() {
  if (!state.fullText) state.fullText = fallbackPunctuate(rawFullText());
  return state.fullText;
}

/* ============================================================
 * 本地 AI（Ollama，本机算力）
 * ============================================================ */
const ai = { url: "http://localhost:11434", model: "qwen2.5:3b-instruct", available: false, checking: false, busy: false, busyLabel: "" };

async function llmFetch(path, body, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ai.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function llmChat(prompt, { timeoutMs = 240000, temperature = 0.3, numPredict = 2048 } = {}) {
  const data = await llmFetch("/api/chat", {
    model: ai.model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    options: { temperature, num_predict: numPredict },
  }, timeoutMs);
  return (data.message && data.message.content) || "";
}

/* 从模型输出里提取 JSON（容忍代码块包裹和多余文字） */
function extractJson(text) {
  const t = String(text).replace(/```json|```/g, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/* 检测 Ollama 是否可用，并刷新模型下拉 */
async function checkAi() {
  ai.checking = true;
  updateAiUi();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(ai.url + "/api/tags", { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    ai.available = true;
    const models = (data.models || []).map((m) => m.name).sort();
    const list = $("#aiModelList");
    list.innerHTML = models.map((name) => `<option value="${escapeHtml(name)}">`).join("");
    const input = $("#aiModelInput");
    if (!input.value.trim()) input.value = models[0] || ai.model;
  } catch {
    ai.available = false;
  } finally {
    clearTimeout(timer);
    ai.checking = false;
    updateAiUi();
  }
}

function updateAiUi() {
  const chip = $("#aiStatus");
  const line = $("#aiStatusLine");
  const stateName = ai.checking ? "busy" : (ai.available ? "on" : "off");
  const label = ai.checking ? "AI 检测中…" : ai.busy ? (ai.busyLabel || "AI 处理中…") : ai.available ? "AI 已连接" : "AI 未连接";
  if (chip) { chip.textContent = label; chip.className = `ai-status-chip ${stateName}`; }
  if (line) { line.textContent = label; line.className = `ai-status ${stateName}`; }
  const sumBtn = $("#aiSummaryButton");
  if (sumBtn) { sumBtn.disabled = ai.busy || !ai.available || !state.transcript.length; sumBtn.textContent = ai.busy && ai.busyLabel ? ai.busyLabel : "AI 总结"; }
  const punBtn = $("#aiPunctuateButton");
  if (punBtn) punBtn.disabled = ai.busy || !state.transcript.length;
}

function setAiBusy(busy, label) {
  ai.busy = busy;
  ai.busyLabel = label || "";
  updateAiUi();
}

/* AI 断句：为转写文本加标点、去口语填充词 */
async function aiPunctuate(text) {
  const prompt = `你是中文文本整理助手。下面是一段语音转写的中文口语文本，没有标点。请只做三件事：\n1. 加上合适的标点（逗号、句号、问号等），并按语义分段（每段不超过约 100 字，段与段之间用一个换行分隔）；\n2. 删掉无意义的重复口语填充词（如"嗯""啊""呃""那个""就是说""然后呢"这类），**句首的"那个""嗯""啊"直接删掉，不要保留**；\n3. 删掉明显重复的句子（同一句话说了两遍的只保留一遍）。\n除此之外不要改写、合并、增删任何内容，不要输出任何解释或开头语，只输出整理后的文本。\n\n转写文本：\n${text}`;
  const out = await llmChat(prompt, { timeoutMs: 300000, temperature: 0.2, numPredict: 8192 });
  const cleaned = String(out).trim();
  return cleaned || fallbackPunctuate(text);
}

/* 对全部转写做断句整理 */
async function aiPunctuateFull({ silent = false } = {}) {
  const raw = rawFullText();
  if (!raw.trim()) { showToast("还没有文字内容"); return; }
  setAiBusy(true, "AI 整理全文…");
  try {
    const parts = chunkText(raw, 4000);
    const results = [];
    for (const part of parts) results.push(await aiPunctuate(part));
    state.fullText = results.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    renderFullText();
    if (state.currentId) persistMeeting();
    if (!silent) showToast("全文已整理（AI）");
  } catch (e) {
    state.fullText = fallbackPunctuate(raw);
    renderFullText();
    showToast("AI 整理失败，已退回规则整理");
  } finally {
    setAiBusy(false);
  }
}

/* AI 总结（短文本一次调用） */
async function aiSummarizeShort(raw) {
  const prompt = `你是专业的会议记录助手。下面是会议转写文本（包含口语和重复内容）。请用**简洁通俗的话**总结会议，要求：\n1. 用自己的话概括，**不要照搬原文句子**；\n2. 只输出一个 JSON 对象（不要代码块、不要解释）：\n{"oneLine": "一句话总结，30 字以内", "points": ["重点1", "重点2", "重点3"], "actions": ["行动项1", "行动项2"]}\n其中 points 给 3-5 条最重要的结论/决定/信息，每条 15-60 字；actions 列出明确的待办事项并尽量带负责人和时间，没有则为空数组。\n\n会议转写：\n${raw}`;
  const out = await llmChat(prompt, { timeoutMs: 300000, temperature: 0.3, numPredict: 2048 });
  return extractJson(out);
}

/* AI 总结（长文本：分块提炼要点后合并） */
async function aiSummarizeLong(raw) {
  const parts = chunkText(raw, 5000);
  const points = [];
  for (const part of parts) {
    const p = `下面是一段会议转写。请提取最重要的 3-5 条信息要点，用简洁的话概括，**不要照搬原文**。只输出 JSON（不要代码块）：{"points": ["要点1", "要点2"]}\n\n转写：\n${part}`;
    const out = await llmChat(p, { timeoutMs: 240000, temperature: 0.3, numPredict: 1536 });
    const parsed = extractJson(out);
    if (parsed && Array.isArray(parsed.points)) points.push(...parsed.points.map(String));
  }
  const merged = [...new Set(points)].slice(0, 12).join("\n");
  const p2 = `下面是会议各部分的要点。请综合成一份最终总结，用简洁通俗的话，**不要照搬**。只输出 JSON（不要代码块）：{"oneLine": "一句话总结，30 字以内", "points": ["重点1", "重点2", "重点3"], "actions": ["行动项1", "行动项2"]}\npoints 给 3-5 条，每条 15-60 字；actions 给明确的待办事项并尽量带负责人和时间，没有则为空数组。\n\n各段要点：\n${merged}`;
  const out = await llmChat(p2, { timeoutMs: 240000, temperature: 0.3, numPredict: 2048 });
  return extractJson(out);
}

/* 用 AI 生成会议重点总结（不照搬原文） */
async function aiSummarize({ silent = false } = {}) {
  if (!state.transcript.length) { showToast("还没有文字内容"); return; }
  if (!ai.available) { showToast("本地 AI 未连接，请先到设置里「检测 AI」"); return; }
  setAiBusy(true, "AI 总结中…");
  try {
    const raw = state.fullText || rawFullText();
    const parsed = raw.length > 6000 ? await aiSummarizeLong(raw) : await aiSummarizeShort(raw);
    if (!parsed || !parsed.oneLine) throw new Error("AI 返回格式不对");
    state.aiSummary = {
      oneLine: String(parsed.oneLine).trim(),
      points: (parsed.points || []).map(String).filter(Boolean).slice(0, 5),
      actions: (parsed.actions || []).map(String).filter(Boolean).slice(0, 5),
      source: "ai",
    };
    renderSummary();
    if (state.currentId) persistMeeting();
    if (!silent) showToast("AI 总结已生成并保存");
  } catch (e) {
    showToast("AI 总结失败：" + (e.message || "未知错误"));
  } finally {
    setAiBusy(false);
  }
}

/* 录音结束后自动整理全文 + 生成总结 */
function maybeAutoAi() {
  if (!state.settings.aiAuto || ai.busy || !state.transcript.length) return;
  if (!ai.available) {
    showToast("本机 AI 未连接，已用规则整理；设置里可「检测 AI」");
    state.fullText = fallbackPunctuate(rawFullText());
    renderFullText();
    return;
  }
  (async () => {
    await aiPunctuateFull({ silent: true });
    await aiSummarize({ silent: true });
    showToast("AI 已整理全文并生成总结");
  })();
}

/* 当前展示的总结（AI 优先，否则启发式兜底） */
function getSummary() {
  if (state.aiSummary) return state.aiSummary;
  return { ...buildSummary(state.transcript), source: "heuristic" };
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
  const s = getSummary();
  $("#oneLineSummary").textContent = s.oneLine;
  $("#actionList").innerHTML = s.actions.length
    ? s.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")
    : '<li class="empty-state">暂无行动项</li>';
  $("#keyPoints").innerHTML = s.points.length
    ? s.points.map((p, i) => `<div class="key-point"><span class="point-number">0${i + 1}</span><span>${escapeHtml(p)}</span></div>`).join("")
    : '<div class="empty-state">录音结束后，这里会出现会议重点。</div>';
  $("#aiBadge").hidden = s.source !== "ai";
  $("#imageButton").disabled = !state.transcript.length;
  $("#exportButtons").hidden = !state.transcript.length;
}

function renderFullText() {
  const block = $("#fullTextBlock");
  const text = (state.fullText || "").trim();
  if (text) {
    block.textContent = text;
    block.classList.remove("empty");
  } else {
    block.textContent = "还没有整理后的全文。录音结束后点「AI 整理全文」：自动加标点、去口语填充词；本机没接 AI 时用规则整理。";
    block.classList.add("empty");
  }
  $("#copyFullTextButton").disabled = !text;
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
  // 转写变化后，AI 总结作废，回到实时（启发式）展示
  state.aiSummary = null;
  // 录音中实时用规则整理全文（AI 整理只在停止后/手动触发）
  if (!ai.busy) state.fullText = fallbackPunctuate(rawFullText());
  renderTranscript();
  renderFullText();
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
    state.fullText = "";
    state.aiSummary = null;
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
      maybeAutoAi();          // 录音结束自动整理全文 + AI 总结
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
  const s = getSummary();
  return {
    id: state.currentId || uid(),
    title,
    date: formatDate(),
    time: formatClock(),
    duration: $("#recordTime").textContent,
    transcript: state.transcript,
    fullText: (state.fullText || "").trim(),
    summary: { oneLine: s.oneLine, actions: s.actions, points: s.points, source: s.source },
    created: Date.now(),
  };
}

/* 把当前会议写入 IndexedDB（不改变 currentId，供 AI 整理后更新同一条记录） */
function persistMeeting() {
  if (!state.transcript.length) return Promise.resolve(false);
  const payload = meetingPayload();
  if (state.audioBlob) dbPut("audio", { id: payload.id, blob: state.audioBlob }).catch(() => {});
  return dbPut("meetings", payload).then(() => true).catch(() => false);
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
  // 保留 currentId：之后 AI 整理/总结会更新同一条记录，避免重复
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
  state.transcript = item.transcript || [];
  state.interimText = "";
  state.fullText = (item.fullText || "").trim() || fallbackPunctuate(rawFullText());
  state.aiSummary = (item.summary && item.summary.source === "ai")
    ? { ...item.summary }
    : null;
  state.currentId = String(item.id);
  $("#meetingTitle").value = item.title || `会议 · ${item.date}`;
  renderTranscript();
  renderFullText();
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
  const fullText = (m.fullText || "").trim() || fallbackPunctuate((m.transcript || []).map((t) => t.text).join(" "));
  $("#detailFullText").innerHTML = fullText
    ? `<p style="white-space:pre-wrap">${escapeHtml(fullText)}</p>`
    : '<p class="empty-state">无</p>';
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
  const s = getSummary();
  const fullText = (state.fullText || "").trim();
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
  ];
  if (fullText) {
    lines.push("", "## 完整记录（整理后）", "", fullText, "");
  }
  lines.push("", "## 逐条记录");
  lines.push(...state.transcript.map((t) => `**${t.speaker}**（${t.time}）：${t.text}`));
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
    const fullText = (m.fullText || "").trim() || fallbackPunctuate((m.transcript || []).map((t) => t.text).join(" "));
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
    ];
    if (fullText) {
      lines.push("", "## 完整记录（整理后）", "", fullText, "");
    }
    lines.push("", "## 逐条记录");
    lines.push(...(m.transcript || []).map((t) => `**${t.speaker}**（${t.time}）：${t.text}`));
    const base = (m.title || `会议-${m.date}`).replace(/[\\/:*?"<>|]/g, "-");
    downloadText(`${base}.${format}`, lines.join("\n"));
    showToast(`已导出 ${format.toUpperCase()} 文件`);
  });
}

/* ---------------- 分享图 ---------------- */
function drawShareImage() {
  const canvas = $("#shareCanvas");
  const ctx = canvas.getContext("2d");
  const s = getSummary();
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
  const s = getSummary();
  const text = ["会议重点", "", `一句话总结：${s.oneLine}`, "", "行动项：", ...s.actions.map((a) => `• ${a}`), "", "关键内容：", ...s.points.map((p) => `• ${p}`)].join("\n");
  copyText(text, "会议重点已复制");
});

$("#copyTranscriptButton").addEventListener("click", () => {
  copyText(state.transcript.map((i) => `${i.speaker}：${i.text}`).join("\n") || "暂无文字记录", "逐条记录已复制");
});

$("#copyFullTextButton").addEventListener("click", () => {
  copyText(ensureFullText() || "暂无文字记录", "全文已复制");
});

$("#aiSummaryButton").addEventListener("click", () => aiSummarize());
$("#aiPunctuateButton").addEventListener("click", () => aiPunctuateFull());
$("#aiCheckButton").addEventListener("click", async () => {
  ai.url = $("#aiUrlInput").value.trim() || "http://localhost:11434";
  await checkAi();
  showToast(ai.available ? `AI 已连接（${ai.model}）` : "未检测到 Ollama，请确认已启动");
});

$("#imageButton").addEventListener("click", () => { drawShareImage(); openModal("#imageModal"); });
$("#closeModalButton").addEventListener("click", () => closeModal("#imageModal"));
$("#clearButton").addEventListener("click", () => {
  if (state.recording) return;
  state.transcript = [];
  state.interimText = "";
  state.fullText = "";
  state.aiSummary = null;
  state.currentId = null;
  $("#recordTime").textContent = "00:00";
  $("#audioResult").hidden = true;
  renderTranscript(); renderFullText(); renderSummary();
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
renderFullText();
renderSummary();
renderHistory();
migrateOldHistory();
checkAi();
