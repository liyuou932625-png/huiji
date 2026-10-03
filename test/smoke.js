/* app.js 初始化冒烟测试：用最小 DOM 桩跑顶层代码，抓运行时错误 */
"use strict";
const fs = require("fs");
const path = require("path");

function fakeClassList() {
  const s = new Set();
  return {
    add: (...c) => c.forEach((x) => s.add(x)),
    remove: (...c) => c.forEach((x) => s.delete(x)),
    toggle: (c, f) => (f === undefined ? (s.has(c) ? s.delete(c) : s.add(c)) : (f ? s.add(c) : s.delete(c))),
    contains: (c) => s.has(c),
  };
}
function fakeEl() {
  const el = {
    _value: "",
    _checked: false,
    _hidden: false,
    _disabled: false,
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    src: "",
    href: "",
    download: "",
    dataset: {},
    style: {},
    className: "",
    classList: fakeClassList(),
    listeners: {},
    addEventListener: (ev, fn) => { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
    removeEventListener: () => {},
    appendChild: () => {},
    remove: () => {},
    click: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    closest: () => null,
    getContext: () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 10 }) : typeof k === "string" ? () => {} : undefined) }),
    toDataURL: () => "data:,",
    querySelector: () => fakeEl(),
  };
  return new Proxy(el, {
    get(t, k) {
      if (k in t) return t[k];
      return undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}

const elements = new Map();
const fakeDoc = {
  querySelector: (sel) => {
    if (!elements.has(sel)) elements.set(sel, fakeEl());
    return elements.get(sel);
  },
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  addEventListener: () => {},
  documentElement: { classList: fakeClassList() },
  body: { appendChild: () => {} },
};

const fakeLocalStorage = {
  _d: {},
  getItem: (k) => (k in this._d ? this._d[k] : null),
  setItem: (k, v) => { this._d[k] = String(v); },
  removeItem: (k) => { delete this._d[k]; },
};
// 上面 this 绑定问题，改闭包
const store = {};
const fakeLS = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

global.document = fakeDoc;
global.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
  isSecureContext: true,
  SpeechRecognition: undefined,
  webkitSpeechRecognition: undefined,
  MediaRecorder: undefined,
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  Blob: class Blob {},
  beforeinstallprompt: undefined,
};
Object.defineProperty(global, "navigator", { value: { mediaDevices: undefined }, configurable: true });
global.localStorage = fakeLS;

/* 假 IndexedDB：返回含「残缺旧数据」的会议记录（缺 summary/transcript/duration），
 * 用于验证历史列表渲染不崩溃 */
const DB_DATA = {
  meetings: [
    { id: "old-1", date: "2026年1月1日", created: 1 },                                  // 完全残缺
    { id: "old-2", date: "2026年2月2日", time: "10:00", duration: "05:00", created: 2,  // 缺 summary
      transcript: [{ speaker: "人物 1", time: "00:01", text: "今天讨论上线" }] },
    { id: "new-1", title: "周会", date: "2026年3月3日", time: "09:00", duration: "30:00", created: 3,
      transcript: [{ speaker: "人物 1", time: "00:01", text: "确认下周发布" }],
      fullText: "确认下周发布。",
      summary: { oneLine: "下周发布。", actions: [], points: ["发布"], source: "heuristic" } },
  ],
  audio: [],
};
function makeStore(name) {
  const data = DB_DATA[name] || [];
  return {
    getAll: () => data.slice(),
    get: (k) => data.find((r) => String(r.id) === String(k)),
    put: (v) => {
      const i = data.findIndex((r) => String(r.id) === String(v.id));
      if (i >= 0) data[i] = v; else data.push(v);
    },
    delete: (k) => {
      const i = data.findIndex((r) => String(r.id) === String(k));
      if (i >= 0) data.splice(i, 1);
    },
  };
}
global.indexedDB = {
  open: () => {
    const req = { result: null };
    req.result = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => {},
      transaction: (name) => {
        const tx = { oncomplete: null, onerror: null, objectStore: () => makeStore(name) };
        queueMicrotask(() => tx.oncomplete && tx.oncomplete());
        return tx;
      },
    };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  },
};
global.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: "qwen2.5:3b-instruct" }] }) });
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
global.clearTimeout = clearTimeout;
global.setTimeout = setTimeout;

const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
(async () => {
  try {
    // 严格模式 eval 的声明不外泄，追加一行探针把要测的符号挂到全局
    (0, eval)(src + "\n;globalThis.__probe = { $, state, fallbackPunctuate, buildMinutes, renderHistory, saveCurrentMeeting };");
    // 等初始化里的异步（renderHistory / checkAi）settle
    await new Promise((r) => setTimeout(r, 50));
    const P = globalThis.__probe;

    const tests = [];
    // 1) 残缺旧数据下 renderHistory 不崩溃且能渲染完整记录
    tests.push(["renderHistory 含残缺数据不崩溃", () => P.$("#historyList").innerHTML.includes("周会")]);
    // 2) 兜底断句产出带标点的文本
    tests.push(["fallbackPunctuate 产出标点", () => P.fallbackPunctuate("我们下周发布新版本然后测试").includes("。")]);
    // 3) 导出纪要含结构化章节（meeting-notes 规范）
    tests.push(["buildMinutes 含执行摘要/行动项/参会人", () => {
      const t = P.buildMinutes({ title: "测试会", date: "2026年10月3日", time: "10:00", duration: "05:00", summary: null, fullText: "全文。", transcript: [{ speaker: "人物 1", time: "00:01", text: "确认发布" }] });
      return t.includes("## 执行摘要") && t.includes("## 行动项") && t.includes("参会人：人物 1");
    }]);
    // 4) 没有识别到文字时，保存也会入库（历史里总有记录，不丢失）
    tests.push(["无文字也保存到历史", async () => {
      const before = DB_DATA.meetings.length;
      P.$("#meetingTitle").value = "无文字会议A";
      P.saveCurrentMeeting();
      await new Promise((r) => setTimeout(r, 40));
      return DB_DATA.meetings.length > before && DB_DATA.meetings.some((m) => m.title === "无文字会议A");
    }]);

    let failed = 0;
    for (const [name, fn] of tests) {
      try { if (await fn()) console.log("  ✓", name); else { console.error("  ✗", name); failed++; } }
      catch (e) { console.error("  ✗", name, "->", e.message); failed++; }
    }
    if (failed) { console.error("SMOKE_FAIL: 有断言未通过"); process.exit(1); }
    console.log("SMOKE_OK: app.js 初始化无异常，全部断言通过");
  } catch (e) {
    console.error("SMOKE_FAIL:", e.message);
    console.error(e.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }
})();
