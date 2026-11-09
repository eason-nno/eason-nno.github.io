/* TradingAgents 加密短線研究 — 公開版（GitHub Pages，靜態）
 * 即時行情在瀏覽器直接連 Binance USDⓈ-M 永續合約（USDC 本位）；AI 結果讀取後台推送的 data/*.json。
 * 原始碼：/workspace/ta-web/pages_src（由 tools/publish_pages.py 建置）。 */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* 靜態資料（後台每次分析完推送）＋瀏覽器即時行情，模擬原本的 /api 介面 */
const DATA = { cache: {}, pending: new Map(), revisions: {}, fileTimes: {}, live: {}, published: null };
const PUBLIC_RELAY = "https://easonagents-share.pages.dev/api/remote/site";
const usesRelay = location.origin === "https://eason-nno.github.io";

function patchHTML(root, html, preserve = "") {
  const template = document.createElement("template");
  template.innerHTML = html;
  const key = node => node.nodeType === 1 && (node.id || node.dataset.syncKey);
  function patch(parent, source) {
    const keyed = new Map(Array.from(parent.childNodes).filter(key).map(node => [key(node), node]));
    let cursor = parent.firstChild;
    for (const desired of source.childNodes) {
      const node = key(desired) ? keyed.get(key(desired)) : cursor;
      if (!node || node.nodeName !== desired.nodeName || node.namespaceURI !== desired.namespaceURI || key(node) !== key(desired)) {
        parent.insertBefore(desired.cloneNode(true), cursor);
        continue;
      }
      if (node !== cursor) parent.insertBefore(node, cursor);
      cursor = node.nextSibling;
      if (node.nodeType === 3) { if (node.data !== desired.data) node.data = desired.data; continue; }
      if (node.nodeType !== 1 || (preserve && node.matches(preserve))) continue;
      for (const { name } of Array.from(node.attributes)) {
        if (!(name === "open" && node.localName === "details") && !desired.hasAttribute(name)) node.removeAttribute(name);
      }
      for (const { name, value } of desired.attributes) {
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
      }
      patch(node, desired);
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  patch(root, template.content);
}

function onData(files, render) {
  let active = true, pending = false, running = false;
  pageCleanup.push(() => { active = false; });
  on("data_updated", async (changed) => {
    if (!files.some(name => changed.has(name))) return;
    pending = true;
    if (running) return;
    running = true;
    try {
      while (active && pending) {
        pending = false;
        try { await render(() => active); } catch (error) { console.warn("資料更新失敗", error); }
      }
    } finally { running = false; }
  });
}
function freshStatus(st, now = Date.now()) {
  const published = Date.parse(st.published_at || "");
  if (st.busy && (!Number.isFinite(published) || now - published > 10 * 60000)) {
    return { ...st, busy: false, stale: true, current: st.current ? { ...st.current, status: "sync_stale" } : null };
  }
  return st;
}
function displayRun(run, st) {
  return st.stale && st.current?.id === run.id && ["running", "queued", "pausing"].includes(run.status)
    ? { ...run, status: "sync_stale" } : run;
}
async function J(name, maxAge = 30000) {
  const version = DATA.revisions[name];
  const c = DATA.cache[name];
  if (c && (version ? c.version === version : Date.now() - c.t < maxAge)) {
    return name === "status.json" ? freshStatus(c.v) : c.v;
  }
  const key = name + "|" + (version || "");
  if (!DATA.pending.has(key)) DATA.pending.set(key, (async () => {
    const live = DATA.live[name];
    let r;
    if (live && live.rev === version) {
      try { r = await fetch(PUBLIC_RELAY + "/" + name + "?rev=" + version, { signal: AbortSignal.timeout(4000) }); } catch {}
    }
    if (!r?.ok && c && live) return c.v;
    if (!r?.ok) r = await fetch("data/" + name + "?v=" + (version || Date.now()), { cache: version ? "default" : "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "資料尚未同步，請稍後再試" : "HTTP " + r.status);
    const v = await r.json();
    if (DATA.revisions[name] === version && (!live || r.url.startsWith(PUBLIC_RELAY))) DATA.cache[name] = { t: Date.now(), version, v };
    return name === "status.json" ? freshStatus(v) : v;
  })().finally(() => DATA.pending.delete(key)));
  return DATA.pending.get(key);
}
const tpeDate = (x) => new Date(new Date(x).getTime() + 8 * 3600000).toISOString().slice(0, 10);
function nextRunTime(s, after = Date.now()) {
  if (!s.schedule_enabled) return null;
  const n = Math.max(1, +s.schedule_interval_hours || 1), a = s.quiet_start, b = s.quiet_end;
  const quiet = (h) => (a == null || b == null ? false : a <= b ? a <= h && h <= b : h >= a || h <= b);
  let t = Math.floor(after / 3600000) * 3600000 + 3600000;
  for (let i = 0; i < 72; i++, t += 3600000) { const h = new Date(t + 8 * 3600000).getUTCHours(); if (h % n === 0 && !quiet(h)) return new Date(t).toISOString(); }
  return null;
}
/* v1.0.8 起全部改用 Binance USDC 永續；v1.0.7 以前的 OKX 舊紀錄代號是 BTCUSDT，用 coinKey 對應到同一個幣 */
const coinKey = (s) => (s ? String(s).toUpperCase().replace(/(USDT|USDC|FDUSD|BUSD)$/, "") + "USDC" : s);
const sameCoin = (a, b) => !!a && !!b && coinKey(a) === coinKey(b);
const unitOf = (sym) => (/USDT$/.test(sym || "") ? "USDT" : "USDC");
async function aiState() {
  const [rawRuns, st] = await Promise.all([J("recent.json").catch(() => J("runs.json")), J("status.json")]);
  const runs = rawRuns.map(r => displayRun(r, st));
  const latest = (sym) => runs.find((r) => sameCoin(r.symbol, sym) && r.status === "done") || null;
  const status = (sym) => (st.busy && sameCoin(st.current?.symbol, sym) ? "running" : latest(sym) ? "done" : "not_run");
  return { runs, st, latest, status };
}
const api = async (p) => {
  const [path, qs] = p.split("?"); const q = new URLSearchParams(qs || ""); let m;
  if (path === "/api/crypto/overview") {
    const [A, mkt] = await Promise.all([aiState(), J("market.json").catch(() => ({}))]);
    const items = MK.cfg.watchlist.map((s) => ({ ...MK.summary(s), ai: A.latest(s), ai_status: A.status(s), sentiment: MK.sentiment || mkt.sentiment }));
    const today = tpeDate(Date.now());
    return { items, kpi: { tracked: items.length, ai_done_today: A.runs.filter((r) => r.status === "done" && tpeDate(r.created_at) === today).length, ai_running: A.st.busy ? 1 : 0,
      signals_24h: MK.signalList({ limit: 100000 }).filter((s) => s.bar_time >= Date.now() - 86400000).length },
      ai_live: (A.st.busy || A.st.stale) ? A.st.current : null, categories: MK.categories.items.length ? MK.categories : mkt.categories || MK.categories, sentiment: MK.sentiment || mkt.sentiment };
  }
  if ((m = path.match(/^\/api\/crypto\/symbol\/(\w+)$/))) {
    const [A, mkt] = await Promise.all([aiState(), J("market.json").catch(() => ({}))]); const s = coinKey(m[1]);
    if (!MK.cfg.watchlist.includes(s)) throw new Error("這個幣種不在追蹤清單");
    return { ...MK.summary(s), ai: A.latest(s), ai_status: A.status(s), sentiment: MK.sentiment || mkt.sentiment,
      ai_live: (A.st.busy || A.st.stale) && sameCoin(A.st.current?.symbol, s) ? A.st.current : null, ai_last: A.runs.find((r) => sameCoin(r.symbol, s)) || null };
  }
  if ((m = path.match(/^\/api\/crypto\/klines\/(\w+)$/))) { const sym = coinKey(m[1]), tf = q.get("tf") || "4h"; await MK.ensureBars(sym, tf); return MK.klines(sym, tf, +(q.get("limit") || 300)); }
  if (path === "/api/crypto/signals") { return MK.signalList({ symbol: q.get("symbol"), tf: q.get("tf"), limit: +(q.get("limit") || 60) }); }
  if (path === "/api/crypto/ai/runs") { const st = await J("status.json"); const runs = (await (q.has("recent") ? J("recent.json").catch(() => J("runs.json")) : J("runs.json"))).map(r => displayRun(r,st)); const sy = q.get("symbol"); return runs.filter((r) => !sy || sameCoin(r.symbol, sy)).slice(0, +(q.get("limit") || 50)); }
  if ((m = path.match(/^\/api\/crypto\/ai\/runs\/([\w-]+)$/))) return J(`runs/${m[1]}.json`, 600000);
  if (path === "/api/crypto/ai/live") { const st = await J("status.json"); return { busy: !!st.busy, current: st.current || null }; }
  if (path === "/api/crypto/ai/settings") { const s = await J("settings.json"); return { ...s, next_run: nextRunTime(s.settings) }; }
  if ((m = path.match(/^\/api\/crypto\/ai\/(derivs|news)\/(\w+)$/))) { const mkt = await J("market.json"); const v = (mkt[m[1]] || {})[coinKey(m[2])]; if (!v) throw new Error("沒有快照"); return { ...v, fetched_at: mkt.generated_at }; }
  if (path === "/api/crypto/settings") { const s = await J("settings.json"); return { settings: s.signal_settings || MK.cfg, status: MK.status }; }
  throw new Error("公開版不支援：" + path);
};
const TZ = "Asia/Taipei";
const TZ_SHIFT = 8 * 3600; // 圖表時間軸以台北時間顯示
const TF_LABEL = { "5m": "5分", "15m": "15分", "1h": "1小時", "4h": "4小時", "1d": "1日" };
const dtf = new Intl.DateTimeFormat("zh-TW", { timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtTime = (x) => { if (!x) return "—"; const d = typeof x === "number" ? new Date(x) : new Date(x); return dtf.format(d).replace(/\//g, "-"); };
/* 執行主機（雲端電腦 / 使用者的 PC）最後心跳：超過 75 分鐘沒有回報就標成離線（PC 版閒置時每 30 分鐘回報一次）。 */
const hostBeat = (st) => {
  const h = (st && st.host) || null, at = (h && h.heartbeat_at) || (st && st.published_at);
  if (!at) return '<span class="dim">—</span>';
  const age = (Date.now() - new Date(at).getTime()) / 60000;
  const tag = age > 75 ? '<span class="bad">● 可能離線</span>' : '<span class="ok">● 在線</span>';
  return `${tag}・${esc(h ? h.label : "雲端電腦")}${h && h.version && h.version !== "box" ? ` v${esc(h.version)}` : ""}<span class="dim">・${fmtTime(at)}（台北）</span>`;
};
const fmtClock = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
const hhmmss = (x) => new Intl.DateTimeFormat("zh-TW", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(x));
function pdec(p) { const a = Math.abs(p); return a >= 10 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8; }
function fmtPrice(p, d) { if (p == null || isNaN(p)) return "—"; d = d ?? pdec(p); return Number(p).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
const fmtPct = (x) => (x == null || isNaN(x) ? "—" : `${x > 0 ? "+" : ""}${Number(x).toFixed(2)}%`);
const signCls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "flat");
function fmtBig(x) { if (x == null) return "—"; if (x >= 1e8) return (x / 1e8).toFixed(2) + " 億"; if (x >= 1e4) return (x / 1e4).toFixed(1) + " 萬"; return x.toFixed(2); }
const baseOf = (s) => s.replace(/(USDT|USDC|FDUSD|BUSD)$/, "") || s;

const ICON = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  coin: '<svg viewBox="0 0 24 24"><path d="M7 4v16M17 4v16"/><rect x="4.5" y="7" width="5" height="8" rx="1"/><rect x="14.5" y="9" width="5" height="6" rx="1"/></svg>',
  team: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.8.3 5 2.6 5 5.8"/></svg>',
  paper: '<svg viewBox="0 0 24 24"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>',
  report: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  list: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  bars: '<svg viewBox="0 0 24 24"><path d="M5 20v-6M10 20V9M15 20v-9M20 20V4"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/></svg>',
  scale: '<svg viewBox="0 0 24 24"><path d="M12 3v18M5 21h14M4 7h16M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 5 4 17h16z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 19 4 7h16z" fill="currentColor"/></svg>',
  flat: '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke-width="3"/></svg>',
  trendUp: '<svg viewBox="0 0 24 24"><path d="m3 17 6-6 4 4 8-8M15 7h6v6"/></svg>',
  trendDown: '<svg viewBox="0 0 24 24"><path d="m3 7 6 6 4-4 8 8M15 17h6v-6"/></svg>',
  news: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="15" height="16" rx="2"/><path d="M18 8h3v10a2 2 0 0 1-2 2M7 8h7M7 12h7M7 16h4"/></svg>',
  chain: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/></svg>',
  brief: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  crown: '<svg viewBox="0 0 24 24"><path d="m3 8 4 4 5-7 5 7 4-4-2 11H5z"/></svg>',
  radio: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/></svg>',
  hourglass: '<svg viewBox="0 0 24 24"><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/></svg>',
};
const COIN_STYLE = { BTC: ["#f7931a", "₿"], ETH: ["#627eea", "Ξ"], SOL: ["linear-gradient(135deg,#9945ff,#14f195)", "◎"], BNB: ["#f3ba2f", "B"],
  ZEC: ["#f4b728", "ⓩ"], XRP: ["#2b3440", "X"], DOGE: ["#c2a633", "Ð"], ADA: ["#0033ad", "A"], AVAX: ["#e84142", "A"], LINK: ["#2a5ada", "L"], TON: ["#0098ea", "T"] };
function coinIcon(base, size = 32) {
  const [bg, ch] = COIN_STYLE[base] || ["#33415a", base[0]];
  return `<span class="coin-ic" style="background:${bg};width:${size}px;height:${size}px;flex-basis:${size}px;font-size:${Math.round(size * 0.47)}px">${esc(ch)}</span>`;
}

/* AI 團隊角色（加密版規劃） */
const ROLES = [
  { key: "market", team: "分析師團隊", name: "技術分析師", icon: "bars", tier: "quick", desc: "5分 / 1小時 / 4小時 K 線、RSI、MACD、布林、成交量", col: 0 },
  { key: "sentiment", team: "分析師團隊", name: "情緒分析師", icon: "pulse", tier: "quick", desc: "恐懼貪婪指數、社群情緒", col: 0 },
  { key: "news", team: "分析師團隊", name: "加密新聞分析師", icon: "news", tier: "quick", desc: "CoinDesk、Cointelegraph、Decrypt 等幣圈新聞", col: 0 },
  { key: "onchain", team: "分析師團隊", name: "鏈上 / 衍生品分析師", icon: "chain", tier: "quick", desc: "資金費率、未平倉量、多空比、清算、鏈上數據（取代基本面）", col: 0 },
  { key: "bull", team: "研究團隊", name: "多頭研究員", icon: "up", tier: "quick", desc: "整理做多論點", col: 1 },
  { key: "bear", team: "研究團隊", name: "空頭研究員", icon: "down", tier: "quick", desc: "整理做空論點", col: 1 },
  { key: "manager", team: "研究團隊", name: "研究經理", icon: "scale", tier: "deep", desc: "裁決多空辯論、給出研究結論", col: 2 },
  { key: "trader", team: "交易員", name: "交易員", icon: "brief", tier: "quick", desc: "擬定進場價、停損、持有 24 小時的交易計畫", col: 2 },
  { key: "aggressive", team: "風險管理團隊", name: "積極派風控", icon: "trendUp", tier: "quick", desc: "主張承擔較高風險換取報酬", col: 3 },
  { key: "conservative", team: "風險管理團隊", name: "保守派風控", icon: "shield", tier: "quick", desc: "主張控制回撤、縮小部位", col: 3 },
  { key: "neutral", team: "風險管理團隊", name: "中立派風控", icon: "scale", tier: "quick", desc: "平衡兩方意見", col: 3 },
  { key: "pm", team: "投資組合經理", name: "投資組合經理", icon: "crown", tier: "deep", desc: "最終決策：做多 / 做空 / 觀望 與停損", col: 4 },
];

/* 公開版：沒有登入、沒有寫入動作。 */
const READONLY = true;
const noteHTML = () => "";

/* AI 判斷層共用 */
const DIRS = { LONG: { t: "做多", c: "up", v: "long", pill: "low" }, SHORT: { t: "做空", c: "down", v: "short", pill: "high" }, WAIT: { t: "觀望", c: "warn", v: "wait", pill: "mid" } };
const ROLE = Object.fromEntries(ROLES.map((r) => [r.key, r]));
const TRIG = { schedule: "排程", manual: "手動" };
const fmtLv = (x) => (x == null ? "—" : fmtPrice(x, 2));
function aiPill(ai, status) {
  if (status === "running") return `<span class="pill run">● AI 分析中</span>`;
  if (!ai) return `<span class="status-dot"><i></i>尚未分析</span>`;
  const d = DIRS[ai.decision] || DIRS.WAIT;
  return `<span class="pill ${d.pill}" title="AI 最終決策・${esc(fmtTime(ai.created_at))}">${d.t}・${ai.confidence}</span><small class="dim" style="display:block;margin-top:3px">${esc(fmtTime(ai.created_at))}</small>`;
}
function verdictHTML(ai, side) {
  if (!ai) return `<div class="verdict empty"><div class="v-main"><b>尚未執行 AI 分析</b><small>等待排程，或由本機控制台手動分析</small></div>${side || ""}</div>`;
  const dec = ai.result?.decision || {}; const d = DIRS[ai.decision] || DIRS.WAIT;
  return `<div class="verdict ${d.v}"><div class="v-main"><small>AI 最終決策・持有約 ${holdTxt(ai.settings?.holding_period_days ?? ai.result?.settings?.holding_period_days ?? 1)}</small><b class="${d.c}">${d.t}<span class="conf">信心 ${ai.confidence}/100</span></b>
    <small>${esc(fmtTime(ai.created_at))}（台北）・${esc(TRIG[ai.trigger] || "")}・風險 ${esc(dec.risk_level || "—")}</small></div>${side || ""}</div>
    <div class="lv"><div><small>進場</small><b class="num">${fmtLv(ai.entry)}</b></div><div><small>停損</small><b class="num down">${fmtLv(ai.stop)}</b></div><div><small>停利</small><b class="num up">${fmtLv(ai.take_profit)}</b></div><div><small>建議部位</small><b class="num">${dec.position_size_pct != null ? dec.position_size_pct + "%" : "—"}</b></div></div>`;
}
const scoreBar = (b) => b == null ? `<div class="bbbar na">—</div>` : `<div class="bbbar">${b > 0 ? `<div class="b" style="width:${b}%">${b}</div>` : ""}${b < 100 ? `<div class="s" style="width:${100 - b}%">${100 - b}</div>` : ""}</div>`;

/* live (SSE) */
const live = { tickers: {}, status: null, handlers: {}, lastTick: 0, es: null };
let pageCleanup = [];
function on(evt, fn) { (live.handlers[evt] ||= new Set()).add(fn); pageCleanup.push(() => live.handlers[evt].delete(fn)); }
function emit(evt, d) { (live.handlers[evt] || []).forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } }); }
function connectLive() {
  MK.listeners.push((ev, d) => {
    if (ev === "ticker") { live.tickers[d.symbol] = { ...(live.tickers[d.symbol] || {}), ...d }; live.lastTick = Date.now(); emit("ticker", d); if (Date.now() - (live.pillAt || 0) > 1000) { live.pillAt = Date.now(); updateLivePill(); } }
    else if (ev === "kline") emit("kline", d);
    else if (ev === "signal") { if (d.source === "live") toastSignal(d); emit("signal", d); }
    else if (ev === "status") { live.status = d; updateLivePill(); }
    else if (ev === "categories") emit("categories", d);
    else if (ev === "mark" || ev === "history") emit(ev, d);
  });
  live.status = MK.status;
}
function applyStatus(raw, revisions = raw.sections || {}) {
  const st = freshStatus(raw), changed = new Set();
  for (const [name, rev] of Object.entries(revisions)) {
    if (DATA.revisions[name] !== rev || (DATA.live[name] && DATA.cache[name]?.version !== rev)) {
      DATA.revisions[name] = rev; changed.add(name);
    }
  }
  if (st.published_at !== DATA.published || !!st.stale !== !!DATA.stale) changed.add("status.json");
  if (!Object.keys(revisions).length && DATA.published && changed.size) {
    for (const name of ["runs.json", "recent.json", "market.json", "settings.json", "paper.json", "new-paper.json", "ai-usage.json"]) {
      if (!DATA.live[name]) { delete DATA.cache[name]; changed.add(name); }
    }
  }
  DATA.stale = !!st.stale; DATA.published = st.published_at;
  DATA.cache["status.json"] = { t: Date.now(), version: DATA.revisions["status.json"], v: raw };
  const revision = $('meta[name="eason-frontend"]')?.content;
  const notice = $("#frontend-update");
  if (notice) notice.hidden = !st.frontend_revision || !revision || revision === st.frontend_revision;
  const pe = $("#pub-time"); if (pe) pe.textContent = fmtTime(st.published_at);
  const hb = $("#host-hb"); if (hb) hb.innerHTML = hostBeat(st);
  if (changed.size) emit("data_updated", changed);
}

async function pollData() {
  try {
    const r = await fetch("data/status.json?v=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (!r.ok) return;
    const st = await r.json();
    if (Date.parse(st.published_at) >= (Date.parse(DATA.published) || 0)) {
      for (const [name, rev] of Object.entries(st.sections || {})) {
        if (DATA.live[name]?.rev === rev || Date.parse(st.published_at) > Date.parse(DATA.live[name]?.at)) delete DATA.live[name];
        DATA.fileTimes[name] = Date.parse(st.published_at);
      }
      applyStatus(st);
    } else if (DATA.cache["status.json"] && !!freshStatus(DATA.cache["status.json"].v).stale !== !!DATA.stale) {
      applyStatus(DATA.cache["status.json"].v, {});
    }
  } catch { /* 連線失敗時保留已顯示的資料 */ }
}

async function pollRelay() {
  if (!document.hidden) {
    try {
      const r = await fetch(PUBLIC_RELAY, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const { status, files } = await r.json();
        const at = Date.parse(status?.published_at);
        if (Number.isFinite(at) && at >= (Date.parse(DATA.published) || 0)) {
          const revisions = {};
          for (const [name, version] of Object.entries(files)) {
            const fileTime = Date.parse(version.at || status.published_at);
            if (!/^[a-f0-9]{16}$/.test(version.rev) || fileTime < (DATA.fileTimes[name] || 0)) continue;
            DATA.fileTimes[name] = fileTime;
            revisions[name] = version.rev;
            if (DATA.revisions[name] !== version.rev || !DATA.cache[name]) DATA.live[name] = version;
          }
          applyStatus(status, revisions);
        }
      }
    } catch { /* GitHub Pages 仍可提供資料 */ }
  }
  setTimeout(pollRelay, 8000);
}
function quoteStatusText(q) {
  q = q || {};
  const t = q.last_quote_at ? `最後報價 ${hhmmss(new Date(q.last_quote_at).getTime())}（台北）` : "等待第一筆成交";
  if (q.connected) return { cls: "on", text: `Binance 永續即時・${t}` };
  if (q.state === "failed") return { cls: "off", text: "無法連上 Binance WebSocket，可能受地區/網路限制，重試中…（不會改用其他交易所）" };
  if (q.ever_open) return { cls: "off", text: `Binance 報價斷線，重連中…${q.last_quote_at ? "・" + t : ""}` };
  return { cls: "", text: "Binance 報價連線中…" };
}
function updateLivePill() {
  const p = $("#live-pill"), q = (MK.status || {}).quote, r = quoteStatusText(q);
  if (p) { p.classList.toggle("on", r.cls === "on"); p.classList.toggle("off", r.cls === "off"); $("#live-text").textContent = r.text; }
  const n = $("#q-note"); if (n) { n.textContent = `報價：Binance USDⓈ-M 永續合約（USDC 本位）成交價・${r.text}${(MK.status || {}).data_error ? "・" + MK.status.data_error : ""}`; n.className = "note q-note " + r.cls; }
}
/** 把模型 / API 的原始錯誤轉成簡短的繁中說明（不顯示原始 JSON）。 */
/** 持有期間文字：1 天顯示「24 小時」。 */
const ROLE_NAME = { market: "技術分析師", sentiment: "情緒分析師", news: "新聞分析師", onchain: "鏈上分析師", bull: "多頭研究員", bear: "空頭研究員", manager: "研究經理", trader: "交易員", aggressive: "積極派風控", conservative: "保守派風控", neutral: "中立派風控", pm: "投資組合經理" };
/* AI 代理團隊卡：執行中顯示即時進度（完成數、目前角色、經過時間每秒更新、最新重試 / 接手事件）；
   資料來自 status.json（後台在角色完成 / 重試 / 接手時推送；GitHub Pages 部署 + CDN 約延遲 30–90 秒）。 */
function fmtDur(ms) { const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h} 小時 ${m} 分 ${x} 秒` : m ? `${m} 分 ${String(x).padStart(2, "0")} 秒` : `${x} 秒`; }
function teamCard(s) {
  const n = ROLES.length, cur = s.ai_live, last = s.ai_last;
  if (cur?.status === "sync_stale") return `<div class="card kcard"><small>AI 代理團隊</small><span class="pill gray">同步中斷</span><small>進度超過10分鐘未更新，研究狀態待確認；請檢查本機後台。</small></div>`;
  if (cur) {
    const done = cur.done ?? Object.values(cur.roles || {}).filter((r) => r.status === "done").length;
    const rn = cur.running_role ? (ROLE_NAME[cur.running_role] || cur.running_role) : (cur.phase || "準備中");
    const iss = cur.last_issue;
    return `<div class="card kcard tc-live"><small>AI 代理團隊 <span class="dim">${cur.trigger === "manual" ? "手動" : "排程"}${cur.resumed ? "・補完成" : ""}</span></small>
      <div class="row"><span class="big num">${done} <span class="muted" style="font-size:20px">/ ${n}</span></span><span class="pill run">● 執行中</span></div>
      <small>目前：<b>${esc(rn)}</b>・已執行 <span class="num" data-elapsed="${esc(cur.started_at || cur.created_at)}">${fmtDur(Date.now() - new Date(cur.started_at || cur.created_at))}</span></small>
      ${iss ? `<small class="tc-issue" title="${esc(fmtTime(iss.at))}">${esc(iss.text)}</small>` : ""}</div>`;
  }
  if (last && last.status === "failed") return `<div class="card kcard"><small>AI 代理團隊</small><div class="row"><span class="big num">— <span class="muted" style="font-size:20px">/ ${n}</span></span><span class="pill gray">失敗</span></div>
      <small>${esc(fmtTime(last.created_at))}・${esc(friendlyErr(last.error))}</small></div>`;
  const a = s.ai;
  return `<div class="card kcard"><small>AI 代理團隊</small><div class="row"><span class="big num">${a ? n : 0} <span class="muted" style="font-size:20px">/ ${n}</span></span>${a ? `<span class="pill done">已完成</span>${a.resumed ? `<span class="pill mid" title="補完成於 ${esc(fmtTime(a.resumed.at))}">補完成</span>` : ""}` : `<span class="pill gray">尚未執行</span>`}</div>
    <small>${a ? `最近一次 ${esc(fmtTime(a.created_at))}・耗時 ${Math.round(a.duration_s)} 秒${a.resumed ? `・補完成於 ${esc(fmtTime(a.resumed.at))}` : ""}` : "排程或手動觸發"}</small></div>`;
}
function tickElapsed() { document.querySelectorAll("[data-elapsed]").forEach((e) => { e.textContent = fmtDur(Date.now() - new Date(e.dataset.elapsed)); }); }
function holdTxt(d) { d = +d || 1; return d === 1 ? "24 小時" : `${d} 天`; }
/* 研究呼叫次數沿用舊報告帳本，將不同年代的槽位名稱對齊成五組。 */
const slotNumber = k => /^openai\b/i.test(k) ? 5 : Number(k.match(/(?:槽位?\s*|第\s*)([1-5])(?:\s*組)?$/)?.[1]);
const slotShort = k => slotNumber(k) ? `第 ${slotNumber(k)} 組` : k;
const fmtCalls = c => {
  if (!c) return "—";
  if (!c.by_slot) return `快速 ${c.quick?.calls ?? 0}・深度 ${c.deep?.calls ?? 0}`;
  const counts = [0, 0, 0, 0, 0];
  for (const [label, entry] of Object.entries(c.by_slot)) {
    const slot = slotNumber(label);
    if (slot) counts[slot - 1] += Number(entry.calls) || 0;
  }
  return counts.map((count, i) => `第 ${i + 1} 組 ${count}`).join("・");
};
const callsTitle = (c) => !c ? "" : [`合計 ${(c.quick?.calls || 0) + (c.deep?.calls || 0)} 次（快速 ${c.quick?.calls ?? 0}・深度 ${c.deep?.calls ?? 0}，含失敗重試）`,
  ...(c.parts || []).map((p) => `${p.label}：${p.calls} 次（${Object.entries(p.by_slot || {}).filter(([, n]) => n).map(([k, n]) => slotShort(k) + " " + n).join("・") || "0"}）`), c.note || ""].filter(Boolean).join("\n");
function friendlyErr(e) {
  const t = String(e || ""), lo = t.toLowerCase();
  const who = /gemini|google|generativelanguage/.test(lo) ? "Gemini" : /x\.ai|xai|grok/.test(lo) ? "Grok" : /openai|gpt/.test(lo) ? "OpenAI" : "AI 模型";
  if (/\b503\b|unavailable|overloaded|high demand/.test(lo)) return `${who} 伺服器忙碌（503），稍後會再試`;
  if (/\b429\b|resource_exhausted|quota|rate.?limit/.test(lo)) return `${who} 額度用完或請求太頻繁（429）`;
  if (/\b40[13]\b|api key|permission|unauthorized|invalid.*key/.test(lo)) return `${who} 金鑰無效或沒有權限`;
  if (/timeout|timed out|逾時/.test(lo)) return `${who} 回應逾時`;
  if (/\b50[024]\b|internal/.test(lo)) return `${who} 伺服器錯誤`;
  if (!t) return "分析失敗";
  return t.length > 40 || /[{}\[\]]/.test(t) ? "分析失敗，請稍後重試" : t;
}
function showSheet(titleHtml, bodyHtml) {
  closeSheet();
  const el = document.createElement("div"); el.className = "sheet-wrap"; el.id = "sheet";
  el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-h"><h3>${titleHtml}</h3><button class="sheet-x" aria-label="關閉">✕</button></div><div class="sheet-b">${bodyHtml}</div></div>`;
  el.onclick = (e) => { if (e.target === el || e.target.closest(".sheet-x")) closeSheet(); };
  document.body.appendChild(el); document.body.classList.add("noscroll");
  const k = (e) => { if (e.key === "Escape") closeSheet(); }; document.addEventListener("keydown", k); el._k = k;
}
function closeSheet() { const el = $("#sheet"); if (!el) return; document.removeEventListener("keydown", el._k); el.remove(); el._cleanup?.(); document.body.classList.remove("noscroll"); }

function showRoleDebate(role,reportId){
  const base=location.origin==='https://eason-nno.github.io'?'https://easonagents-share.pages.dev':'http://127.0.0.1:8800';
  const remote=base.startsWith('https:');
  const src=base+'/debate?'+new URLSearchParams({role,report:reportId||'',parent:location.origin});
  const previous=document.activeElement;
  showSheet('與AI角色辯論',`<p class="note" data-debate-status>正在連接辯論室…</p><iframe class="debate-frame" title="私人角色辯論" src="${esc(src)}" sandbox="allow-scripts allow-same-origin" allow="local-network-access; loopback-network" referrerpolicy="no-referrer"></iframe>`);
  const el=$('#sheet'),frame=$('iframe',el),status=$('[data-debate-status]',el);
  el.classList.add('debate-wrap');el.dataset.route=location.hash;
  const timer=setTimeout(()=>{status.textContent=remote?'外網辯論尚未回應。請確認研究主機已更新並保持連線。':'本機辯論室尚未回應。請確認easonAgents已啟動並允許本機連線。';},12000);
  const message=e=>{
    if(e.origin!==base||e.source!==frame.contentWindow)return;
    if(e.data?.type==='eason-debate-ready'){clearTimeout(timer);status.textContent=remote?'外網對話按訪客隔離，經雲端暫存轉送至研究主機；正式研究優先。':'私人對話只保存在這台電腦；選單切換會同步切換實際帳戶。'}
    if(e.data?.type==='eason-debate-close')closeSheet();
  };
  const focus=e=>{if(!el.contains(e.target))$('.sheet-x',el).focus()};
  window.addEventListener('message',message);document.addEventListener('focusin',focus);$('.sheet-x',el).focus();
  el._cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',message);document.removeEventListener('focusin',focus);previous?.focus()};
}

function toastSignal(s) {
  const el = document.createElement("div");
  el.className = `toast ${s.direction}`;
  el.innerHTML = `<b>${esc(baseOf(s.symbol))} ${esc(s.tf_label)}・${esc(s.title)}</b><span class="muted">${esc(s.detail)}</span>`;
  $("#toasts").prepend(el);
  setTimeout(() => el.remove(), 9000);
}
function toast(msg, cls = "") {
  const el = document.createElement("div"); el.className = `toast ${cls}`; el.innerHTML = msg;
  $("#toasts").prepend(el); setTimeout(() => el.remove(), 6000);
}

/* shared UI */
let WATCH = ["BTCUSDC", "ETHUSDC", "ZECUSDC"];
let lastCoin = coinKey(localStorage.getItem("lastCoin") || "BTCUSDC");
function renderNav(active) {
  const items = [["home", "#/", "總覽", ICON.home], ["coin", `#/coin/${lastCoin}`, "幣種研究", ICON.coin], ["team", "#/team", "AI 團隊", ICON.team],
    ["paper", "#/paper", "模擬交易", ICON.paper], ["reports", "#/reports", "研究報告", ICON.report]];
  $("#nav").innerHTML = items.map(([k, h, t, ic]) => k === "paper" ?
    `<details class="nav-dropdown ${active === k ? "active" : ""}"><summary>${ic}<span>${t}</span><span class="chevron">▾</span></summary><div class="nav-menu"><a href="#/paper" ${location.hash === "#/paper" ? 'aria-current="page"' : ""}>AI 團隊策略</a><a href="#/paper/new" ${location.hash === "#/paper/new" ? 'aria-current="page"' : ""}>測試1號</a><a href="#/paper/test2" ${location.hash === "#/paper/test2" ? 'aria-current="page"' : ""}>測試2號</a></div></details>` :
    `<a href="${h}" class="${k === active ? "active" : ""}" ${k === active ? 'aria-current="page"' : ""}>${ic}<span>${t}</span></a>`).join("") +
    `<a href="#/settings" class="${active === "settings" ? "active" : ""}">${ICON.gear}<span>設定</span></a>`;
  const dd = $(".nav-dropdown");
  dd.addEventListener("keydown", e => { if (e.key === "Escape") { dd.open = false; $("summary", dd).focus(); } });
}
function sparkSVG(vals, w = 130, h = 36) {
  if (!vals || vals.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 3 - ((v - mn) / r) * (h - 6)]);
  const up = vals[vals.length - 1] >= vals[0], c = up ? "#0ecb81" : "#f6465d", id = "g" + Math.random().toString(36).slice(2, 8);
  const line = pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="stroke:none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".35"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs><polygon points="0,${h} ${line} ${w},${h}" fill="url(#${id})"/><polyline points="${line}" fill="none" stroke="${c}" stroke-width="1.6"/></svg>`;
}
const riskCls = (r) => (!r ? "gray" : r.score <= 1 ? "low" : r.score === 2 ? "mid" : "high");
const riskTxt = (r) => (!r ? "" : r.score <= 1 ? "up" : r.score === 2 ? "warn" : "down");
const DIR_TXT = { bull: ["偏多", "up"], bear: ["偏空", "down"], flat: ["中性", "flat"] };
function mtfHTML(b) {
  if (!b || !b.combined) return `<span class="muted">—</span>`;
  const cells = [["15m", "15分"], ["1h", "1H"], ["4h", "4H"]].map(([tf, n]) => { const d = DIR_TXT[b.dirs[tf]] || ["—", "flat"]; return `<span class="mtf-c ${d[1]}" title="${n}：${d[0]}"><small>${n}</small>${d[0]}</span>`; }).join("");
  const c = b.combined, cls = c.dir === "bull" ? "up" : c.dir === "bear" ? "down" : "flat";
  return `<div class="mtf"><div class="mtf-cells">${cells}</div><div class="mtf-sum ${cls}" title="加權多方比例 ${c.bull_pct}%（15分 25%、1H 45%、4H 30%）"><b>${esc(c.label)}</b>${c.timing ? `<small>${esc(c.timing)}</small>` : ""}</div></div>`;
}
function divHTML(v) {
  if (!v) return "—";
  const cls = v.key === "bull" ? "up" : v.key === "bear" ? "down" : v.key === "div" ? "warn" : "muted";
  const tot = v.bull + v.bear, bp = tot ? Math.round((v.bull / tot) * 100) : 50;
  const bar = tot ? `<span class="bbbar sm">${v.bull ? `<span class="b" style="width:${bp}%"></span>` : ""}${v.bear ? `<span class="s" style="width:${100 - bp}%"></span>` : ""}</span>` : `<span class="bbbar sm na"></span>`;
  return `<span class="sg-div"><span class="sg-txt"><b class="${cls}">${esc(v.label)}</b>${v.note ? `<small class="dim">・${esc(v.note)}</small>` : ""}</span>
    <span class="sg-cnt"><b class="up">多 ${v.bull}</b> : <b class="down">空 ${v.bear}</b><small class="dim">（近 ${v.window_h} 小時・15分/1H/4H 訊號）</small></span>${bar}</span>`;
}
function trendHTML(t) {
  if (!t) return `<span class="muted">—</span>`;
  const cls = t.arrow === "up" ? "up" : t.arrow === "down" ? "down" : "flat";
  return `<span class="trend ${cls}">${ICON[cls === "flat" ? "flat" : cls]}${esc(t.label)}</span>`;
}
function sigHTML(s, isNew) {
  const ic = s.direction === "bull" ? ICON.trendUp : ICON.trendDown;
  const src = s.source === "live" ? '<span class="src-tag live">即時</span>' : s.source === "recovered" ? '<span class="src-tag">斷線補算</span>' : '<span class="src-tag">歷史回補</span>';
  return `<div class="sig ${isNew ? "new" : ""}" data-id="${s.id}"><div class="sig-ic ${s.direction}">${ic}</div><div class="sig-b">
    <div class="sig-t"><b>${esc(baseOf(s.symbol))}・${esc(s.title)}</b><span class="tf-tag">${esc(s.tf_label)}</span><time title="K 線收盤時間（台北）">${fmtTime(s.close_time_iso)}</time></div>
    <div class="sig-d">${esc(s.detail)}・${fmtPrice(s.price)} ${src}</div></div></div>`;
}
const chartBase = (h) => ({
  height: h, layout: { attributionLogo: false, background: { type: "solid", color: "transparent" }, textColor: "#929aa5", fontSize: 11, fontFamily: "Inter, Noto Sans CJK TC, sans-serif" },
  grid: { vertLines: { color: "rgba(71,77,87,.35)" }, horzLines: { color: "rgba(71,77,87,.35)" } },
  rightPriceScale: { borderColor: "#333b47", minimumWidth: 78 }, timeScale: { borderColor: "#333b47", timeVisible: true, secondsVisible: false },
  crosshair: { mode: 0, vertLine: { color: "#929aa5", labelBackgroundColor: "#333b47" }, horzLine: { color: "#929aa5", labelBackgroundColor: "#333b47" } },
  localization: { locale: "zh-TW", priceFormatter: (p) => fmtPrice(p) },
});
const CANDLE = { upColor: "#0ecb81", downColor: "#f6465d", wickUpColor: "#0ecb81", wickDownColor: "#f6465d", borderVisible: false };
const tt = (ms) => Math.floor(ms / 1000) + TZ_SHIFT;
const lineData = (bars, k) => bars.map((b) => (b[k] == null ? { time: tt(b.t) } : { time: tt(b.t), value: b[k] }));
function makeChart(el, h, opts = {}) {
  const ch = LightweightCharts.createChart(el, { ...chartBase(h), width: el.clientWidth, ...opts });
  const ro = new ResizeObserver(() => ch.applyOptions({ width: el.clientWidth }));
  ro.observe(el);
  pageCleanup.push(() => { ro.disconnect(); ch.remove(); });
  return ch;
}
const smallIc = (k, px = 15) => ICON[k].replace("<svg", `<svg style="width:${px}px;height:${px}px;vertical-align:-3px"`);

/* 總覽 */
let ovSel = null, ovFilter = "all";
/* 成交額treemap：面積正比於quote_volume，不以排名或漲跌幅分配。 */
function volumeTreemap(items,width,height){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return [];
  const rows=(items||[]).map(item=>({item,value:Number(item.quote_volume)})).filter(x=>Number.isFinite(x.value)&&x.value>0)
    .sort((a,b)=>b.value-a.value||String(a.item.symbol).localeCompare(String(b.item.symbol))).slice(0,10);
  if(!rows.length)return [];
  const max=rows[0].value;rows.forEach(r=>r.weight=r.value/max);
  for(let i=rows.length-1;i>=0;i--)if(!rows[i].weight)rows.splice(i,1);
  const total=rows.reduce((sum,r)=>sum+r.weight,0),result=[];
  function split(group,x,y,w,h){
    const sum=group.reduce((n,r)=>n+r.weight,0);
    if(group.length===1){result.push({...group[0],x,y,w,h,share:group[0].weight/total});return}
    let n=1,first=group[0].weight,best=Math.abs(first-sum/2);
    for(let i=2,part=first;i<group.length;i++){part+=group[i-1].weight;const distance=Math.abs(part-sum/2);if(distance<best){best=distance;n=i;first=part}}
    const ratio=first/sum;
    if(w>=h){const edge=w*ratio;split(group.slice(0,n),x,y,edge,h);split(group.slice(n),x+edge,y,w-edge,h)}
    else{const edge=h*ratio;split(group.slice(0,n),x,y,w,edge);split(group.slice(n),x,y+edge,w,h-edge)}
  }
  split(rows,0,0,width,height);return result;
}

async function pageOverview() {
  const view = location.hash;
  setTitle("市場總覽", "即時資料・Binance USDC 永續");
  const app = $("#app");
  const [d, sigs] = await Promise.all([api("/api/crypto/overview"), api("/api/crypto/signals?limit=50")]);
  if (view !== location.hash) return;
  WATCH = d.items.map((i) => i.symbol);
  d.items.forEach((i) => { if (i.ticker) live.tickers[i.symbol] = { ...i.ticker, ...(live.tickers[i.symbol] || {}) }; });
  if (!ovSel || !WATCH.includes(ovSel)) ovSel = WATCH[0];
  const items = Object.fromEntries(d.items.map((i) => [i.symbol, i]));
  app.innerHTML = `
  <div class="grid-ov1">
    <div class="ov-left">
    <section class="card ov-watch">
      <div class="card-h"><h2>${ICON.list}我的追蹤清單</h2>
        <div class="right kpis">
          <div class="kpi">${ICON.target}<div><small>追蹤標的</small><b class="num">${d.kpi.tracked}</b></div></div>
          <div class="kpi">${ICON.check}<div><small>今日完成（AI）</small><b class="num">${d.kpi.ai_done_today}</b></div></div>
          <div class="kpi">${ICON.bars}<div><small>分析中</small><b class="num">${d.kpi.ai_running}</b></div></div>
          <div class="kpi">${ICON.bolt}<div><small>24h 訊號</small><b class="num" id="kpi-sig">${MK.historyReady ? d.kpi.signals_24h : "—"}</b></div></div>
        </div></div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="tabs" id="ov-tabs">${[["all", "全部"], ["bull", "技術偏多"], ["bear", "技術偏空"]].map(([k, t]) => `<button class="tab ${ovFilter === k ? "active" : ""}" data-f="${k}">${t}</button>`).join("")}</div>
        <span class="note">技術多空、多空分歧與波動風險皆由指標計算（非 AI）：1H 為主、4H 看大方向、15 分看進場時機</span>
      </div>
      <div class="note q-note" id="q-note" style="margin:6px 0 2px">報價：Binance USDⓈ-M 永續合約（USDC 本位）成交價・連線中…
      </div>
      <table class="watch"><thead><tr><th>代號 / 名稱</th><th>最新價格</th><th>走勢（1小時・30 期）</th><th>技術多空（15分 / 1H / 4H + 綜合）</th><th>多空分歧（近 6 小時）</th><th>即時訊號（最新觸發）</th><th>波動風險</th><th>研究狀態</th></tr></thead>
      <tbody id="ov-rows"></tbody></table>
      <p class="note" style="margin:8px 2px 0">點選列可切換下方「多空分歧明細」；按 › 進入幣種研究頁。</p>
    </section>
    <section class="card hl-card" id="home-hyperliquid">
      <div class="card-h"><h2>${ICON.chain}Hyperliquid 鯨魚清算地圖</h2><div class="right">
        <select class="select" id="hl-coin" aria-label="選擇清算地圖幣種"><option>BTC</option><option>ETH</option><option>ZEC</option></select>
      </div></div><div id="hl-map"></div>
    </section>
    <section class="card ai-feed-card"><div class="card-h"><h2>${ICON.spark}AI 研究動態</h2><div class="right"><span class="chip-muted">排程 / 手動分析・台北時間</span></div></div>
      <div id="feed-wrap"></div></section>
    <section class="card ov-heat"><div class="card-h"><h2>${ICON.grid}市場板塊</h2><div class="right"><span class="chip-muted">24h 成交額前 10・即時</span></div></div>
      <div class="heat" id="heat"></div><div id="heat-labels" class="heat-labels" aria-label="市場板塊幣種"></div></section>
    </div>
  </div>
  <div class="ov-div">
    <section class="card"><div class="card-h"><h2>${ICON.scale}多空分歧明細</h2><div class="right"><select class="select" id="div-sel">${WATCH.map((s) => `<option ${s === ovSel ? "selected" : ""} value="${s}">${baseOf(s)}</option>`).join("")}</select></div></div>
      <div id="div-body"></div></section>
  </div>`;

  mountHyperliquidMap();

  const pxHTML = (t) => { const chgAbs = t.last != null && t.open != null ? t.last - t.open : null;
    return `<b>${fmtPrice(t.last)}</b><small class="${signCls(t.change_pct)}">${chgAbs == null ? "" : (chgAbs > 0 ? "+" : "") + fmtPrice(chgAbs)} (${fmtPct(t.change_pct)})</small>`; };
  const lastSigHTML = (sym) => { const last = MK.signalList({ symbol: sym, limit: 1 })[0];
    return last ? `<span class="sg-last"><span class="${last.direction === "bull" ? "up" : "down"}">${last.direction === "bull" ? "▲" : "▼"} ${esc(last.title)}</span><small class="dim">${esc(last.tf_label)}・${fmtTime(last.close_time_iso)}（台北）</small></span>` : '<span class="dim">尚無訊號</span>'; };
  const renderRsi = () => { // 更新每列的 技術多空 / 多空分歧 / 即時訊號（指標計算，非 AI）
    d.items.forEach((i) => {
      i.bias = MK.summary(i.symbol).bias;
      const m = $(`[data-mtf="${i.symbol}"]`); if (m) m.innerHTML = mtfHTML(i.bias);
      const v = $(`[data-div="${i.symbol}"]`); if (v) v.innerHTML = divHTML(i.bias && i.bias.divergence);
      const g = $(`[data-sig="${i.symbol}"]`); if (g) g.innerHTML = lastSigHTML(i.symbol);
    });
  };
  const renderRows = () => {
    const rows = d.items.filter((i) => { const c = i.bias && i.bias.combined; return ovFilter === "all" || (c && (ovFilter === "bull" ? c.dir === "bull" : c.dir === "bear")); });
    $("#ov-rows").innerHTML = rows.map((i) => {
      const t = live.tickers[i.symbol] || i.ticker || {};
      return `<tr class="row ${i.symbol === ovSel ? "sel" : ""}" data-s="${i.symbol}">
        <td class="w-coin"><div class="coin">${coinIcon(i.base)}<div><b>${esc(i.base)}</b><small>${esc(i.name)}</small></div><a class="go-coin" href="#/coin/${i.symbol}" title="進入 ${esc(i.base)} 幣種研究" aria-label="進入 ${esc(i.base)} 幣種研究">›</a></div></td>
        <td class="px num w-px" data-px="${i.symbol}">${pxHTML(t)}</td>
        <td class="w-spark" data-spark="${i.symbol}">${sparkSVG(i.spark)}</td>
        <td data-label="技術多空" data-mtf="${i.symbol}">${mtfHTML(i.bias)}</td>
        <td data-label="多空分歧" data-div="${i.symbol}"></td>
        <td data-label="即時訊號" data-sig="${i.symbol}"></td>
        <td data-label="波動風險">${i.risk ? `<span class="pill ${riskCls(i.risk)}" title="ATR(14)/價格 = ${i.risk.atr_pct}%（4小時）">${esc(i.risk.level)}</span>` : "—"}</td>
        <td data-label="研究狀態">${aiPill(i.ai, i.ai_status)}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="muted">沒有符合的標的</td></tr>`;
    renderRsi();
    $$("#ov-rows tr.row").forEach((tr) => tr.onclick = (e) => { if (e.target.closest("a")) return; selectCoin(tr.dataset.s); });
  };
  $$("#ov-tabs .tab").forEach((b) => b.onclick = () => { ovFilter = b.dataset.f; $$("#ov-tabs .tab").forEach((x) => x.classList.toggle("active", x === b)); renderRows(); });


  let heatCategory=null,heatFrame=null;
  const drawHeat = () => {
    heatFrame=null;const cat=heatCategory,el=$("#heat");if(!el)return;
    const rect=el.getBoundingClientRect(),items=(cat?.kind==="top_volume"&&cat.quote==="USDT"&&cat.items)||[];
    const labels=$("#heat-labels");
    const boxes=volumeTreemap(items,rect.width,rect.height);
    if(!boxes.length){labels.replaceChildren();el.innerHTML='<div class="empty-state" style="height:100%"><b>成交額排行載入中／尚無有效資料</b></div>';return}
    const color=value=>Number.isFinite(value)?`rgba(${value>=0?"30,170,105":"220,70,90"},${Math.min(Math.abs(value)/5,1)*.55+.25})`:'#29313b';
    const overflow=[];
    el.innerHTML=boxes.map(box=>{
      const c=box.item,pct=c.change_pct==null||c.change_pct===''?NaN:Number(c.change_pct),change=Number.isFinite(pct)?fmtPct(pct):'—';
      const compact=box.w<120||box.h<75,mini=box.w<65||box.h<42,name=c.name||baseOf(c.symbol),micro=box.w<name.length*7+8||box.h<16;
      if(micro)overflow.push({name,pct});
      const description=`${name}・24h ${change}・成交額 ${fmtBig(c.quote_volume)} U・占比 ${(box.share*100).toFixed(2)}%`;
      return `<button type="button" class="tile${compact?' heat-compact':''}${mini?' heat-mini':''}${micro?' heat-micro':''}" data-heat-symbol="${esc(c.symbol)}" data-volume-share="${box.share}" style="left:${box.x/rect.width*100}%;top:${box.y/rect.height*100}%;width:${box.w/rect.width*100}%;height:${box.h/rect.height*100}%;background:${color(pct)}" title="${esc(description)}" aria-label="${esc(description)}"><b>${esc(name)}</b><span class="num">${change}</span><small>${fmtBig(c.quote_volume)} U</small></button>`;
    }).join('');
    $$('[data-heat-symbol]',el).forEach(button=>button.onclick=()=>toast(esc(button.title)));
    labels.innerHTML=overflow.map(({name,pct})=>`<span style="background:${color(pct)}">${esc(name)}</span>`).join("");
  };
  const renderHeat=cat=>{heatCategory=cat;if(heatFrame===null)heatFrame=requestAnimationFrame(drawHeat)};
  const heatResize=new ResizeObserver(()=>{if(heatFrame===null)heatFrame=requestAnimationFrame(drawHeat)});heatResize.observe($("#heat"));
  pageCleanup.push(()=>{heatResize.disconnect();if(heatFrame!==null)cancelAnimationFrame(heatFrame)});

  let aiRuns = (await aiState().catch(() => ({runs:[]}))).runs.slice(0,20);
  if (view !== location.hash) return;
  const aiLive = (d.ai_live?.messages || []).map((m) => ({ ...m, symbol: d.ai_live.symbol }));
  const renderFeed = () => {
    const liveMsgs = aiLive.slice(-30).reverse().map((m) => `<div class="sig"><div class="sig-ic ${m.key === "bull" ? "bull" : m.key === "bear" ? "bear" : ""}">${ICON[ROLE[m.key]?.icon || "chat"]}</div><div class="sig-b"><div class="sig-t"><b>${esc(baseOf(m.symbol || ""))}・${esc(ROLE[m.key]?.name || m.key)}</b><span class="tf-tag">分析中</span><time>${fmtTime(m.time)}</time></div><div class="sig-d">${esc(m.finding || (m.text || "").replace(/[*#|]/g, "").slice(0, 90))}</div></div></div>`).join("");
    const runRows = aiRuns.map((r) => { const dd = DIRS[r.decision];
      const head = r.status === "done" ? "最終決策 " + (dd ? dd.t : "") : r.status === "failed" ? "分析失敗" : "分析中";
      const body = r.status === "done" ? `信心 ${r.confidence}・進場 ${fmtLv(r.entry)}・停損 ${fmtLv(r.stop)}・停利 ${fmtLv(r.take_profit)}${r.resumed ? `・補完成於 ${fmtTime(r.resumed.at)}` : ""}` : r.status === "failed" ? esc(friendlyErr(r.error)) : "AI 團隊分析進行中…";
      return `<a class="sig" href="#/report/${encodeURIComponent(r.id)}"><div class="sig-ic ${r.decision === "LONG" ? "bull" : r.decision === "SHORT" ? "bear" : ""}">${r.status === "failed" ? ICON.info || ICON.crown : ICON.crown}</div><div class="sig-b"><div class="sig-t"><b class="${r.status === "failed" ? "down" : ""}">${esc(baseOf(r.symbol))}・${head}</b><span class="tf-tag">${esc(TRIG[r.trigger] || r.trigger || "")}</span><time>${fmtTime(r.created_at)}</time></div><div class="sig-d">${body}</div></div></a>`; }).join("");
    $("#feed-wrap").innerHTML = (liveMsgs || runRows) ? `<div class="feed ai-feed">${liveMsgs}${runRows}</div>` : `<div class="empty-state" style="height:160px">${ICON.team}<b>尚未執行 AI 分析</b><small>AI 團隊依排程或手動觸發分析後，研究動態會出現在這裡。</small></div>`;
  };

  const renderDiv = () => {
    const i = items[ovSel] || items[$("#div-sel").value];
    $("#div-sel").value = i.symbol;
    const b = MK.summary(i.symbol).bias, since = Date.now() - 6 * 3600000;
    const contrib = MK.signalList({ symbol: i.symbol, limit: 500 }).filter((x) => ["15m", "1h", "4h"].includes(x.tf) && x.bar_time + ({ "15m": 900000, "1h": 3600000, "4h": 14400000 }[x.tf]) >= since);
    const biasHTML = `<div class="bd-head">${coinIcon(i.base, 20)}<b>${esc(i.base)}</b><span class="muted" style="font-size:12px">指標計算，非 AI</span></div>
      ${mtfHTML(b)}<div style="margin-top:8px">${divHTML(b && b.divergence)}</div>
      <div class="sub-h" style="margin-top:10px">${smallIc("bolt", 13)} 近 6 小時貢獻訊號（15分 / 1H / 4H）</div>
      <div class="bd-list">${contrib.length ? contrib.slice(0, 12).map((x) => `<div class="bd-item"><span class="${x.direction === "bull" ? "up" : "down"}">${x.direction === "bull" ? "▲ 多" : "▼ 空"}</span><b>${esc(x.title)}</b><span class="tf-tag">${esc(x.tf_label)}</span><time>${fmtTime(x.close_time_iso)}</time></div>`).join("") : '<div class="dim" style="font-size:12.5px">近 6 小時沒有 15分 / 1H / 4H 訊號</div>'}${contrib.length > 12 ? `<div class="dim" style="font-size:12px">另有 ${contrib.length - 12} 則</div>` : ""}</div>
      <div class="sub-h" style="margin-top:14px">${smallIc("scale", 13)} 各週期 5 項條件</div>`;
    const order = [["5m", "5分"], ["15m", "15分"], ["1h", "1小時"], ["4h", "4小時"], ["1d", "日線"]];
    const vals = order.map(([k]) => i.dims[k]?.bull_pct).filter((x) => x != null);
    const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
    const lvl = spread >= 60 ? "高" : spread >= 30 ? "中等" : "低";
    $("#div-body").innerHTML = `<div class="bd-grid"><div class="bd-col">${biasHTML.replace(/<div class="sub-h" style="margin-top:14px">[^]*$/, "")}</div><div class="bd-col">${biasHTML.match(/<div class="sub-h" style="margin-top:14px">[^]*$/)?.[0] || ""}<div class="bb-legend"><span><i style="background:#0ecb81"></i>偏多條件</span><span><i style="background:#f6465d"></i>偏空條件</span></div>
      ${order.map(([k, lab]) => { const s = i.dims[k]; if (!s) return ""; const b = s.bull_pct;
        return `<div class="bbrow"><span>${lab}</span><div class="bbbar" title="${esc(s.checks.map((c) => (c.bull ? "✔ " : "✘ ") + c.name).join("\n"))}">${b > 0 ? `<div class="b" style="width:${b}%">${b}%</div>` : ""}${b < 100 ? `<div class="s" style="width:${100 - b}%">${100 - b}%</div>` : ""}</div></div>`; }).join("")}
      <div class="sub-h" style="margin-top:12px">${smallIc("team", 13)} AI 分析師多空分數（0 看空 – 100 看多）${i.ai ? "・" + esc(fmtTime(i.ai.created_at)) : ""}</div>
      ${[["market", "技術 AI"], ["sentiment", "情緒"], ["news", "消息"], ["onchain", "鏈上"]].map(([k, lab]) => `<div class="bbrow"><span>${lab}</span>${i.ai ? scoreBar(i.ai.result?.scores?.[k]) : `<div class="bbbar na">尚未執行 AI 分析</div>`}</div>`).join("")}
      <div class="callout"><b>${smallIc("info", 16)} ${(() => { const sc = Object.values(i.ai?.result?.scores || {}).filter((x) => x != null); const sp = sc.length ? Math.max(...sc) - Math.min(...sc) : null; return sp == null ? "週期分歧：" + lvl : `AI 分歧：${sp >= 40 ? "高" : sp >= 20 ? "中等" : "低"}（差 ${sp}）・週期分歧：${lvl}`; })()}</b><span>上方各列為各週期 5 項技術條件（指標計算）；下方為 AI 分析師報告中的多空分數。</span></div></div></div>`;
  };
  const selectCoin = (sym) => { ovSel = sym; $$("#ov-rows tr.row").forEach((x) => x.classList.toggle("sel", x.dataset.s === sym)); renderDiv(); };
  $("#div-sel").onchange = (e) => selectCoin(e.target.value);

  renderRows(); renderHeat(d.categories); renderFeed(); renderDiv();

  on("ticker", (t) => {
    const cell = $(`[data-px="${t.symbol}"]`); if (!cell) return;
    cell.innerHTML = pxHTML(t); // 價格更新不再閃爍背景，只保留漲跌文字顏色
    cell.dataset.last = t.last;
  });
  on("kline", (k) => {
    if (k.tf === "1h" && items[k.symbol]) {
      const sp = items[k.symbol].spark; if (!sp.length) return;
      sp[sp.length - 1] = k.bar.c; const el = $(`[data-spark="${k.symbol}"]`); if (el) el.innerHTML = sparkSVG(sp);
    }
  });
  { const iv = setInterval(() => renderRsi(), 30000); pageCleanup.push(() => clearInterval(iv)); } // K 線指標變化時更新多週期判斷
  on("signal", (s) => { renderRsi(); renderDiv(); const el = $("#kpi-sig"); if (el && MK.historyReady) el.textContent = +el.textContent + 1; });
  on("categories", renderHeat);
  on("ai_message", (m) => { aiLive.push(m); renderFeed(); });
  const refreshAI = async (active) => { const [runs, nd] = await Promise.all([api("/api/crypto/ai/runs?limit=20&recent=1").catch(() => aiRuns), api("/api/crypto/overview")]);
    if (!active()) return; aiRuns = runs; aiLive.length = 0; nd.items.forEach((i) => { items[i.symbol] = i; const o = d.items.findIndex((x) => x.symbol === i.symbol); if (o >= 0) d.items[o] = i; }); $("#kpi-sig").textContent = MK.historyReady ? nd.kpi.signals_24h : "—"; renderRows(); renderDiv(); renderFeed(); };
  onData(["status.json", "recent.json", "runs.json", "market.json"], refreshAI);
  const overview = $("#ov-rows");
  MK.warmHistory().then(() => refreshAI(() => overview.isConnected)).catch(() => {});
  const iv = setInterval(async () => { // 每分鐘重算技術狀態
    try { const nd = await api("/api/crypto/overview"); nd.items.forEach((i) => { items[i.symbol] = i; const o = d.items.findIndex((x) => x.symbol === i.symbol); if (o >= 0) d.items[o] = i; }); renderRows(); renderDiv(); } catch (e) { /* ignore */ }
  }, 60000);
  pageCleanup.push(() => clearInterval(iv));
}

function mountHyperliquidMap() {
  const card = $("#home-hyperliquid");
  const selector = $("#hl-coin", card);
  const map = $("#hl-map", card);
  let markets = {}, request = 0, ageTimer;
  const render = () => {
    const symbol = selector.value;
    const snapshot = markets[coinKey(symbol)]?.hyperliquid;
    patchHTML(map, hyperliquidPanel(snapshot, Date.now(), symbol));
    clearTimeout(ageTimer);
    const timeLeft = snapshot?.updated_ms + (snapshot?.stale_after_ms || 180000) - Date.now();
    if (!snapshot?.stale && timeLeft > 0 && timeLeft < 86400000) ageTimer = setTimeout(render, timeLeft + 100);
  };
  const load = async (active = () => card.isConnected) => {
    const version = ++request;
    const next = await J("market.json").catch(() => null);
    if (!active() || version !== request || !next) return;
    markets = next.derivs || {};
    render();
  };
  const inspectBar = (event) => {
    const bar = event.target.closest(".hl-bin");
    if (bar) $(".hl-chart-readout", map).textContent = bar.getAttribute("aria-label");
  };
  map.addEventListener("mouseover", inspectBar);
  map.addEventListener("focusin", inspectBar);
  selector.onchange = render;
  pageCleanup.push(() => clearTimeout(ageTimer));
  render();
  onData(["market.json"], load);
  void load();
}

function hyperliquidChart(levels, mark, qty, usd) {
  if (!Number.isFinite(mark) || mark <= 0) return '<p class="note">等待 Hyperliquid 標記價，強平價位請見下方。</p>';
  const bins = levels.filter(r => r.estimated_notional > 0 && Number.isFinite(r.estimated_notional)
    && !r.crossed_mark && !(r.distance_pct < 0)
    && (r.side === "long" ? r.price_low < mark : r.price_high > mark)).map(r => ({
    ...r, left: r.side === "short" ? Math.max(r.price_low, mark) : r.price_low,
    right: r.side === "long" ? Math.min(r.price_high, mark) : r.price_high,
  }));
  if (!bins.length) return '<p class="note">目前樣本沒有可繪製的未觸發強平區間。</p>';
  const left = 68, right = 752, top = 30, bottom = 190;
  const low = Math.min(mark, ...bins.map(r => r.left));
  const high = Math.max(mark, ...bins.map(r => r.right));
  const maxBar = Math.max(...bins.map(r => r.estimated_notional));
  const longs = bins.filter(r => r.side === "long").sort((a, b) => b.right - a.right);
  const shorts = bins.filter(r => r.side === "short").sort((a, b) => a.left - b.left);
  const total = rows => rows.reduce((sum, r) => sum + r.estimated_notional, 0);
  const maxTotal = Math.max(total(longs), total(shorts));
  const x = price => left + (right - left) * (price - low) / (high - low);
  const y = (amount, max) => bottom - (bottom - top) * amount / max;
  const center = r => x((r.left + r.right) / 2);
  const xMark = x(mark);
  const ticks = [0, .25, .5, .75, 1].map(t => {
    const v = y(t, 1);
    const price = low + t * (high - low);
    return `<line class="hl-grid" x1="${left}" x2="${right}" y1="${v}" y2="${v}"/>
      <text x="${left - 8}" y="${v + 4}" text-anchor="end">${usd(maxBar * t)}</text>
      <text x="${right + 8}" y="${v + 4}">${usd(maxTotal * t)}</text>
      <text x="${x(price)}" y="${bottom + 19}" text-anchor="middle">${fmtPrice(price, high < 1000 ? 2 : 0)}</text>`;
  }).join("");
  const line = (rows, side) => {
    if (!rows.length) return "";
    let cumulative = 0;
    const steps = rows.map(r => {
      cumulative += r.estimated_notional;
      return `H${center(r)}V${y(cumulative, maxTotal)}`;
    }).join("");
    return `<path class="hl-line ${side}" data-side="${side}" d="M${xMark},${bottom}${steps}" aria-hidden="true"/>`;
  };
  return `<div class="hl-legend"><span class="down">■ 多單預估強平</span><span class="up">■ 空單預估強平</span><span class="muted">━ 同方向由標記價起累積</span></div>
    <p class="hl-scroll-hint note">圖表可左右滑動。</p><div class="hl-chart-scroll">
      <svg class="hl-chart" viewBox="0 0 820 221" role="group" aria-label="強平金額分布。左軸為單區間金額，右軸為從標記價起累積金額。">
        <text x="${left}" y="13">區間金額</text><text x="${right}" y="13" text-anchor="end">累積金額</text>
        ${ticks}
        ${bins.map(r => {
          const height = bottom - y(r.estimated_notional, maxBar);
          const width = Math.max(3, x(r.right) - x(r.left) - 2);
          const detail = `${r.side === "long" ? "多單" : "空單"} ${fmtPrice(r.price_low, 2)}–${fmtPrice(r.price_high, 2)}・${qty(r.size)}・${usd(r.estimated_notional)}`;
          return `<g class="hl-bin ${r.side}" data-sync-key="${r.side}-${r.price_low}" tabindex="0" role="img" aria-label="${esc(detail)}">
            <title>${esc(detail)}</title><rect x="${center(r) - width / 2}" y="${bottom - height}" width="${width}" height="${height}" rx="1"/></g>`;
        }).join("")}
        ${line(longs, "long")}${line(shorts, "short")}
        <line class="hl-mark" x1="${xMark}" x2="${xMark}" y1="${top}" y2="${bottom}"/>
        <text class="hl-mark-label" x="${Math.min(right - 68, Math.max(left + 68, xMark))}" y="${top - 6}" text-anchor="middle">標記價 ${fmtPrice(mark, 2)}</text>
      </svg>
    </div><p class="hl-chart-readout note" aria-live="polite">移到或聚焦色柱以查看價位與金額。</p>`;
}

function hyperliquidPanel(snapshot, now = Date.now(), symbol = "BTC") {
  const coverage = snapshot?.coverage || {};
  const market = snapshot?.market || {};
  const updated = snapshot?.updated_ms;
  const hasSnapshot = Number.isFinite(updated) && updated > 0 && Number.isFinite(new Date(updated).getTime());
  const stale = hasSnapshot && (snapshot.stale || now - updated > (snapshot.stale_after_ms || 180000));
  const partial = snapshot?.status === "partial" || coverage.discovery_live === false
    || (Number.isFinite(coverage.valid) && coverage.valid < coverage.checked);
  let status = "已更新";
  if (partial) status = "部分資料";
  if (stale) status = "快照過期";
  if (!hasSnapshot) status = snapshot?.stale && snapshot?.status !== "等待首次樣本" ? "資料來源暫時無法讀取" : "等待資料";
  else if (!stale && snapshot.status === "等待公開成交樣本") status = "等待地址樣本";
  const head = `<span class="chip-muted ${stale || partial ? "warn" : ""}" role="status">${status}</span>`;
  if (!hasSnapshot) return head + '<p class="note">等待 Hyperliquid 官方資料與鯨魚地址樣本。</p>';

  const positive = n => Number.isFinite(n) && n > 0;
  const count = n => Number.isInteger(n) && n >= 0 ? fmtPrice(n, 0) : "—";
  const unit = ["BTC", "ETH", "ZEC"].includes(symbol) ? symbol : "BTC";
  const qty = n => Number.isFinite(n) && n >= 0 ? fmtPrice(n, n > 0 && n < .01 ? 6 : 2) + " " + unit : "—";
  const size = row => row.size ?? row.size_btc;
  const firstOrder = row => row.first_order_size ?? row.first_order_btc;
  const usd = n => Number.isFinite(n) && n >= 0 ? "$" + fmtBig(n) : "—";
  const distance = (n, crossed = false) => {
    if (crossed || n < 0) return "・標記價已越過預估價（待確認）";
    return Number.isFinite(n) ? "・距標記價 " + n.toFixed(2) + "%" : "";
  };
  const levels = (Array.isArray(snapshot.levels) ? snapshot.levels : []).filter(r =>
    r && ["long", "short"].includes(r.side) && positive(r.price_low) && positive(r.price_high)
    && r.price_high > r.price_low && positive(size(r))).map(r => ({...r, size: size(r)}));
  const maxSize = Math.max(1, ...levels.map(r => r.size));
  const positions = (Array.isArray(snapshot.positions) ? snapshot.positions : []).filter(p =>
    p && ["long", "short"].includes(p.side) && positive(p.liquidation_price) && positive(size(p)));
  const largest = rows => rows.slice().sort((a, b) => size(b) - size(a));
  const bands = (side, label, style) => {
    const rows = largest(levels.filter(r => r.side === side)).slice(0, 6);
    return `<section class="hl-side ${style}"><h3>${label}</h3>${rows.length ? `<ul class="hl-levels">
      ${rows.map(r => `<li><div class="hl-pair num"><b>${fmtPrice(r.price_low, Number.isInteger(r.price_low) ? 0 : 2)}–${fmtPrice(r.price_high, Number.isInteger(r.price_high) ? 0 : 2)}</b><b>${qty(r.size)}</b></div>
        <div class="hl-bar" aria-hidden="true"><i style="width:${(100 * (r.size / maxSize)).toFixed(1)}%"></i></div>
        <small class="muted">${usd(r.estimated_notional)}・${count(r.positions)} 筆${distance(r.distance_pct)}</small></li>`).join("")}</ul>`
      : '<p class="note">樣本內未取得此方向的有效強平價。</p>'}</section>`;
  };
  const topPositions = ["long", "short"].flatMap(side => largest(positions.filter(p => p.side === side)).slice(0, 5));
  const detail = topPositions.length ? `<details class="hl-details" id="hl-whales">
    <summary>個別鯨魚強平價與持倉量（每側依大小列前五筆）</summary>
    <ul class="hl-positions">${topPositions.map(p => `<li><span class="${p.side === "long" ? "down" : "up"}">${p.side === "long" ? "多單" : "空單"}</span>
      <b class="num">${fmtPrice(p.liquidation_price, 2)}</b><b class="num">${qty(size(p))}</b>
      <small class="muted">${p.margin_mode === "cross" ? "全倉・" : p.margin_mode === "isolated" ? "逐倉・" : ""}${usd(p.estimated_notional)}${distance(p.distance_pct, p.crossed_mark)}${positive(firstOrder(p)) ? "・預估首輪 " + qty(firstOrder(p)) : ""}</small></li>`).join("")}</ul>
  </details>` : "";
  const realized = snapshot.realized;
  const observed = positive(realized?.observed_addresses) ? `近 ${count(realized.window_hours)} 小時抽樣 ${count(realized.observed_addresses)} 個地址
    ・${count(realized.count)} 筆・<span class="down">多單 ${qty(realized.long_size ?? realized.long_btc)}</span>／<span class="up">空單 ${qty(realized.short_size ?? realized.short_btc)}</span>`
    : "尚無可用的已發生成交樣本。";
  const minSize = coverage.min_size ?? coverage.min_size_btc;
  const minNotional = coverage.min_notional_usd;
  const threshold = positive(minNotional) ? "US$" + fmtPrice(minNotional, Number.isInteger(minNotional) ? 0 : 2)
    + (positive(minSize) ? "（約 " + qty(minSize) + "）" : "")
    : positive(minSize) ? qty(minSize) : "";
  return `<div class="hl-meta muted">${head}
    <span>${unit} 標記價 <b class="num">${positive(market.mark_price) ? fmtPrice(market.mark_price, 2) : "—"}</b></span>
    <span>更新 ${fmtTime(updated)}（台北）</span>
    <span>候選 ${count(coverage.candidates)}・本輪讀取 ${count(coverage.valid)}／${count(coverage.checked)} 地址</span>
    <span>追蹤 ${count(coverage.tracked)} 倉・有強平價 ${count(coverage.with_liquidation_px)} 倉</span>
    ${threshold ? `<span>持倉門檻 ${threshold}</span>` : ""}</div>
    ${hyperliquidChart(levels, market.mark_price, qty, usd)}
    <div class="hl-sides">${bands("long", "多單強平（賣壓）", "down")}${bands("short", "空單強平（買壓）", "up")}</div>
    ${detail}<p class="hl-observed"><b>已發生強平</b>・${observed}</p>
    <p class="note">強平地圖僅涵蓋追蹤地址。圖表色柱依預估名目金額繪製，累積線從標記價向外加總。下方每側依持倉量列前六區，區間上界不含。實際成交另計。</p>`;
}

/* 幣種研究 */
const chartPrefs = Object.assign({ ma: true, bb: false, vol: true, sub: "rsi", type: "candle" }, JSON.parse(localStorage.getItem("chartPrefs") || "{}"));
async function pageCoin(sym, params) {
  const view = location.hash;
  sym = coinKey(sym);
  if (!WATCH.includes(sym)) { try { WATCH = (await api("/api/crypto/overview")).items.map((i) => i.symbol); } catch (e) {} }
  if (!WATCH.includes(sym)) { $("#app").innerHTML = `<div class="card"><div class="empty-state"><b>${esc(sym)} 不在追蹤清單</b><small>公開版只提供 BTC、ETH、ZEC。</small><a class="btn mint" href="#/">回到總覽</a></div></div>`; return; }
  lastCoin = sym; localStorage.setItem("lastCoin", sym); renderNav("coin");
  let tf = Object.hasOwn(TF_LABEL, params.get("tf")) ? params.get("tf") : "4h";
  const initialBars = MK.ensureBars(sym, tf);
  let s = await api(`/api/crypto/symbol/${sym}`);
  if (view !== location.hash) return;
  const base = s.base;
  setTitle("幣種研究", "即時資料・Binance USDC 永續");
  const stars = JSON.parse(localStorage.getItem("stars") || "[]");
  const fg = s.sentiment;
  const fgSeg = fg ? Math.max(1, Math.min(5, Math.ceil(fg.value / 20))) : 0;
  const fgCls = !fg ? "" : fg.value < 45 ? "down" : fg.value > 55 ? "up" : "warn";
  const rk = s.risk;
  const layout = () => `
  <div class="det-head">${coinIcon(base, 38)}<select class="coin-select sym" id="coin-symbol" aria-label="選擇研究幣種">${WATCH.map(s => `<option value="${esc(s)}" ${s === sym ? "selected" : ""}>${esc(baseOf(s))}</option>`).join("")}</select><button class="star ${stars.includes(sym) ? "on" : ""}" id="star" title="加入關注">${stars.includes(sym) ? "★" : "☆"}</button>
    <span class="nm">${esc(s.name)}・${esc(sym)}</span>${s.ai_status === "running" ? `<span class="pill run">● AI 分析中</span>` : s.ai ? `<span class="pill ${DIRS[s.ai.decision].pill}">AI：${DIRS[s.ai.decision].t}・${esc(fmtTime(s.ai.created_at))}</span>` : `<span class="pill gray">${smallIc("hourglass", 13)}尚未執行 AI 分析</span>`}
    <span class="pill done">● 即時行情</span></div>
  <div class="grid-4" style="margin-top:14px">
    <div class="card kcard"><small>價格（即時）</small><div class="row"><span class="big num" id="k-px">${fmtPrice(s.ticker?.last)}</span><span class="num" id="k-chg"></span></div><small class="num" id="k-hl"></small></div>
    <div class="card kcard"><small>市場情緒 <span class="dim" title="${esc(fg?.source || "")}">恐懼貪婪指數・全市場</span></small><div class="row"><span class="big ${fgCls}">${fg ? esc(fg.label) : "—"} <span class="num" style="font-size:18px">${fg ? fg.value : ""}</span></span>
      <span class="meter ${fgCls === "down" ? "red" : fgCls === "warn" ? "amber" : ""}">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= fgSeg ? "on" : ""}" style="height:${6 + n * 3}px"></i>`).join("")}</span></div><small>${fg ? "alternative.me・" + fmtTime(fg.time) : "載入中"}</small></div>
    <div class="card kcard"><small>波動風險 <span class="dim">ATR(14)／價格・4小時</span></small><div class="row"><span class="big ${riskTxt(rk)}">${rk ? esc(rk.level) : "—"}</span>
      <span class="meter ${rk && rk.score >= 3 ? "red" : rk && rk.score === 2 ? "amber" : ""}">${[1, 2, 3, 4].map((n) => `<i class="${rk && n <= rk.score ? "on" : ""}" style="height:${6 + n * 4}px"></i>`).join("")}</span></div><small class="num">ATR ${rk ? rk.atr_pct + "%" : "—"}</small></div>
    ${teamCard(s)}
  </div>
  <div class="grid-det">
    <section class="card">
      <div class="card-h"><div class="tabs" id="tf-tabs">${["5m", "1h", "4h", "1d"].map((t) => `<button class="tab outline ${t === tf ? "active" : ""}" data-tf="${t}">${TF_LABEL[t]}</button>`).join("")}</div>
        <div class="right">
          <div class="dd"><button class="btn sm" id="dd-type">${ICON.coin}<span id="type-lbl">${chartPrefs.type === "line" ? "折線" : "K 線"}</span> ▾</button>
            <div class="dd-menu" id="m-type" hidden><label><input type="radio" name="ct" value="candle" ${chartPrefs.type !== "line" ? "checked" : ""}> K 線</label><label><input type="radio" name="ct" value="line" ${chartPrefs.type === "line" ? "checked" : ""}> 折線</label></div></div>
          <div class="dd"><button class="btn sm" id="dd-ind">${ICON.pulse}技術指標 ▾</button>
            <div class="dd-menu" id="m-ind" hidden>
              <label><input type="checkbox" data-p="ma" ${chartPrefs.ma ? "checked" : ""}> MA20 / MA60</label>
              <label><input type="checkbox" data-p="bb" ${chartPrefs.bb ? "checked" : ""}> 布林通道（20, 2）</label>
              <label><input type="checkbox" data-p="vol" ${chartPrefs.vol ? "checked" : ""}> 成交量</label><hr>
              <label><input type="radio" name="sub" value="rsi" ${chartPrefs.sub === "rsi" ? "checked" : ""}> 副圖：RSI(14)</label>
              <label><input type="radio" name="sub" value="macd" ${chartPrefs.sub === "macd" ? "checked" : ""}> 副圖：MACD(12,26,9)</label>
              <label><input type="radio" name="sub" value="none" ${chartPrefs.sub === "none" ? "checked" : ""}> 不顯示副圖</label></div></div>
        </div></div>
      <div class="ohlc num" id="ohlc"></div>
      <div class="legend num" id="legend"></div>
      <div class="chart-box" id="main-chart"></div>
      <div class="legend num" id="sub-legend" style="margin-top:4px"></div>
      <div class="chart-box" id="sub-chart"></div>
    </section>
    <section class="card" id="coin-verdict">
      <div class="card-h"><h2>${ICON.spark}AI 綜合觀點</h2><div class="right">${s.ai ? `<a class="btn sm" href="#/report/${encodeURIComponent(s.ai.id)}">完整報告</a>${s.ai.pdf_url ? `<a class="btn sm" target="_blank" href="${esc(s.ai.pdf_url)}">PDF</a>` : ""}` : `<span class="chip-muted">尚未分析</span>`}</div></div>
      ${verdictHTML(s.ai, `<div class="v-side"><small>持有期間</small><b>${holdTxt(s.ai?.settings?.holding_period_days ?? s.ai?.result?.settings?.holding_period_days ?? 1)}</b><small>研究評等 ${esc(s.ai?.result?.research_rating || "—")}</small></div>`)}
      <div class="sub-h" style="color:var(--ink);font-size:14px;font-weight:700">綜合理由</div>
      <p class="muted" style="margin:0;font-size:13px;line-height:1.65">${s.ai ? esc(s.ai.result?.decision?.executive_summary || "") : "尚未執行 AI 分析。由 12 位 AI 代理（技術、情緒、加密新聞、鏈上 / 衍生品分析師，多空辯論與風控審核）分析後，結論與理由會顯示在這裡。"}</p>
      <div class="factors"><div class="bull"><h4 class="up">看多因素</h4><ul id="f-bull"></ul></div><div class="bear"><h4 class="down">看空因素</h4><ul id="f-bear"></ul></div></div>
      <div class="note" style="margin-top:8px">${s.ai ? `失效條件：${esc(s.ai.result?.decision?.invalidation || "—")}` : "目前只列出 4 小時技術條件（指標計算，非 AI 判斷）。"}</div>
    </section>
  </div>
  <div class="grid-3">
    <section class="card"><div class="card-h"><h2>${ICON.chain}市場與鏈上數據</h2></div><table class="kv num" id="mkt"></table></section>
    <section class="card"><div class="card-h"><h2>${ICON.bolt}即時訊號</h2><div class="right tabs compact" id="sig-tabs">${[["", "全部"], ["5m", "5分"], ["1h", "1小時"], ["4h", "4小時"]].map(([k, t]) => `<button class="tab outline ${k === "" ? "active" : ""}" data-tf="${k}">${t}</button>`).join("")}</div></div><div class="feed" id="cfeed"></div></section>
    <section class="card"><div class="card-h"><div class="tabs" id="na-tabs"><button class="tab outline active" data-t="news">新聞重點</button><button class="tab outline" data-t="agents">AI 代理活動</button></div></div><div id="na-body"></div></section>
  </div>`;

  $("#app").innerHTML = layout();
  const coinView = $("#main-chart");
  $("#star").onclick = () => { const st = JSON.parse(localStorage.getItem("stars") || "[]"); const i = st.indexOf(sym); i >= 0 ? st.splice(i, 1) : st.push(sym); localStorage.setItem("stars", JSON.stringify(st)); $("#star").classList.toggle("on", i < 0); $("#star").textContent = i < 0 ? "★" : "☆"; };
  const renderFactors = () => {
  const ck = s.dims["4h"]?.checks || [];
  const dec = s.ai?.result?.decision;
  $("#f-bull").innerHTML = (dec ? dec.bull_factors.map((x) => `<li>${esc(x)}</li>`) : ck.filter((c) => c.bull).map((c) => `<li>${esc(c.name)}</li>`)).join("") || `<li class="muted">目前無</li>`;
  $("#f-bear").innerHTML = (dec ? dec.bear_factors.map((x) => `<li>${esc(x)}</li>`) : ck.filter((c) => !c.bull).map((c) => `<li>${esc(c.name.replace(">", "≤"))}</li>`)).join("") || `<li class="muted">目前無</li>`;

  };
  renderFactors();
  $("#coin-symbol").onchange = e => { location.hash = `#/coin/${e.target.value}?tf=${encodeURIComponent(tf)}`; };
  const renderMkt = () => {
    const t = live.tickers[sym] || s.ticker || {};
    const sn = s.snapshot || {};
    $("#mkt").innerHTML = [[`24h 成交量（${base}）`, fmtBig(t.volume)], ["24h 成交額（USDC）", fmtBig(t.quote_volume)],
      ["24h 成交筆數", t.trades ? t.trades.toLocaleString() : "—"], ["RSI(14)・4小時", sn.rsi != null ? `${sn.rsi.toFixed(1)}（${sn.rsi >= 70 ? "超買區" : sn.rsi <= 30 ? "超賣區" : sn.rsi >= 50 ? "動能偏多" : "動能偏弱"}）` : "—"],
      ["MACD 柱・4小時", sn.macd_hist != null ? `${fmtPrice(sn.macd_hist, 2)}（${sn.macd_hist > 0 ? "多方動能" : "空方動能"}）` : "—"],
      ["布林位置・4小時", sn.c != null && sn.bb_up != null ? (sn.c > sn.bb_up ? "高於上軌" : sn.c < sn.bb_lo ? "低於下軌" : sn.c >= sn.bb_mid ? "中軌上方" : "中軌下方") : "—"],
      ["MA20 / MA60・4小時", sn.ma20 != null && sn.ma60 != null ? (sn.ma20 > sn.ma60 ? "MA20 高於 MA60" : "MA20 低於 MA60") : "—"]].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("") +
      (dv ? [[`資金費率（Binance${dv.funding_interval_h ? "・每 " + dv.funding_interval_h + " 小時" : ""}）`, dv.funding_rate != null ? dv.funding_rate.toFixed(4) + "%" : "—"], ["未平倉量（Binance USDC 合約）", dv.oi_usd != null ? "$" + (dv.oi_usd / 1e9).toFixed(2) + "B" + (dv.oi_chg_24h != null ? `<small class="${signCls(dv.oi_chg_24h)}"> ${fmtPct(dv.oi_chg_24h)}</small>` : "") : "—"],
        ["多空帳戶比（Binance）", dv.ls_ratio != null ? dv.ls_ratio.toFixed(2) : "—"], ["OKX 清算 多 / 空（近 24 小時參考）", liquidationHTML(dv)]].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")
        : ["資金費率", "未平倉量", "多空帳戶比", "近 24h 清算"].map((a) => `<tr class="pending"><td>${a}</td><td>載入中…</td></tr>`).join(""));
  };
  let dv = null;
  renderMkt();
  api(`/api/crypto/ai/derivs/${sym}`).then((x) => { dv = x; if (coinView.isConnected) renderMkt(); }).catch(() => {});
  const renderPx = (t) => {
    if (!t) return;
    $("#k-px").textContent = fmtPrice(t.last);
    const chg = t.last - t.open;
    $("#k-chg").innerHTML = `<span class="${signCls(chg)}">${chg > 0 ? "+" : ""}${fmtPrice(chg)} (${fmtPct(t.change_pct)})</span>`;
    $("#k-hl").textContent = `24h 高 ${fmtPrice(t.high)}・低 ${fmtPrice(t.low)}`;
  };
  renderPx(live.tickers[sym] || s.ticker);

  let newsItems = null;
  const renderNA = (t) => {
    const fnd = s.ai?.result?.findings || {};
    $("#na-body").innerHTML = t === "news"
      ? (newsItems == null ? `<div class="empty-state" style="height:240px">${ICON.news}<b>新聞載入中…</b></div>` : newsItems.length ? `<div class="feed" style="max-height:270px">${newsItems.map((n) => `<a class="sig" target="_blank" rel="noopener" href="${esc(n.link)}"><div class="sig-ic">${ICON.news}</div><div class="sig-b"><div class="sig-t"><b style="white-space:normal">${n.background ? '<span class="tf-tag">背景</span> ' : ""}${esc(n.title)}</b></div><div class="sig-d">${esc(n.source)}・${fmtTime(n.time)}</div></div></a>`).join("")}</div>`
        : `<div class="empty-state" style="height:240px">${ICON.news}<b>近 24 小時沒有相關新聞</b><small>來源：CoinDesk、Cointelegraph、Decrypt、The Block RSS</small></div>`)
      : `<div class="agents-list" style="max-height:270px;overflow:auto">${ROLES.map((r) => `<div class="ag" title="${esc(fnd[r.key] || "")}"><i style="${fnd[r.key] ? "background:var(--mint)" : ""}"></i><span style="min-width:0;flex:1"><b>${esc(r.name)}</b><small class="muted" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(fnd[r.key] || "等待中")}</small></span>${fnd[r.key] ? `<span class="pill done">已完成</span>` : `<span class="pill gray">等待中</span>`}</div>`).join("")}</div>`;
  };
  renderNA("news");
  api(`/api/crypto/ai/news/${sym}`).then((x) => { newsItems = x.items; if (coinView.isConnected && $("#na-tabs .tab.active")?.dataset.t === "news") renderNA("news"); }).catch(() => { newsItems = []; });
  $$("#na-tabs .tab").forEach((b) => b.onclick = () => { $$("#na-tabs .tab").forEach((x) => x.classList.toggle("active", x === b)); renderNA(b.dataset.t); });

  let sigTf = "";
  const loadSigs = async (newId) => {
    const rows = await api(`/api/crypto/signals?symbol=${sym}&limit=50${sigTf ? "&tf=" + sigTf : ""}`);
    const el = $("#cfeed"); if (!coinView.isConnected || !el) return;
    el.innerHTML = rows.map((x) => sigHTML(x, x.id === newId)).join("") || `<div class="empty-state"><b>尚無訊號</b></div>`;
  };
  loadSigs();
  $$("#sig-tabs .tab").forEach((b) => b.onclick = () => { sigTf = b.dataset.tf; $$("#sig-tabs .tab").forEach((x) => x.classList.toggle("active", x === b)); loadSigs(); });

  // ---------- charts
  const main = makeChart($("#main-chart"), 400);
  const sub = makeChart($("#sub-chart"), 130);
  const candle = main.addCandlestickSeries({ ...CANDLE });
  const closeLine = main.addLineSeries({ color: "#0ecb81", lineWidth: 2, visible: false });
  const ma20 = main.addLineSeries({ color: "#0ecb81", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const ma60 = main.addLineSeries({ color: "#f5b041", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const bbo = { color: "rgba(167,139,250,.75)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const bbU = main.addLineSeries(bbo), bbL = main.addLineSeries(bbo), bbM = main.addLineSeries({ ...bbo, lineStyle: 2 });
  const vol = main.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
  main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  main.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });
  const rsiS = sub.addLineSeries({ color: "#a78bfa", lineWidth: 1.5, priceLineVisible: false, priceFormat: { type: "custom", formatter: (v) => v.toFixed(1) } });
  rsiS.createPriceLine({ price: 70, color: "rgba(246,70,93,.6)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true });
  rsiS.createPriceLine({ price: 30, color: "rgba(14,203,129,.6)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true });
  const mfmt = { type: "custom", formatter: (v) => fmtPrice(v, Math.abs(v) >= 10 ? 1 : 3) };
  const macdH = sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: mfmt });
  const macdL = sub.addLineSeries({ color: "#0ecb81", lineWidth: 1.2, priceLineVisible: false, lastValueVisible: false, priceFormat: mfmt });
  const macdS = sub.addLineSeries({ color: "#f5b041", lineWidth: 1.2, priceLineVisible: false, lastValueVisible: false, priceFormat: mfmt });
  sub.applyOptions({ localization: { locale: "zh-TW" } });
  let syncing = false;
  main.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (syncing || !r) return; syncing = true; sub.timeScale().setVisibleLogicalRange(r); syncing = false; });
  sub.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (syncing || !r) return; syncing = true; main.timeScale().setVisibleLogicalRange(r); syncing = false; });

  let bars = [], byTime = new Map(), hovering = false;
  const volPt = (b) => ({ time: tt(b.t), value: b.v, color: b.c >= b.o ? "rgba(14,203,129,.45)" : "rgba(246,70,93,.45)" });
  const histPt = (b) => (b.macd_hist == null ? { time: tt(b.t) } : { time: tt(b.t), value: b.macd_hist, color: b.macd_hist >= 0 ? "rgba(14,203,129,.6)" : "rgba(246,70,93,.6)" });
  const applyPrefs = () => {
    candle.applyOptions({ visible: chartPrefs.type !== "line" }); closeLine.applyOptions({ visible: chartPrefs.type === "line" });
    [ma20, ma60].forEach((x) => x.applyOptions({ visible: chartPrefs.ma })); [bbU, bbL, bbM].forEach((x) => x.applyOptions({ visible: chartPrefs.bb }));
    vol.applyOptions({ visible: chartPrefs.vol });
    rsiS.applyOptions({ visible: chartPrefs.sub === "rsi" }); [macdH, macdL, macdS].forEach((x) => x.applyOptions({ visible: chartPrefs.sub === "macd" }));
    $("#sub-chart").style.display = $("#sub-legend").style.display = chartPrefs.sub === "none" ? "none" : "";
    main.applyOptions({ timeScale: { visible: chartPrefs.sub === "none" } });
    localStorage.setItem("chartPrefs", JSON.stringify(chartPrefs));
  };
  const header = (b) => {
    if (!b) return;
    const i = bars.findIndex((x) => x.t === b.t), prev = i > 0 ? bars[i - 1] : null;
    const chg = prev ? b.c - prev.c : null, pct = prev ? (chg / prev.c) * 100 : null;
    $("#ohlc").innerHTML = `<b>${esc(base)}</b><span>${TF_LABEL[tf]}</span><span class="dim">${fmtTime(b.t)}</span><span>開 <b>${fmtPrice(b.o)}</b></span><span>高 <b>${fmtPrice(b.h)}</b></span><span>低 <b>${fmtPrice(b.l)}</b></span><span>收 <b>${fmtPrice(b.c)}</b></span>` +
      (chg != null ? `<span>漲跌 <b class="${signCls(chg)}">${chg > 0 ? "+" : ""}${fmtPrice(chg)} (${fmtPct(pct)})</b></span>` : "") + `<span>成交量 <b>${fmtBig(b.v)}</b></span>`;
    $("#legend").innerHTML = (chartPrefs.ma ? `<span style="color:#0ecb81"><i style="background:#0ecb81"></i>MA20 ${fmtPrice(b.ma20)}</span><span style="color:#f5b041"><i style="background:#f5b041"></i>MA60 ${fmtPrice(b.ma60)}</span>` : "") +
      (chartPrefs.bb ? `<span style="color:#a78bfa"><i style="background:#a78bfa"></i>BB 上 ${fmtPrice(b.bb_up)}・下 ${fmtPrice(b.bb_lo)}</span>` : "");
    $("#sub-legend").innerHTML = chartPrefs.sub === "rsi" ? `<span style="color:#a78bfa">RSI(14) ${b.rsi != null ? b.rsi.toFixed(2) : "—"}</span><span class="dim">70 超買 / 30 超賣</span>`
      : chartPrefs.sub === "macd" ? `<span style="color:#0ecb81">MACD ${b.macd != null ? b.macd.toFixed(3) : "—"}</span><span style="color:#f5b041">訊號 ${b.macd_signal != null ? b.macd_signal.toFixed(3) : "—"}</span><span class="${signCls(b.macd_hist)}">柱 ${b.macd_hist != null ? b.macd_hist.toFixed(3) : "—"}</span>` : "";
  };
  main.subscribeCrosshairMove((p) => { if (!p.time) { hovering = false; header(bars[bars.length - 1]); return; } hovering = true; header(byTime.get(p.time)); });
  let chartTf;
  const loadTf = async (keepRange = false) => {
    const selected = tf;
    const k = await api(`/api/crypto/klines/${sym}?tf=${selected}&limit=${selected === "1d" ? 365 : 300}`);
    if (selected !== tf || !coinView.isConnected) return;
    const visible = keepRange ? main.timeScale().getVisibleLogicalRange() : null;
    chartTf = selected;
    bars = k.bars; byTime = new Map(bars.map((b) => [tt(b.t), b]));
    candle.setData(bars.map((b) => ({ time: tt(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    closeLine.setData(lineData(bars, "c"));
    ma20.setData(lineData(bars, "ma20")); ma60.setData(lineData(bars, "ma60"));
    bbU.setData(lineData(bars, "bb_up")); bbL.setData(lineData(bars, "bb_lo")); bbM.setData(lineData(bars, "bb_mid"));
    vol.setData(bars.map(volPt));
    rsiS.setData(lineData(bars, "rsi")); macdL.setData(lineData(bars, "macd")); macdS.setData(lineData(bars, "macd_signal")); macdH.setData(bars.map(histPt));
    const n = bars.length;
    if (n) main.timeScale().setVisibleLogicalRange(visible || { from: Math.max(0, n - 120), to: n + 3 });
    header(bars[n - 1]);
  };
  const priceLines = [];
  const renderPriceLines = () => {
    for (const line of priceLines.splice(0)) candle.removePriceLine(line);
    if (!s.ai || s.ai.decision === "WAIT") return;
    for (const [price, color, title] of [[s.ai.entry, "#0ecb81", "AI 進場"], [s.ai.stop, "#f6465d", "停損"], [s.ai.take_profit, "#0ecb81", "停利"]]) {
      if (price != null) priceLines.push(candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    }
  };
  applyPrefs();
  const firstTf = tf;
  void initialBars.then(() => { if (tf === firstTf && coinView.isConnected) return loadTf(); });
  renderPriceLines();
  void initialBars.then(() => MK.warmHistory([sym], MK.sigTfs())).then(() => {
    if (!coinView.isConnected) return;
    s = { ...s, ...MK.summary(sym) };
    renderMkt(); renderFactors(); loadSigs();
  });
  $$("#tf-tabs .tab").forEach((b) => b.onclick = async () => { tf = b.dataset.tf; $$("#tf-tabs .tab").forEach((x) => x.classList.toggle("active", x === b)); history.replaceState(null, "", `#/coin/${sym}?tf=${tf}`); await loadTf(); });
  const toggleMenu = (btn, menu) => { $(btn).onclick = (e) => { e.stopPropagation(); const m = $(menu); const h = m.hidden; $$(".dd-menu").forEach((x) => x.hidden = true); m.hidden = !h; }; $(menu).onclick = (e) => e.stopPropagation(); };
  toggleMenu("#dd-type", "#m-type"); toggleMenu("#dd-ind", "#m-ind");
  const closeMenus = () => $$(".dd-menu").forEach((x) => x.hidden = true);
  document.addEventListener("click", closeMenus); pageCleanup.push(() => document.removeEventListener("click", closeMenus));
  $$("#m-ind input[type=checkbox]").forEach((c) => c.onchange = () => { chartPrefs[c.dataset.p] = c.checked; applyPrefs(); header(bars[bars.length - 1]); });
  $$("#m-ind input[name=sub]").forEach((c) => c.onchange = () => { chartPrefs.sub = c.value; applyPrefs(); header(bars[bars.length - 1]); });
  $$("#m-type input").forEach((c) => c.onchange = () => { chartPrefs.type = c.value; $("#type-lbl").textContent = c.value === "line" ? "折線" : "K 線"; applyPrefs(); });

  on("ticker", (t) => { if (t.symbol === sym) { renderPx(live.tickers[sym]); renderMkt(); } });
  on("kline", (k) => {
    if (k.symbol !== sym || k.tf !== tf || k.tf !== chartTf) return;
    const b = k.bar, last = bars[bars.length - 1];
    if (last && b.t < last.t) return;
    if (last && b.t === last.t) bars[bars.length - 1] = b; else bars.push(b);
    byTime.set(tt(b.t), b);
    const T = tt(b.t);
    candle.update({ time: T, open: b.o, high: b.h, low: b.l, close: b.c }); closeLine.update({ time: T, value: b.c });
    const upd = (sr, key) => sr.update(b[key] != null ? { time: T, value: b[key] } : { time: T });
    upd(ma20, "ma20"); upd(ma60, "ma60"); upd(bbU, "bb_up"); upd(bbL, "bb_lo"); upd(bbM, "bb_mid"); upd(rsiS, "rsi"); upd(macdL, "macd"); upd(macdS, "macd_signal");
    macdH.update(histPt(b)); vol.update(volPt(b));
    if (!hovering) header(b);
  });
  on("history", (k) => { if (k.symbol === sym && k.tf === tf) void loadTf(true); });
  on("signal", (x) => { if (x.symbol === sym && (!sigTf || sigTf === x.tf)) loadSigs(x.id); });
  onData(["status.json", "recent.json", "runs.json", "market.json"], async (active) => {
    const [next, derivs, news] = await Promise.all([
      api(`/api/crypto/symbol/${sym}`),
      api(`/api/crypto/ai/derivs/${sym}`).catch(() => dv),
      api(`/api/crypto/ai/news/${sym}`).catch(() => null),
    ]);
    if (!active()) return;
    const aiChanged = s.ai?.id !== next.ai?.id;
    s = next; dv = derivs; if (news) newsItems = news.items;
    const temp = document.createElement("template"); temp.innerHTML = layout();
    for (const sel of [".det-head", "#coin-verdict"]) {
      const target = $(sel), source = $(sel, temp.content);
      if (target && source) patchHTML(target, source.innerHTML, "#coin-symbol,#star");
    }
    if (aiChanged) renderPriceLines();
    renderMkt(); renderFactors(); renderNA($("#na-tabs .tab.active").dataset.t);
  });
}

/* AI 團隊 */
async function pageTeam(params) {
  const view = location.hash;
  setTitle("AI 團隊研究室", "原版 12 位＋策略測試經理・獨立分工");
  let [ov, lv, aset, newPaper] = await Promise.all([api("/api/crypto/overview"), api("/api/crypto/ai/live"), api("/api/crypto/ai/settings"), J("new-paper.json").catch(() => null)]);
  WATCH = ov.items.map((i) => i.symbol);
  let sym = coinKey(params.get("symbol") || (lv.busy ? lv.current.symbol : lastCoin));
  if (!WATCH.includes(sym)) sym = WATCH[0];
  let A = aset.settings;
  const steps = [["資料分析", ["market", "sentiment", "news", "onchain"]], ["多空辯論", ["bull", "bear", "manager"]], ["交易評估", ["trader"]], ["風險審核", ["aggressive", "conservative", "neutral", "pm"]]];
  // 狀態：進行中的 run 或最近一次完成的 run
  let run = null, roles = {}, msgs = [], isLive = false;
  const loadState = async (active = () => true) => {
    const l = await api("/api/crypto/ai/live");
    if (!active()) return;
    if ((l.busy || ["paused","sync_stale"].includes(l.current?.status)) && l.current.symbol === sym) { isLive = !!l.busy; run = l.current; roles = l.current.roles; msgs = l.current.messages.slice(); return; }
    isLive = false;
    const rs = await api(`/api/crypto/ai/runs?symbol=${sym}&limit=1`);
    if (rs.length) {
      const detail = await api(`/api/crypto/ai/runs/${encodeURIComponent(rs[0].id)}`).catch(() => rs[0]);
      if (!active()) return;
      run = detail;
      const f = run.result?.findings || {}, mdl = run.models || {};
      roles = Object.fromEntries(ROLES.map((r) => [r.key, { status: run.status === "done" || f[r.key] ? "done" : run.status === "failed" ? "failed" : "waiting", finding: f[r.key], model: mdl[r.tier]?.used, score: run.result?.scores?.[r.key] }]));
      msgs = (run.events || []).filter((e) => e.kind === "message").map((e) => e.data);
    } else { run = null; roles = {}; msgs = []; }
  };
  await loadState();
  if (view !== location.hash) return;
  const plain = (t) => (t || "").replace(/^\s*\**\s*(Rating|Recommendation|FINAL TRANSACTION PROPOSAL)\b.*$/gim, "").replace(/^\s*[-*_]{3,}\s*$/gm, "").replace(/^\s*\|.*\|\s*$/gm, "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").replace(/^[-*]\s+/gm, "・").replace(/\n{2,}/g, "\n").trim();
  const simpleMd = (t) => esc(t || "").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#{1,6}\s*(.+)$/gm, "<h4>$1</h4>").replace(/\n/g, "<br>");
  const fullText = (k) => run?.result?.reports?.[k] || msgs.filter((m) => m.key === k).map((m) => m.text).join("\n\n");
  const fullHtml = (k) => run?.reports_html?.[k] || simpleMd(fullText(k));
  const debateTurns = () => run?.debate?.length ? run.debate : (() => { const c = {}; return msgs.filter((m) => ["bull", "bear", "aggressive", "conservative", "neutral"].includes(m.key)).map((m) => ({ stage: ["bull", "bear"].includes(m.key) ? "invest" : "risk", key: m.key, round: (c[m.key] = (c[m.key] || 0) + 1), ts: m.time, text: m.text, html: simpleMd(m.text) })); })();
  const openRole = (k) => {
    const r = ROLE[k] || { name: k }, st = roles[k] || {};
    const turns = debateTurns().filter((t) => t.key === k);
    const body = turns.length > 1 ? turns.map((t) => `<div class="turn"><div class="turn-h">第 ${t.round} 輪${t.ts ? `・${fmtTime(t.ts)}` : ""}</div><div class="md">${t.html}</div></div>`).join("") : `<div class="md">${fullHtml(k) || '<p class="muted">這個角色尚未產出內容。</p>'}</div>`;
    showSheet(`${smallIc(r.icon || "chat", 16)} ${esc(r.name)}<span class="mchip">${esc(r.team || "")}</span>`, `${st.score != null ? `<div class="chip-muted" style="margin-bottom:8px">多空分數 ${st.score}</div>` : ""}${st.finding ? `<div class="callout" style="margin:0 0 12px"><b>重點</b><span>${esc(st.finding)}</span></div>` : ""}${body}
      <p class="note">${run ? `${esc(baseOf(run.symbol))}・${fmtTime(run.created_at)}（台北）・模型 ${esc(st.model || run?.models?.[r.tier]?.used || "")}` : ""}</p>`);
  };
  const card = (r) => `<div class="agent" id="ag-${r.key}" tabindex="0" role="button" aria-label="${esc(r.name)}：查看完整報告"><div class="ah"><span class="ai">${ICON[r.icon]}</span><span class="an">${esc(r.name)}</span></div><p>${esc(r.desc)}</p><div class="find" data-f hidden></div><div class="prev" data-p hidden></div><button class="more" data-more hidden>展開全文 ▾</button><div class="af"><span class="pill gray" data-st>等待中</span><span class="tier">${r.tier === "deep" ? "深度思考" : "快速思考"}</span><span class="mchip" data-m></span></div><button type="button" class="more" data-debate="${r.key}">與他辯論（本機）</button></div>`;
  const col = (n) => ROLES.filter((r) => r.col === n).map(card).join("");
  $("#app").innerHTML = `
  ${noteHTML()}
  <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
    <span class="muted">標的</span><select class="select" id="team-sym" style="height:36px;min-width:150px">${WATCH.map((s) => `<option ${s === sym ? "selected" : ""} value="${s}">${baseOf(s)}・${s}</option>`).join("")}</select>
    <span class="muted" style="margin-left:10px">自動排程</span><span class="chip-muted">${A.schedule_enabled ? `每 ${A.schedule_interval_hours} 小時・${baseOf(A.schedule_symbol)}・下次 ${aset.next_run ? fmtTime(aset.next_run) : "—"}` : "已關閉"}</span>
    <span class="muted">持有期間</span><span class="chip-muted">${holdTxt(A.holding_period_days)}</span>
    <span class="muted">模型</span><span class="chip-muted" id="team-models"></span>
  </div>
  <section class="card cons-bar"><div class="cons-h"><h2>${ICON.target}目前共識</h2><span id="cons-st"></span></div><div id="cons" class="cons-body"></div></section>
  <section class="card" style="margin-top:16px;padding:0"><div class="graph" id="graph"><svg class="links" id="links"></svg>
    <div class="gcol">${col(0)}</div><div class="gcol">${col(1)}</div><div class="gcol">${col(2)}</div><div class="gcol">${col(3)}</div><div class="gcol">${col(4)}</div>${strategyBranchHTML(newPaper)}</div></section>
  <p class="note" style="margin:8px 2px 0">點任一角色卡可展開完整報告（Markdown 全文；辯論角色依輪次列出）。</p>
  <section class="card" style="margin-top:12px;padding:0"><div class="stepper" id="stepper"></div></section>
  <section class="card" style="margin-top:12px"><div class="prog">
    <svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" stroke="#333b47" stroke-width="5"/><circle id="ring" cx="22" cy="22" r="18" stroke="#0ecb81" stroke-width="5" stroke-dasharray="0 113" transform="rotate(-90 22 22)"/></svg>
    <b style="white-space:nowrap">研究進度</b><span class="muted" style="white-space:nowrap" id="pg-t"></span><div class="pbar"><i id="pg-bar" style="width:0%"></i></div><span class="num" id="pg-pct"></span>
    <span style="border-left:1px solid var(--line2);height:34px"></span>
    <span class="muted" id="pg-calls" style="white-space:nowrap;font-size:12.5px"></span>
    <span style="border-left:1px solid var(--line2);height:34px"></span>
    <b>${baseOf(sym)}</b><span class="num" id="tp-px" style="font-size:17px;font-weight:700">—</span><span class="num" id="tp-chg"></span><span id="tp-spark"></span>
  </div></section>`;
  // Keep the branch inside #graph, while original progress remains exactly 12 roles.
  const stepCard = $("#stepper").closest("section"), progressCard = $(".prog").closest("section");
  $("#app").prepend(stepCard, progressCard);
  const strategyCard = $("#ag-new-strategy");
  strategyCard.insertAdjacentHTML("beforeend",`<button type="button" class="more" data-debate="strategy">與他辯論（本機）</button>`);
  document.querySelectorAll("[data-debate]").forEach(el=>{ el.onclick=e=>{e.stopPropagation();showRoleDebate(el.dataset.debate,run?.id)}; el.onkeydown=e=>e.stopPropagation(); });
  strategyCard.onclick = () => showSheet("策略測試經理", strategyManagerHTML(newPaper));
  strategyCard.onkeydown = e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); strategyCard.click(); } };
  $("#team-sym").onchange = (e) => { location.hash = `#/team?symbol=${e.target.value}`; };
  const render = () => {
    const done = ROLES.filter((r) => roles[r.key]?.status === "done").length;
    ROLES.forEach((r) => {
      const st = roles[r.key] || { status: "waiting" }, el = $("#ag-" + r.key); if (!el) return;
      el.classList.toggle("running", st.status === "running"); el.classList.toggle("done", st.status === "done"); el.classList.toggle("failed", st.status === "failed");
      const p = $("[data-st]", el); p.className = "pill " + (st.status === "done" ? "done" : st.status === "running" ? "run" : st.status === "failed" ? "gray" : "gray");
      p.textContent = st.status === "done" ? "已完成" : st.status === "running" ? "進行中" : st.status === "failed" ? "未完成" : "等待中";
      const f = $("[data-f]", el); f.hidden = !st.finding; f.textContent = (st.score != null ? `【${st.score}】` : "") + (st.finding || "");
      const ft = plain(fullText(r.key)), pv = $("[data-p]", el), mb = $("[data-more]", el);
      pv.hidden = !ft; pv.textContent = (st.score != null ? `【${st.score}】` : "") + ft; mb.hidden = !ft; if (ft) f.hidden = true;
      $("[data-m]", el).textContent = st.model || (run?.models?.[r.tier]?.used || run?.models?.[r.tier]?.model || "");
      $("[data-m]", el).hidden = !$("[data-m]", el).textContent;
    });
    $("#stepper").innerHTML = steps.map(([nm, ks], i) => { const all = ks.every((k) => roles[k]?.status === "done"), any = ks.some((k) => roles[k]?.status === "running");
      return `${i ? `<div class="step-line ${all ? "done" : ""}"></div>` : ""}<div class="step ${all ? "done" : any ? "active" : ""}"><div class="c">${all ? "✓" : i + 1}</div><span>${nm}</span></div>`; }).join("") + `<div class="step-count"><b>${done}</b> / ${ROLES.length} 已完成</div>`;
    const pct = Math.round((done / ROLES.length) * 100);
    const lv = isLive ? run : null, rnm = lv?.running_role ? (ROLE_NAME[lv.running_role] || lv.running_role) : "";
    $("#pg-t").innerHTML = `${done} / ${ROLES.length} 已完成${run ? "・" + (isLive ? `執行中${rnm ? "・" + esc(rnm) : ""}・已執行 <span class="num" data-elapsed="${esc(run.started_at || run.created_at)}">${fmtDur(Date.now() - new Date(run.started_at || run.created_at))}</span>${lv?.last_issue ? `・<span class="tc-issue">${esc(lv.last_issue.text)}</span>` : ""}` : run.status === "done" ? `完成於 ${fmtTime(run.finished_at)}・耗時 ${Math.round(run.duration_s)} 秒${run.resumed ? `・補完成於 ${fmtTime(run.resumed.at)}` : ""}` : run.status === "failed" ? "失敗：" + esc(friendlyErr(run.error)) : run.status === "paused" ? "研究已暫停，進度已保存" : run.status === "sync_stale" ? "超過10分鐘未同步，研究狀態待確認" : "") : ""}`;
    $("#pg-bar").style.width = pct + "%"; $("#pg-pct").textContent = pct + "%"; $("#ring").setAttribute("stroke-dasharray", `${(pct / 100) * 113} 113`);
    const c = run?.calls; $("#pg-calls").textContent = c ? "呼叫次數 " + fmtCalls(c) + (c.reconstructed ? "＊" : "") : ""; $("#pg-calls").title = callsTitle(c);
    const m = run?.models; $("#team-models").textContent = m ? `快速 ${m.quick.used || m.quick.model}・深度 ${m.deep.used || m.deep.model}` : `快速 ${A.quick.model}・深度 ${A.deep.model}`; $("#team-models").title = m ? `快速：${m.quick.key}；深度：${m.deep.key}` : "";
    const dec = run?.result?.decision;
    if (dec) { const d = DIRS[dec.decision];
      $("#cons-st").innerHTML = `<span class="pill ${d.pill}">${d.t}</span>`;
      $("#cons").innerHTML = `<div class="cons-dir"><b class="${d.c}" style="font-size:24px">${d.t}</b><span class="muted">信心 ${dec.confidence}/100・風險 ${esc(dec.risk_level)}</span></div>
        <div class="lv cons-lv"><div><small>進場</small><b class="num">${fmtLv(dec.entry_price)}</b></div><div><small>停損</small><b class="num down">${fmtLv(dec.stop_loss)}</b></div><div><small>停利</small><b class="num up">${fmtLv(dec.take_profit)}</b></div><div><small>部位</small><b class="num">${dec.position_size_pct ?? "—"}%</b></div></div>
        <p class="ai-sum cons-sum">${esc(dec.executive_summary)}</p><a class="btn ghost-mint cons-link" href="#/report/${encodeURIComponent(run.id)}">完整報告 ›</a>`;
    } else { $("#cons-st").innerHTML = `<span class="pill mid">${isLive ? "分析中" : "等待分析"}</span>`; $("#cons").innerHTML = `<p class="muted" style="margin:0;font-size:13px">${isLive ? "投資組合經理完成最終決策後，會在這裡顯示做多 / 做空 / 觀望、進場、停損與停利。" : run?.status === "failed" ? "上次分析失敗：" + esc(friendlyErr(run.error)) : "尚無共識。"}</p>`; }
    requestAnimationFrame(draw);
  };
  $("#graph").addEventListener("click", (e) => { const a = e.target.closest(".agent"); if (a && a.id !== "ag-new-strategy") openRole(a.id.replace("ag-", "")); });
  $("#graph").addEventListener("keydown", (e) => { const a = e.target.closest(".agent"); if (a && a.id !== "ag-new-strategy" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRole(a.id.replace("ag-", "")); } });
  onData(["status.json", "runs.json", "settings.json", "new-paper.json"], async (active) => {
    const [settings, latestPaper] = await Promise.all([
      api("/api/crypto/ai/settings"), J("new-paper.json").catch(() => newPaper),
    ]);
    await loadState(active);
    if (!active()) return;
    A = settings.settings;
    if (latestPaper !== newPaper) {
      newPaper = latestPaper;
      const temp = document.createElement("template"); temp.innerHTML = strategyBranchHTML(newPaper);
      const next = $("#ag-new-strategy", temp.content);
      if (next) patchHTML(strategyCard, next.innerHTML + '<button type="button" class="more" data-debate="strategy">與他辯論（本機）</button>');
      const debate = $("[data-debate]", strategyCard);
      if (debate) { debate.onclick = e => { e.stopPropagation(); showRoleDebate("strategy", run?.id); }; debate.onkeydown = e => e.stopPropagation(); }
    }
    render();
  });

  const item = ov.items.find((i) => i.symbol === sym);
  let spark = item.spark.slice();
  const teamView = $("#tp-spark");
  void MK.ensureBars(sym, "1h").then(() => { if (teamView.isConnected) { spark = MK.summary(sym).spark; teamView.innerHTML = sparkSVG(spark, 160, 34); } });
  const px = (t) => { if (!t) return; $("#tp-px").textContent = fmtPrice(t.last); $("#tp-chg").innerHTML = `<span class="${signCls(t.change_pct)}">${fmtPct(t.change_pct)}</span>`; };
  px(live.tickers[sym] || item.ticker); $("#tp-spark").innerHTML = sparkSVG(spark, 160, 34);
  on("ticker", (t) => t.symbol === sym && px(t));
  on("kline", (k) => { if (k.symbol === sym && k.tf === "1h" && spark.length) { spark[spark.length - 1] = k.bar.c; $("#tp-spark").innerHTML = sparkSVG(spark, 160, 34); } });

  const links = [];
  ["market", "sentiment", "news", "onchain"].forEach((a) => links.push([a, "bull"], [a, "bear"]));
  links.push(["bull", "manager"], ["bear", "manager"], ["manager", "trader"]);
  ["aggressive", "conservative", "neutral"].forEach((r) => links.push(["trader", r], [r, "pm"]));
  function draw() {
    const g = $("#graph"); if (!g) return; const gb = g.getBoundingClientRect();
    const pt = (id, side) => { const b = $("#ag-" + id).getBoundingClientRect();
      return side === "r" ? [b.right - gb.left, b.top + b.height / 2 - gb.top] : side === "l" ? [b.left - gb.left, b.top + b.height / 2 - gb.top]
        : side === "b" ? [b.left + b.width / 2 - gb.left, b.bottom - gb.top] : [b.left + b.width / 2 - gb.left, b.top - gb.top]; };
    const on_ = (a, b) => roles[a]?.status === "done" && (roles[b]?.status === "done" || roles[b]?.status === "running");
    $("#links").innerHTML = `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="#0ecb81" stroke="none"/></marker></defs>` + links.map(([a, b]) => {
      const stc = on_(a, b) ? "rgba(14,203,129,.8)" : "rgba(14,203,129,.35)";
      if (a === "manager" && b === "trader") { const [x1, y1] = pt(a, "b"), [x2, y2] = pt(b, "t"); return `<path d="M${x1} ${y1} L${x2} ${y2 - 2}" stroke="${stc}" stroke-width="1.6" marker-end="url(#arr)"/>`; }
      const [x1, y1] = pt(a, "r"), [x2, y2] = pt(b, "l"); const mx = (x1 + x2) / 2;
      return `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 - 2} ${y2}" stroke="${stc}" stroke-width="1.6" marker-end="url(#arr)"/>`;
    }).join("");
    const [rx, ry] = pt("manager", "b"), reportBox = $("#strategy-research").getBoundingClientRect();
    const bx = reportBox.left + reportBox.width / 2 - gb.left, by = reportBox.top - gb.top;
    $("#links").insertAdjacentHTML("beforeend", `<path d="M${rx} ${ry} L${rx} ${by-12} L${bx} ${by-12} L${bx} ${by-2}" stroke="var(--mint)" stroke-width="1.6" marker-end="url(#arr)"/>`);
  }
  render(); setTimeout(draw, 300);
  window.addEventListener("resize", draw); pageCleanup.push(() => window.removeEventListener("resize", draw));
}

/* 模擬交易 / 研究報告 */
async function pagePaper() {
  const view = location.hash;
  setTitle("模擬交易", "只模擬・不下真實訂單");
  let P = await J("paper.json");
  if (view !== location.hash) return;
  let LEV = P.leverage || 10;
  const SIDE = { LONG: ["做多", "up"], SHORT: ["做空", "down"] };
  const ST = { pending: ["掛單中", "mid"], open: ["持倉中", "run"], closed: ["已平倉", "gray"], cancelled: ["已取消", "gray"], rejected: ["拒單", "high"], same_dir_refresh: ["同向更新", "gray"] };
  const usd = (x, d = 2) => (x == null || isNaN(x) ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
  const money = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const qtyTxt = (o) => `${Number(o.qty).toPrecision(4).replace(/\.?0+$/, "")} ${esc(baseOf(o.symbol))}`;
  const REASON = (r) => !r ? "—" : /停損/.test(r) ? "停損" : /停利/.test(r) ? "停利" : /到期/.test(r) ? "到期" : /反向/.test(r) ? "反向訊號" : r;
  const dur = (ms) => { if (ms == null) return "—"; const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return `${d ? d + "天" : ""}${d || h ? h + "小時" : ""}${mm}分鐘`; };
  const contract = (o) => `<div class="pc-name"><b>${esc(o.symbol)}</b><span class="tag">永續</span><span class="tag lev">${o.leverage || LEV}x</span></div>`;
  const runLink = (o) => {const id=o.position_review_id?o.report_id:o.run_id;return id?`<a class="ok" href="#/report/${encodeURIComponent(id)}">${o.position_review_id?"參考研究":"AI 報告"}</a>`:"";};
  const markOf = (o) => { const k = coinKey(o.symbol), m = MK.marks[k]; if (m) return m.px; const t = live.tickers[k] || MK.tickers[k]; return t ? t.last : o.mark_price; };
  const margin = (o) => o.margin || (o.notional ? o.notional / LEV : null);
  const unreal = (o) => { const mk = markOf(o); if (mk == null) return null; return (mk - o.fill_price) * o.qty * (o.side === "LONG" ? 1 : -1) + (o.funding_total || 0); };
  let hist = P.orders.filter((o) => o.status === "closed").sort((a, b) => b.close_ms - a.close_ms);
  let tab = pagePaper.tab || "pos", range = pagePaper.range || "3m";
  const pages = pagePaper.pages ||= {};
  const RANGES = [["1d", "一天", 1], ["1w", "一週", 7], ["1m", "一個月", 30], ["3m", "三個月", 90]];
  const layout = () => `

  <div class="ro-banner bot-note">${smallIc("info", 15)}<span>AI 團隊策略・虛擬 ${money(P.initial)} USDC・只做模擬</span></div>
  ${P.engine && P.engine.last_error && /Binance/.test(P.engine.last_error) ? `<div class="callout" style="margin-bottom:12px"><b>注意</b><span>後台暫時連不上 Binance：${esc(P.engine.last_error)}（不會改用其他交易所，恢復後自動補算）</span></div>` : ""}
  <div class="grid-4">
    <div class="card kcard"><small>目前權益（含未實現）</small><div class="row"><span class="big num" id="pp-eq">—</span></div><small class="num" id="pp-eq2"></small></div>
    <div class="card kcard"><small>已實現損益（含資金費）</small><div class="row"><span class="big num ${signCls(P.realized_pnl)}">${usd(P.realized_pnl)}</span></div><small class="num">價差 ${usd(P.price_pnl)}・資金費 ${usd(P.funding_net, 4)}</small></div>
    <div class="card kcard"><small>勝率</small><div class="row"><span class="big num">${P.win_rate == null ? "—" : P.win_rate + "%"}</span></div><small class="num">${P.wins} 勝 / ${P.trades} 筆已平倉</small></div>
    <div class="card kcard"><small>最大回撤（已實現權益）</small><div class="row"><span class="big num ${P.max_drawdown_pct > 0 ? "down" : ""}">${P.max_drawdown_pct.toFixed(2)}%</span></div><small class="num">依已實現權益（平倉 + 資金費）計算</small></div>
  </div>
  ${tradePanelHTML(P.open.length, P.pending.length)}
  <section class="card" style="margin-top:16px"><div class="card-h"><h2>${ICON.trendUp}權益曲線</h2><div class="right"><span class="chip-muted">已實現（平倉 + 資金費）＋ 目前含未實現</span></div></div>
    <div id="eq-chart" style="height:240px"></div></section>
  <div class="set-grid" style="margin-top:16px">
    <section class="card"><div class="card-h"><h2>${ICON.bolt}資金費紀錄（實際結算；v1.0.8 起為 Binance USDC 永續）</h2><div class="right"><span class="chip-muted num">已付 ${usd(P.funding_paid, 4)}・已收 ${usd(P.funding_received, 4)}</span></div></div>
      ${P.funding.length ? `<table class="tbl"><thead><tr><th>結算時間（台北）</th><th>合約</th><th>方向</th><th>費率</th><th>結算價</th><th>金額</th></tr></thead><tbody>
        ${P.funding.slice().reverse().map((f) => `<tr><td class="num">${fmtTime(f.funding_ms)}</td><td>${esc(f.symbol)}</td><td>${SIDE[f.side][0]}</td><td class="num">${(f.rate * 100).toFixed(4)}%</td><td class="num">${fmtPrice(f.price)}</td><td class="num ${signCls(f.payment)}">${usd(f.payment, 4)}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty-state" style="height:110px"><b>尚無資金費紀錄</b><small>持倉跨過 Binance 結算時間才會計入（BTC / ETH 每 8 小時：台北 00:00、08:00、16:00；ZEC 每 4 小時）。</small></div>`}</section>
    <section class="card"><div class="card-h"><h2>${ICON.people || ICON.shield}夜間持倉評估</h2></div><p class="note">投資組合經理於設定的停報時段每小時檢查原版現有持倉／委託，不產生新研究報告；價格保護持續運作。開關位於本機控制台。</p>
    ${(P.position_reviews||[]).length?`<div class="review-list">${P.position_reviews.map(r=>`<details class="din"><summary>${esc(baseOf(r.symbol))}・${fmtTime(r.created_at)}・${esc(({completed:"已評估",failed:"未完成",interrupted:"已中斷",running:"評估中",ready:"驗證中"})[r.status]||r.status)}・${esc(({HOLD:"續抱",CLOSE:"只平倉",REVERSE:"反手",UPDATE_RISK:"調整保護",CANCEL_ORDER:"取消委託",WAIT:"觀望"})[r.decision?.action]||"")}</summary><div class="note" style="padding:12px"><p>${esc(r.decision?.executive_summary||r.error||"等待評估結果")}</p><p>${esc(r.execution?.reason||"")}</p><p>下次檢查：${esc(r.decision?.invalidation||"—")}・模型 ${esc(r.model||"—")}</p>${r.report_id?`<a class="ok" href="#/report/${encodeURIComponent(r.report_id)}">參考研究</a>`:""}</div></details>`).join("")}</div>`:'<p class="note">尚無夜間評估紀錄；沒有持倉／委託時不呼叫AI。</p>'}</section>

  </div>`;

  $("#app").innerHTML = layout();
  const posBody = open => open.length ? `
    <table class="tbl pos-tbl"><thead><tr><th>合約</th><th>數量</th><th>開倉價格</th><th>標記價格</th><th>強平價格</th><th>保證金</th><th>盈虧（收益率）</th><th>停損 / 停利</th><th>到期時間（台北）</th><th></th></tr></thead><tbody>
    ${open.map((o) => `<tr><td>${contract(o)}<small class="dim">${o.margin_mode || "逐倉"}・${SIDE[o.side][0]}</small></td>
      <td class="num ${SIDE[o.side][1]}"><b>${qtyTxt(o)}</b></td><td class="num">${fmtPrice(o.fill_price)}</td><td class="num" data-pp-mk="${o.id}">—</td>
      <td class="num warn">${o.liq_price ? fmtPrice(o.liq_price) : "—"}</td><td class="num">${money(margin(o))}<small class="dim"> ${unitOf(o.symbol)}</small></td>
      <td class="num" data-pp-u="${o.id}">—</td><td class="num"><span class="down">${fmtPrice(o.stop)}</span> / <span class="up">${fmtPrice(o.take_profit)}</span></td>
      <td class="num">${fmtTime(o.hold_until)}</td><td>${runLink(o)}</td></tr>`).join("")}</tbody></table>
    <div class="pos-cards">${open.map((o) => `<div class="pcard">
      <div class="pc-h">${contract(o)}<span class="tag">${o.margin_mode || "逐倉"}</span><span class="tag ${o.side === "LONG" ? "t-up" : "t-down"}">${SIDE[o.side][0]}</span></div>
      <div class="pc-pnl"><div><small>盈虧（${unitOf(o.symbol)}）</small><b class="num" data-pp-u2="${o.id}">—</b></div><div class="r"><small>收益率</small><b class="num" data-pp-r2="${o.id}">—</b></div></div>
      <div class="pc-grid"><div><small>數量</small><b class="num ${SIDE[o.side][1]}">${qtyTxt(o)}</b></div><div><small>開倉價格</small><b class="num">${fmtPrice(o.fill_price)}</b></div><div><small>標記價格</small><b class="num" data-pp-mk2="${o.id}">—</b></div>
        <div><small>強平價格</small><b class="num warn">${o.liq_price ? fmtPrice(o.liq_price) : "—"}</b></div><div><small>保證金</small><b class="num">${money(margin(o))}</b></div><div><small>停損 / 停利</small><b class="num"><span class="down">${fmtPrice(o.stop)}</span> / <span class="up">${fmtPrice(o.take_profit)}</span></b></div></div>
      <div class="pc-foot">持有 ${o.hold_hours || P.hold_hours} 小時到期 ${fmtTime(o.hold_until)}（台北）・${runLink(o)}</div></div>`).join("")}</div>`
    : `<div class="empty-state" style="height:120px">${ICON.wallet}<b>目前沒有倉位</b><small>${P.pending.length ? `有 ${P.pending.length} 筆限價單等待成交（見「當前委託」）。` : "下一次 AI 做多 / 做空後會自動掛單。"}</small></div>`;
  const sideTag = (o) => `<span class="tag ${o.side === "LONG" ? "t-up" : "t-down"}">${SIDE[o.side]?.[0] || o.side}</span>`;
  const ordBody = () => P.pending.length ? `
    <table class="tbl pos-tbl ord-tbl"><thead><tr><th>合約</th><th>委託價格</th><th>最新成交價</th><th>停損</th><th>停利</th><th>AI 部位上限</th><th>信心</th><th>狀態</th><th>下單時間（台北）</th><th>取消時間（台北）</th><th></th></tr></thead><tbody>
    ${P.pending.map((o) => `<tr><td><div class="pc-name"><b>${esc(o.symbol)}</b><span class="tag">永續</span><span class="tag lev">${o.leverage || LEV}x</span><span class="tag">限價</span>${sideTag(o)}</div></td>
      <td class="num">${fmtPrice(o.entry)}</td><td class="num" data-pp-px="${o.symbol}">—</td><td class="num down">${fmtPrice(o.stop)}</td><td class="num up">${fmtPrice(o.take_profit)}</td>
      <td class="num">${o.ai_pct ?? "—"}%</td><td class="num">${o.confidence ?? "—"}</td><td><span class="pill mid">掛單中</span></td>
      <td class="num">${fmtTime(o.created_at)}</td><td class="num" title="${P.pending_hours} 小時內未觸及委託價即取消">${fmtTime(o.expires_at)}</td><td>${runLink(o)}</td></tr>`).join("")}</tbody></table>
    <div class="pos-cards">${P.pending.map((o) => `<div class="pcard">
      <div class="pc-h">${contract(o)}<span class="tag">限價</span>${sideTag(o)}<span class="pc-state">掛單中</span></div>
      <div class="pc-grid"><div><small>委託價格</small><b class="num">${fmtPrice(o.entry)}</b></div><div><small>最新成交價</small><b class="num" data-pp-px2="${o.symbol}">—</b></div><div><small>AI 部位上限</small><b class="num">${o.ai_pct ?? "—"}%</b></div>
        <div><small>停損</small><b class="num down">${fmtPrice(o.stop)}</b></div><div><small>停利</small><b class="num up">${fmtPrice(o.take_profit)}</b></div><div><small>信心</small><b class="num">${o.confidence ?? "—"}</b></div></div>
      <div class="pc-foot">下單 ${fmtTime(o.created_at)}・${P.pending_hours} 小時未觸及於 ${fmtTime(o.expires_at)} 取消（台北）・${runLink(o)}</div></div>`).join("")}</div>`
    : `<div class="empty-state" style="height:120px"><b>沒有掛單</b></div>`;
  const histBody = () => {
    const days = RANGES.find((r) => r[0] === range)[2], since = Date.now() - days * 86400000;
    const {rows, footer} = tradePage(hist.filter(o => o.close_ms >= since), pages, "hist");
    return `<div class="tabs compact pp-range" id="pp-range">${RANGES.map(([k, t]) => `<button class="tab outline ${k === range ? "active" : ""}" data-r="${k}">${t}</button>`).join("")}</div>
    ${rows.length ? `<div class="hist-rows">${rows.map((o) => `<article class="hist-row">
      <div class="hist-head"><div class="hist-contract">${coinIcon(baseOf(o.symbol), 22)}${contract(o)}<span class="tag">${esc(o.margin_mode || "逐倉")}</span><span class="tag ${o.side === "LONG" ? "t-up" : "t-down"}">${SIDE[o.side][0]}</span><span class="hist-state">完全平倉</span></div>
        <div class="hist-times"><span>開倉時間 <time class="num">${fmtTime(o.fill_at)}</time></span><span>最後平倉時間 <time class="num">${fmtTime(o.close_at)}</time></span><span>持續 ${dur(o.duration_ms ?? (o.close_ms - o.fill_ms))}</span></div></div>
      <dl class="hist-metrics"><div><dt>已實現盈虧（含資金費）</dt><dd class="num ${signCls(o.pnl_net)}">${usd(o.pnl_net)} ${unitOf(o.symbol)}</dd></div><div><dt>收益率</dt><dd class="num ${signCls(o.roi_pct)}">${o.roi_pct == null ? "—" : fmtPct(o.roi_pct)}</dd></div>
        <div><dt>已平倉量</dt><dd class="num">${qtyTxt({ ...o, qty: o.closed_qty || o.qty })}</dd></div><div><dt>開倉價格</dt><dd class="num">${fmtPrice(o.fill_price)}</dd></div><div><dt>平倉均價</dt><dd class="num">${fmtPrice(o.close_price)}</dd></div><div><dt>最大未平倉量</dt><dd class="num">${qtyTxt({ ...o, qty: o.max_qty || o.qty })}</dd></div></dl>
      <div class="hist-foot"><span>出場原因 <b class="${REASON(o.close_reason) === "停利" ? "up" : REASON(o.close_reason) === "停損" ? "down" : ""}">${esc(REASON(o.close_reason))}</b></span><span>價差 ${usd(o.pnl_price)}・資金費 ${usd(o.funding_total, 4)}</span>${runLink(o)}</div></article>`).join("")}</div>`
      : `<div class="empty-state" style="height:110px">${ICON.paper}<b>${RANGES.find((r) => r[0] === range)[1]}內沒有已平倉的倉位</b></div>`}${footer}`;
  };
  const renderTab = (next = tab) => {
    tab = TRADE_TABS.some(t => t[0] === next) ? next : "pos";
    pagePaper.tab = tab; pagePaper.range = range;
    selectTradeTab(tab);
    patchHTML($("#pp-body"), {pos:()=>{const {rows,footer}=tradePage(P.open,pages,"pos");return posBody(rows)+footer}, ord:ordBody, orders:()=>tradeOrdersHTML(P.orders,"original"), fills:()=>tradeFillsHTML(tradeFills(P,"original")), hist:histBody}[tab]());
    $$("#pp-range .tab").forEach(b => b.onclick = () => { range=b.dataset.r; pages.hist=0; renderTab(); });
    bindTradePager(pages,tab,renderTab);
    upd();
  };
  bindTradeTabs(renderTab);

  // 權益曲線
  const el = $("#eq-chart");
  const ch = makeChart(el, 240, { timeScale: { borderColor: "#333b47", timeVisible: true } });
  const area = ch.addAreaSeries({ lineColor: "#0ecb81", topColor: "rgba(14,203,129,.28)", bottomColor: "rgba(14,203,129,0)", lineWidth: 2, priceFormat: { type: "custom", formatter: (v) => money(v) } });
  const base = [];
  const loadCurve = () => { base.length = 0; P.curve.forEach((p) => { const t = Math.floor(p.t / 1000) + TZ_SHIFT; if (base.length && base[base.length - 1].time >= t) base[base.length - 1].value = p.equity; else base.push({ time: t, value: p.equity }); }); };
  loadCurve();
  area.createPriceLine({ price: P.initial, color: "rgba(129,147,173,.5)", lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: "起始" });
  const setTxt = (sel, html, cls) => $$(sel).forEach((e) => { e.innerHTML = html; if (cls != null) e.className = "num " + cls; });
  function upd() {
    let u = 0;
    P.open.forEach((o) => {
      const mk = markOf(o), v = unreal(o), m = margin(o), roi = v != null && m ? (v / m) * 100 : null;
      setTxt(`[data-pp-mk="${o.id}"],[data-pp-mk2="${o.id}"]`, mk == null ? "—" : fmtPrice(mk));
      if (v != null) {
        setTxt(`[data-pp-u="${o.id}"]`, `<b>${usd(v)} ${unitOf(o.symbol)}</b><br><span>${roi == null ? "" : fmtPct(roi)}</span>`, signCls(v));
        setTxt(`[data-pp-u2="${o.id}"]`, usd(v), signCls(v)); setTxt(`[data-pp-r2="${o.id}"]`, roi == null ? "—" : fmtPct(roi), signCls(v));
        u += v;
      }
    });
    P.pending.forEach((o) => { const t = live.tickers[coinKey(o.symbol)] || MK.tickers[coinKey(o.symbol)]; if (t) setTxt(`[data-pp-px="${o.symbol}"],[data-pp-px2="${o.symbol}"]`, fmtPrice(t.last)); });
    const eq = P.realized_equity + u;
    $("#pp-eq").textContent = money(eq); $("#pp-eq").className = "big num " + signCls(eq - P.initial);
    $("#pp-eq2").textContent = `${usd(eq - P.initial)} USDC（${fmtPct(((eq - P.initial) / P.initial) * 100)}）・未實現 ${P.open.length ? usd(u) : "—"}`;
    const now = Math.floor(Date.now() / 1000) + TZ_SHIFT;
    const pts = base.slice(); if (!pts.length || pts[pts.length - 1].time < now) pts.push({ time: now, value: eq });
    area.setData(pts);
  }
  renderTab(); ch.timeScale().fitContent();
  let last = 0; const th = () => { if (Date.now() - last > 1000) { last = Date.now(); upd(); } };
  on("ticker", th); on("mark", th);
  onData(["paper.json"], async (active) => {
    const next = await J("paper.json");
    if (!active() || next === P) return;
    const visible = ch.timeScale().getVisibleLogicalRange();
    P = next; LEV = P.leverage || 10;
    hist = P.orders.filter(o => o.status === "closed").sort((a, b) => b.close_ms - a.close_ms);
    patchHTML($("#app"), layout(), "#eq-chart,#pp-body,#pp-eq,#pp-eq2");
    loadCurve(); bindTradeTabs(renderTab); renderTab();
    if (visible) ch.timeScale().setVisibleLogicalRange(visible);
  });
}
async function pageReports() {
  setTitle("研究報告", "AI 團隊・繁體中文");
  const load = () => Promise.all([api("/api/crypto/ai/runs?limit=200"), J("ai-usage.json").catch(() => null)]);
  const layout = (runs, usage) => `${dailyUsageHTML(usage) || '<section class="card"><p class="note">每日 API 用量尚未推送。</p></section>'}<section class="card reports-list"><div class="card-h"><h2>${ICON.report}加密貨幣 AI 研究報告</h2><div class="right"><span class="chip-muted">共 ${runs.length} 份</span></div></div>
    ${runs.length ? `<table class="tbl"><thead><tr><th>幣種</th><th>分析時間（台北）</th><th>觸發</th><th>最終決策</th><th>進場 / 停損 / 停利</th><th>模型（快速 / 深度）</th><th title="第 1 至 5 組，含失敗重試">呼叫次數（依組別）</th><th>耗時</th><th></th></tr></thead><tbody>
    ${runs.map((r) => { const d = DIRS[r.decision]; const m = r.models || {};
      return `<tr class="run-row" data-sync-key="${esc(r.id)}"><td><div class="coin">${coinIcon(baseOf(r.symbol), 24)}<div><b>${esc(baseOf(r.symbol))}</b><small>${esc(r.name)}</small></div></div></td><td class="num">${fmtTime(r.created_at)}</td><td>${esc(TRIG[r.trigger] || r.trigger)}</td>
        <td>${r.status === "done" ? `<span class="pill ${d.pill}">${d.t}</span> <span class="muted num">信心 ${r.confidence}</span>${r.resumed ? ` <span class="pill mid" title="補完成於 ${esc(fmtTime(r.resumed.at))}">補完成</span>` : ""}` : r.status === "failed" ? `<span class="pill gray" title="${esc(friendlyErr(r.error))}">失敗</span>` : r.status === "sync_stale" ? `<span class="pill gray">同步中斷</span>` : r.status === "paused" ? `<span class="pill gray">已暫停</span>` : r.status === "pausing" ? `<span class="pill gray">正在暫停</span>` : `<span class="pill run">分析中</span>`}</td>
        <td class="num">${r.status === "done" ? `${fmtLv(r.entry)} / <span class="down">${fmtLv(r.stop)}</span> / <span class="up">${fmtLv(r.take_profit)}</span>` : "—"}</td>
        <td class="muted num" style="font-size:12px">${m.quick ? `${esc(m.quick.used)}（槽位 ${m.quick.key_slot ?? "—"}）<br>${esc(m.deep.used)}（槽位 ${m.deep.key_slot ?? "—"}）${m.quick.fallback_reason ? '<br><span class="warn">快速已切換備援</span>' : ""}${m.deep.fallback_reason ? '<br><span class="warn">深度已切換備援</span>' : ""}` : "—"}</td>
        <td class="num" style="white-space:nowrap" title="${esc(callsTitle(r.calls))}">${fmtCalls(r.calls)}${r.calls?.reconstructed ? '<span class="warn" title="原始執行的呼叫次數由紀錄還原">＊</span>' : ""}</td><td class="num">${r.duration_s ? Math.round(r.duration_s) + " 秒" : "—"}</td>
        <td class="c">${r.status === "done" ? `<a class="ok" href="#/report/${encodeURIComponent(r.id)}">查看</a>` : ""}${r.pdf_url ? `・<a class="ok" target="_blank" href="${esc(r.pdf_url)}">PDF</a>` : ""}</td></tr>`; }).join("")}
    </tbody></table>` : `<div class="empty-state" style="height:180px">${ICON.report}<b>尚未執行 AI 分析</b><small>每次 AI 團隊分析完成都會產生一份繁體中文報告（含 PDF），列在這裡。</small></div>`}</section>`;
  const view = location.hash, data = await load();
  if (view !== location.hash) return;
  $("#app").innerHTML = layout(...data);
  onData(["status.json", "runs.json", "ai-usage.json"], async (active) => {
    const data = await load();
    if (active()) patchHTML($("#app"), layout(...data));
  });
}
const REPORT_ORDER = [["pm", "投資組合經理｜最終決策"], ["trader", "交易員｜交易計畫"], ["manager", "研究經理｜研究結論"], ["market", "技術分析師"], ["sentiment", "情緒分析師"], ["news", "加密新聞分析師"], ["onchain", "鏈上 / 衍生品分析師"], ["bull", "多頭研究員"], ["bear", "空頭研究員"], ["aggressive", "積極派風控"], ["conservative", "保守派風控"], ["neutral", "中立派風控"]];
async function pageReport(id) {
  const view = location.hash;
  const r = await api(`/api/crypto/ai/runs/${encodeURIComponent(id)}`);
  if (view !== location.hash) return;
  const res = r.result || {}, dec = res.decision || {}, m = r.models || {}, c = r.calls || {};
  setTitle(`${baseOf(r.symbol)} 研究報告`, fmtTime(r.created_at) + "（台北）");
  const srcs = Object.entries(r.sources || {});
  $("#app").innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start">
    <div>
      <section class="card"><div class="card-h"><h2>${coinIcon(baseOf(r.symbol), 26)}${esc(r.name)}（${esc(r.symbol)}）AI 短線分析</h2><div class="right">${r.pdf_url ? `<a class="btn sm mint" target="_blank" href="${esc(r.pdf_url)}">下載 PDF</a>` : ""}${r.html_url ? `<a class="btn sm" target="_blank" href="${esc(r.html_url)}">網頁版報告</a>` : ""}<a class="btn sm" href="#/coin/${r.symbol}">幣種研究</a></div></div>
        ${verdictHTML(r, `<div class="v-side"><small>當時價格</small><b class="num">${fmtPrice(r.price_at_run, 2)}</b><small>研究評等 ${esc(res.research_rating || "—")}</small></div>`)}
        <p class="ai-sum">${esc(dec.executive_summary || "")}</p>${originalActionHTML(dec,res.execution)}
        <div class="factors"><div class="bull"><h4 class="up">看多因素</h4><ul>${(dec.bull_factors || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div><div class="bear"><h4 class="down">看空因素</h4><ul>${(dec.bear_factors || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
        ${(res.warnings || []).length ? `<div class="callout"><b>注意</b><span>${res.warnings.map(esc).join("；")}</span></div>` : ""}</section>
      ${previousReviewHTML(res.previous_review)}
      ${res.new_strategy?`<section class="card" style="margin-top:16px"><div class="card-h"><h2>策略測試經理</h2></div><p class="note">${esc(res.new_strategy.state)}</p><a class="ok" href="#/paper/new">查看測試1號帳戶與決策 ›</a></section>`:""}
      <section class="card" style="margin-top:16px"><div class="rep-nav" id="rep-nav">${REPORT_ORDER.filter(([k]) => r.reports_html?.[k]).map(([k, t], i) => `<button class="tab outline ${i ? "" : "active"}" data-k="${k}">${esc(t.split("｜")[0])}</button>`).join("")}</div>
        <div class="md" id="rep-body"></div></section>
      ${r.data_inputs && Object.keys(r.data_inputs).length ? `<section class="card" style="margin-top:16px"><div class="card-h"><h2>${ICON.chain}資料輸入快照（分析當下餵給 AI 的數據）</h2></div>
        ${[["market", "技術面（K 線 / 指標）"], ["sentiment", "情緒（恐懼貪婪、資金費率）"], ["news", "加密新聞"], ["onchain", "鏈上 / 衍生品（未平倉、多空比、清算）"]].filter(([k]) => r.data_inputs[k]).map(([k, t]) => `<details class="din"><summary>${esc(t)}</summary><pre>${esc(r.data_inputs[k])}</pre></details>`).join("")}</section>` : ""}
    </div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <section class="card"><div class="card-h"><h2>${ICON.spark}執行資訊</h2></div><div class="cfg" style="grid-template-columns:96px 1fr">
        <div>觸發</div><div>${esc(TRIG[r.trigger] || r.trigger)}</div><div>開始</div><div class="num">${fmtTime(r.started_at)}</div><div>耗時</div><div class="num">${Math.round(r.duration_s)} 秒</div>
        ${["quick", "deep"].map((t) => m[t] ? `<div>${t === "quick" ? "快速思考" : "深度思考"}</div><div class="num" style="font-size:12.5px"><b>${esc(m[t].used)}</b>${m[t].used !== m[t].configured ? `<span class="warn">（設定 ${esc(m[t].configured)}）</span>` : ""}<br><span class="muted">${esc(m[t].key)}・思考 ${esc(m[t].thinking || "預設")}</span>${m[t].by_slot ? Object.entries(m[t].by_slot).map(([k, v]) => `<br><span class="dim">${esc(k)}：${v.roles.map((x) => esc(ROLE_NAME[x] || x)).join("、")}${c.detail?.[`${t}@${k.match(/\d+$/)?.[0]}`] ? `（${c.detail[`${t}@${k.match(/\d+$/)[0]}`].calls} 次）` : ""}</span>`).join("") : ""}<br><span class="muted">呼叫 ${c[t]?.calls ?? "—"} 次（成功 ${c[t]?.ok ?? "—"}）・tokens ${((c[t]?.input_tokens || 0) / 1000).toFixed(1)}k / ${((c[t]?.output_tokens || 0) / 1000).toFixed(1)}k</span>${Object.keys(m[t].api_reported || {}).length ? `<br><span class="dim">API 回報：${esc(Object.entries(m[t].api_reported).map(([k, v]) => k + "×" + v).join("、"))}</span>` : ""}${m[t].fallback_reason ? `<br><span class="warn">${esc(m[t].fallback_reason)}</span>` : ""}</div>` : "").join("")}
        ${c.by_slot ? `<div>呼叫次數</div><div class="num" style="font-size:12.5px"><b>${fmtCalls(c)}</b>${(c.parts || []).map((p) => `<br><span class="dim">${esc(p.label)}：${p.calls} 次（${esc(Object.entries(p.by_slot || {}).filter(([, n]) => n).map(([k, n]) => slotShort(k) + " " + n).join("・") || "0")}）</span>`).join("")}${c.note ? `<br><span class="warn">${esc(c.note)}</span>` : ""}</div>` : ""}
      </div></section>
      <section class="card"><div class="card-h"><h2>${ICON.chain}資料來源（本次）</h2><div class="right"><span class="chip-muted">${srcs.filter(([, v]) => v.ok).length} / ${srcs.length} 成功</span></div></div>
        <table class="tbl">${srcs.map(([k, v]) => `<tr><td style="font-size:12.5px">${esc(k)}<br><span class="dim">${esc(v.vendor || "")}</span></td><td class="c ${v.ok ? "src-ok" : "src-bad"}" title="${esc(v.error || "")}">${v.ok ? "成功" : "失敗"}</td></tr>`).join("")}</table></section>
      ${(res.headlines || []).length ? `<section class="card"><div class="card-h"><h2>${ICON.news}引用新聞</h2></div><div class="feed" style="max-height:300px">${res.headlines.map((n) => `<a class="sig" target="_blank" rel="noopener" href="${esc(n.link)}"><div class="sig-b"><div class="sig-t"><b style="white-space:normal;font-size:12.5px">${esc(n.title)}</b></div><div class="sig-d">${esc(n.source)}・${fmtTime(n.time)}</div></div></a>`).join("")}</div></section>` : ""}
    </div></div>`;
  const show = (k) => { $("#rep-body").innerHTML = `<h2 style="margin-top:0">${esc(REPORT_ORDER.find((x) => x[0] === k)[1])}</h2>` + (r.reports_html[k] || ""); $$("#rep-nav .tab").forEach((b) => b.classList.toggle("active", b.dataset.k === k)); };
  $$("#rep-nav .tab").forEach((b) => b.onclick = () => show(b.dataset.k));
  const first = REPORT_ORDER.find(([k]) => r.reports_html?.[k]); if (first) show(first[0]);
  if (r.status === "failed") $("#rep-body").innerHTML = `<div class="callout"><b>這次分析失敗</b><span>${esc(r.error || "")}</span></div>`;
}

/* 設定（公開版：唯讀） */
async function pageSettings(active) {
  setTitle("設定", "唯讀");
  const [cs, AS, st] = await Promise.all([api("/api/crypto/settings"), api("/api/crypto/ai/settings"), J("status.json")]);
  if (active && !active()) return;
  const S = cs.settings, ms = cs.status, A = AS.settings, KS = AS.key_status || {};
  const PROV = { google: "Google Gemini", xai: "xAI Grok", openai: "OpenAI", anthropic: "Anthropic" };
  const hh = (h) => (h == null ? "—" : String(h).padStart(2, "0") + ":00");
  const quietList = () => { if (A.quiet_start == null || A.quiet_end == null) return "無"; const out = []; for (let h = A.quiet_start, n = 0; n < 24; h = (h + 1) % 24, n++) { out.push(String(h).padStart(2, "0")); if (h === A.quiet_end) break; } return `${hh(A.quiet_start)}–${hh(A.quiet_end)}（略過 ${out.join("、")} 點）`; };
  const sc = st.scheduler || {};
  const TIER_ROLES = { quick: ["market", "sentiment", "news", "onchain", "bull", "bear", "trader", "aggressive", "conservative", "neutral"], deep: ["manager", "pm"] };
  const slotSplit = (t) => { const g = {}; TIER_ROLES[t].forEach((r) => { const sl = A.role_key_slots[r] || A[t].key_slot; (g[sl] = g[sl] || []).push(ROLE_NAME[r] || r); });
    return Object.entries(g).sort().map(([sl, rs]) => `槽位 ${sl}：<span class="dim">${rs.map(esc).join("、")}</span>`).join("<br>") +
      `<br>槽位 3（備用）：<span class="dim">排程 run 在原槽位額度用完或長退避仍失敗時接手；手動 / 補完成優先使用</span>`; };
  const tierCard = (t) => { const c = A[t]; return `<div class="card" style="background:#20252d"><div class="card-h"><h2 style="font-size:15px">${t === "quick" ? "快速思考層" : "深度思考層"}<span class="dim" style="font-size:12px;font-weight:400;margin-left:6px">${t === "quick" ? "4 位分析師、多空研究員、交易員、3 位風控（10 位）" : "研究經理、投資組合經理（2 位）"}</span></h2></div>
    <div class="cfg" style="grid-template-columns:120px 1fr">
      <div>供應商</div><div>${esc(PROV[c.provider] || c.provider)}</div>
      <div>模型</div><div class="num"><b>${esc(c.model)}</b></div>
      <div>思考強度</div><div>${esc(c.thinking || "模型預設")}</div>
      ${c.provider === "google" ? `<div>金鑰槽位</div><div>${A.role_key_slots ? slotSplit(t) : "槽位 " + c.key_slot}</div>` : ""}
      <div>金鑰</div><div>${KS[t] ? '<span class="ok">已設定</span>' : '<span class="bad">未設定</span>'}</div>
      <div>額度用完備援</div><div class="num">${esc(c.fallback_model || "不使用")}<br><span class="dim">同一把金鑰</span></div>
    </div></div>`; };
  const layout = `${noteHTML()}
  <div class="set-grid">
    <section class="card"><div class="card-h"><h2>${ICON.hourglass}自動排程</h2><div class="right"><span class="pill ${A.schedule_enabled ? "done" : "gray"}">${A.schedule_enabled ? "● 已啟用" : "● 已關閉"}</span></div></div>
      <div class="cfg" style="grid-template-columns:150px 1fr">
        <div>每幾小時自動跑一次</div><div class="num"><b>${A.schedule_interval_hours}</b> 小時（台北時間整點 :00）</div>
        <div>自動跑哪個幣種</div><div><b>${esc(baseOf(A.schedule_symbol))}</b>・${esc(A.schedule_symbol)}</div>
        <div>不執行時段</div><div>${esc(quietList())}</div>
        <div>下次執行</div><div class="num"><b>${AS.next_run ? fmtTime(AS.next_run) + "（台北）" : "—（排程關閉）"}</b></div>
        <div>排程器狀態</div><div>${sc.alive ? '<span class="ok">運作中</span>' : sc.alive === false ? '<span class="bad">未運作</span>' : '<span class="dim">—</span>'}${sc.last_fire ? `<span class="dim">・上次觸發 ${fmtTime(sc.last_fire)}</span>` : ""}</div>
        <div>網站資料更新</div><div class="num"><span id="pub-time">${fmtTime(st.published_at)}</span>（台北）<br><span class="dim">每次分析開始 / 完成、設定變更時由後台推送</span></div>
        <div>主機最後回報</div><div class="num" id="host-hb">${hostBeat(st)}</div>
      </div>
      <p class="note">整點觸發條件：小時數能被間隔整除（例如每 3 小時 = 0、3、6、9…點），並略過不執行時段。一次只跑一個分析。</p></section>
    <section class="card"><div class="card-h"><h2>${ICON.scale}分析參數</h2></div>
      <div class="cfg" style="grid-template-columns:150px 1fr">
        <div>多空辯論輪數</div><div class="num">${A.max_debate_rounds}</div>
        <div>風控討論輪數</div><div class="num">${A.max_risk_discuss_rounds}</div>
        <div>持有期間</div><div class="num">${holdTxt(A.holding_period_days)}</div>
        <div>輸出</div><div>做多 / 做空 / 觀望，含進場、停損、停利與建議部位</div>
      </div>
      <p class="note">${(() => { const D = +A.max_debate_rounds || 1, R = +A.max_risk_discuss_rounds || 1, q = 4 + 2 * D + 1 + 3 * R, s1 = 4 + 2 * D + 1, s2 = 1 + 3 * R + 1;
        return `每輪多空辯論 = 多頭、空頭各 1 次快速模型呼叫；每輪風控 = 積極、保守、中立各 1 次。目前 ${D} / ${R} 輪：每次分析快速層 ${q} 次（分析師 4、辯論 ${2 * D}、交易員 1、風控 ${3 * R}）、深度層 2 次（研究經理、投資組合經理），合計 ${q + 2} 次；依金鑰：槽1 約 ${s1} 次（分析師、多空研究員、研究經理）・槽2 約 ${s2} 次（交易員、風控、投資組合經理）・槽3 平常 0 次（備用）。不含 503 重試與備援。`; })()}</p></section>
  </div>
  <section class="card" style="margin-top:16px"><div class="card-h"><h2>${ICON.spark}AI 模型設定</h2><div class="right"><span class="note">金鑰只存在後台，網站不會顯示或傳送金鑰</span></div></div>
    <div class="tier-grid">${tierCard("quick")}${tierCard("deep")}</div></section>
  <section class="card" style="margin-top:16px"><div class="card-h"><h2>${ICON.team}AI 團隊角色（共 ${ROLES.length} 位）</h2></div>
    <table class="tbl"><thead><tr><th>團隊</th><th>角色</th><th>職責 / 資料</th><th>模型層級</th><th>模型</th></tr></thead><tbody>
    ${ROLES.map((r) => { const t = A[r.tier]; return `<tr><td class="c muted">${esc(r.team)}</td><td class="c"><b>${esc(r.name)}</b></td><td>${esc(r.desc)}</td><td class="c ${r.tier === "deep" ? "tier-deep" : "tier-quick"}">${r.tier === "deep" ? "深度思考" : "快速思考"}</td><td class="c num">${esc(t.model)}</td></tr>`; }).join("")}
    </tbody></table></section>
  <div class="set-grid" style="margin-top:16px">
    <section class="card"><div class="card-h"><h2>${ICON.radio}即時行情（你的瀏覽器直連）</h2><div class="right"><span class="pill high" id="ws-pill">● 連線中</span></div></div>
      <div class="cfg">
        <div>即時報價</div><div class="num">Binance USDⓈ-M 公開 WebSocket<br><small class="dim">${esc((ms.quote && ms.quote.url) || "wss://fstream.binance.com/market/stream")}（aggTrade + ticker + markPrice）</small></div>
        <div>報價狀態</div><div class="num" id="q-last"></div>
        <div>K 線 REST / WS</div><div class="num">${esc(ms.rest_base)}<br>${esc(ms.ws_base)}（Binance USDC 永續 kline 5m / 15m / 1h / 4h / 1d）</div>
        <div>K 線最後資料</div><div class="num" id="ws-last">${fmtTime(ms.last_msg_at)}・累計 ${ms.messages.toLocaleString()} 則・重連 ${ms.reconnects} 次</div>
        <div>後台價格</div><div>模擬交易成交 / 停損停利 / 未實現損益、AI 分析：Binance USDⓈ-M 永續合約（BTCUSDC / ETHUSDC / ZECUSDC）</div>
        <div>追蹤清單</div><div>${S.watchlist.map((x) => esc(baseOf(x))).join("、")}</div>
        <div>訊號週期</div><div>${S.signal_timeframes.map((t) => TF_LABEL[t]).join("、")}</div>
      </div>
      <p class="note">全部資料皆來自 Binance USDⓈ-M 永續合約（USDC 本位），不使用現貨。報價只走 WebSocket（顯示價 = 最新成交 aggTrade；24h 漲跌 = (last − open) / open，滾動 24 小時）。若連不上 Binance 會顯示「無法連線」，不會自動改用其他交易所。v1.0.7 以前的研究報告與模擬交易紀錄是 OKX USDT 永續（代號 BTCUSDT 等），保留原樣。</p></section>
    <section class="card"><div class="card-h"><h2>${ICON.bolt}訊號門檻（即時層，不使用 AI）</h2></div>
      <table class="tbl"><tbody>
        <tr><td>RSI</td><td class="num">${S.rsi.enabled ? `週期 ${S.rsi.period}・超買 ${S.rsi.overbought}・超賣 ${S.rsi.oversold}` : "關閉"}</td></tr>
        <tr><td>MACD</td><td class="num">${S.macd.enabled ? `${S.macd.fast} / ${S.macd.slow} / ${S.macd.signal}` : "關閉"}</td></tr>
        <tr><td>布林通道</td><td class="num">${S.bb.enabled ? `週期 ${S.bb.period}・${S.bb.std} 倍標準差` : "關閉"}</td></tr>
        <tr><td>成交量異常</td><td class="num">${S.volume.enabled ? `≥ ${S.volume.multiplier} 倍 × 前 ${S.volume.window} 根平均` : "關閉"}</td></tr>
      </tbody></table>
      <p class="note">訊號只在 K 線收盤時判斷。</p></section>
  </div>
  <section class="card" style="margin-top:16px"><div class="card-h"><h2>${ICON.chain}資料來源</h2></div>
    <table class="tbl"><thead><tr><th>類別</th><th>來源（皆免金鑰）</th><th>更新方式</th></tr></thead><tbody>
      <tr><td>即時價格 / 24h 漲跌</td><td>Binance USDC 永續 WebSocket（aggTrade 成交價、ticker 滾動 24h%）</td><td class="ok c">瀏覽器即時</td></tr>
      <tr><td>市場板塊（成交額前 10）</td><td>Binance USDC 永續 24h tickers（載入時 REST 一次 + WebSocket 更新）</td><td class="ok c">瀏覽器即時</td></tr>
      <tr><td>K 線 / 指標 / 技術訊號</td><td>Binance USDC 永續 K 線（REST /fapi/v1/klines + WebSocket kline）</td><td class="ok c">瀏覽器即時</td></tr>
      <tr><td>模擬交易價格、AI 分析價格</td><td>Binance USDC 永續合約（WebSocket aggTrade；備援 1 分 K 高低點）</td><td class="c">後台</td></tr>
      <tr><td>恐懼貪婪指數</td><td>alternative.me</td><td class="ok c">瀏覽器每 10 分鐘</td></tr>
      <tr><td>資金費率 / 未平倉量 / 多空比 / 清算參考</td><td>資金費／持倉／多空比：Binance；清算參考：OKX 公開歷史事件</td><td class="c">後台推送快照</td></tr>
      <tr><td>加密新聞</td><td>CoinDesk / Cointelegraph / Decrypt / The Block RSS</td><td class="c">後台推送快照</td></tr>
      <tr><td>鏈上數據</td><td>BTC：BTC 鏈上擁堵度（mempool.space）、blockchain.info；ETH / ZEC：Blockchair</td><td class="c">分析時</td></tr>
      <tr><td>AI 決策與報告</td><td>TradingAgents（12 位 AI 代理）</td><td class="c">每次分析完成</td></tr>
    </tbody></table></section>`;
  patchHTML($("#app"), layout);
  if (active) return;
  onData(["settings.json", "status.json"], pageSettings);
  const upd = () => { const m = MK.status, p = $("#ws-pill"), l = $("#ws-last"); if (!p) return;
    const q = m.quote || {}, r = quoteStatusText(q);
    p.className = "pill " + (q.connected ? "done" : "high"); p.textContent = q.connected ? "● Binance 報價已連線" : q.state === "failed" ? "● Binance 報價無法連線" : "● Binance 報價未連線";
    $("#q-last").textContent = `${r.text}・累計 ${(q.messages || 0).toLocaleString()} 則・重連 ${q.reconnects || 0} 次${q.last_close && !q.connected ? "・最後關閉 " + q.last_close : ""}`;
    const k = m.kline || {}; l.textContent = `${k.connected ? "● 已連線" : k.state === "failed" ? "● 無法連線" : "● 未連線"}・${fmtTime(k.last_msg_at)}・累計 ${(k.messages || 0).toLocaleString()} 則・重連 ${k.reconnects || 0} 次`; };
  const iv = setInterval(upd, 2000); pageCleanup.push(() => clearInterval(iv));
}

/* router / top bar */
function setTitle(t, chip) { document.title = "easonAgents"; $("#app").setAttribute("aria-label", t); }
async function route() {
  pageCleanup.forEach((f) => { try { f(); } catch (e) {} }); pageCleanup = []; if(!$("#sheet")?.classList.contains("debate-wrap") || $("#sheet").dataset.route!==location.hash) closeSheet();
  const h = location.hash || "#/";
  const [path, qs] = h.slice(1).split("?");
  const params = new URLSearchParams(qs || "");
  const app = $("#app");
  app.innerHTML = `<div class="loading">載入中…</div>`;
  window.scrollTo(0, 0);
  try {
    let m;
    if (/^\/(coin\/|paper(?:\/|$)|team$)/.test(path) || path === "/" || path === "") MK.start();
    if (/^\/(coin\/|paper(?:\/|$))/.test(path)) await loadChartLibrary();
    if (h !== (location.hash || "#/")) return;
    if (path === "/" || path === "") { renderNav("home"); await pageOverview(); }
    else if ((m = path.match(/^\/coin\/([A-Za-z0-9]+)/))) { renderNav("coin"); await pageCoin(m[1], params); }
    else if (path === "/team") { renderNav("team"); await pageTeam(params); }
    else if (path === "/paper") { renderNav("paper"); await pagePaper(); }
    else if (path === "/paper/new") { renderNav("paper"); await pageNewPaper(); }
    else if (path === "/paper/test2") { renderNav("paper"); await pageNewPaper("test2"); }
    else if (path === "/reports") { renderNav("reports"); await pageReports(); }
    else if ((m = path.match(/^\/report\/(.+)$/))) { renderNav("reports"); await pageReport(decodeURIComponent(m[1])); }
    else if (path === "/settings") { renderNav("settings"); await pageSettings(); }
    else { location.hash = "#/"; }
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card"><div class="empty-state"><b>載入失敗</b><small>${esc(e.message)}</small></div></div>`;
  }
}
document.addEventListener("click", e => { const dd = $(".nav-dropdown"); if (dd && !dd.contains(e.target)) dd.open = false; });
window.addEventListener("hashchange", route);
setInterval(tickElapsed, 1000);
connectLive();
let chartLibrary;
function loadChartLibrary() {
  if (typeof LightweightCharts !== "undefined") return Promise.resolve();
  if (!chartLibrary) chartLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/lightweight-charts.standalone.production.js";
    script.onload = resolve;
    script.onerror = () => { chartLibrary = null; script.remove(); reject(new Error("圖表元件載入失敗")); };
    document.head.append(script);
  });
  return chartLibrary;
}
if ($("#frontend-update")) $("#frontend-update").onclick = () => location.reload();
(async () => {
  const cfg = J("settings.json").then(s => { MK.configure(s.signal_settings); WATCH = MK.cfg.watchlist; }).catch(() => {});
  const status = pollData();
  await cfg;
  void route();
  const loopPoll = () => setTimeout(async () => { await pollData(); loopPoll(); }, DATA.cache["status.json"]?.v?.busy ? 25000 : 60000);
  void status.finally(loopPoll);
  if (usesRelay) void pollRelay();
})();
