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
global.indexedDB = { open: () => { throw new Error("no idb in test"); } };
global.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: "qwen2.5:3b-instruct" }] }) });
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
global.clearTimeout = clearTimeout;
global.setTimeout = setTimeout;

const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
try {
  (0, eval)(src);
  console.log("SMOKE_OK: app.js 顶层初始化无异常");
} catch (e) {
  console.error("SMOKE_FAIL:", e.message);
  console.error(e.stack.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}
