/* 公開版（GitHub Pages）資料層：
 * - 即時行情與 K 線：瀏覽器直接連 Binance USDⓈ-M 永續合約（USDC 本位，例如 BTCUSDC）公開 API / WebSocket，不使用現貨
 * - 指標與訊號：在瀏覽器計算（與後端 backend/crypto.py 同一套公式）
 * - AI 結果：讀取後台推送的 data/*.json（每次分析完成後更新）
 * Binance 連不上時顯示錯誤，不會自動改用其他交易所。
 */
"use strict";
const MK_REST_LIST = ["https://fapi.binance.com", "https://www.binance.com"];
// 2026-04-23 起 Binance 合約 WebSocket 一般行情走 /market（aggTrade、kline、ticker、markPrice）
const BN_WS_MARKET = ["wss://fstream.binance.com/market/stream"];
let MK_REST = MK_REST_LIST[0], MK_WS = BN_WS_MARKET[0];
const BN_QUOTE = "USDC";
const BN_INT = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const BN_INT_REV = Object.fromEntries(Object.entries(BN_INT).map(([k, v]) => [v, k]));
const MK_TFS = ["5m", "15m", "1h", "4h", "1d"];
const MK_TF_MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const MK_TF_LABEL = { "5m": "5分", "15m": "15分", "1h": "1小時", "4h": "4小時", "1d": "日線" };
const MK_NAMES = { BTC: "比特幣", ETH: "以太坊", ZEC: "Zcash", SOL: "Solana" };
const MK_DEFAULT_CFG = {
  watchlist: ["BTCUSDC", "ETHUSDC", "ZECUSDC"], signal_timeframes: ["5m", "1h", "4h"],
  rsi: { enabled: true, period: 14, overbought: 70, oversold: 30 }, macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
  bb: { enabled: true, period: 20, std: 2.0 }, volume: { enabled: true, window: 20, multiplier: 3.0 },
};
const mkBase = (s) => { for (const q of ["USDT", "USDC", "FDUSD", "BUSD"]) if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length); return s; };
/** 任何代號（v1.0.7 以前 OKX 時期的 BTCUSDT、BTC）→ 目前使用的 Binance USDC 永續代號 BTCUSDC。 */
const bnCanon = (s) => (s ? mkBase(String(s).toUpperCase()) + BN_QUOTE : s);
const mkName = (s) => MK_NAMES[mkBase(s)] || mkBase(s);
const ok = (...xs) => xs.every((x) => x != null && !Number.isNaN(x));
const gfmt = (x, p) => { if (x == null || isNaN(x)) return "nan"; const s = Number(x).toPrecision(p); return String(Number(s)); };
const isoTPE = (ms) => { const d = new Date(ms + 8 * 3600000); return d.toISOString().slice(0, 19) + "+08:00"; };

/* ---------------- 指標（對應 backend/crypto.py compute_indicators） */
function rolling(arr, n, fn) { const out = new Array(arr.length).fill(NaN); for (let i = n - 1; i < arr.length; i++) out[i] = fn(arr, i - n + 1, i + 1); return out; }
const mean = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i]; return t / (e - s); };
const stdp = (a, s, e) => { const m = mean(a, s, e); let t = 0; for (let i = s; i < e; i++) t += (a[i] - m) ** 2; return Math.sqrt(t / (e - s)); };
function wilder(x, n) { const out = new Array(x.length).fill(NaN); if (x.length < n) return out; out[n - 1] = mean(x, 0, n); for (let i = n; i < x.length; i++) out[i] = (out[i - 1] * (n - 1) + x[i]) / n; return out; }
function ewm(x, span) { const a = 2 / (span + 1), out = new Array(x.length); let y = NaN; for (let i = 0; i < x.length; i++) { y = i === 0 ? x[0] : (1 - a) * y + a * x[i]; out[i] = y; } return out; }
function computeIndicators(bars, cfg) {
  const c = bars.map((b) => b.c), h = bars.map((b) => b.h), l = bars.map((b) => b.l), v = bars.map((b) => b.v), N = bars.length;
  const ma20 = rolling(c, 20, mean), ma60 = rolling(c, 60, mean);
  const p = +cfg.bb.period, k = +cfg.bb.std;
  const mid = rolling(c, p, mean), sd = rolling(c, p, stdp);
  const n = +cfg.rsi.period;
  const up = [], dn = [];
  for (let i = 1; i < N; i++) { const d = c[i] - c[i - 1]; up.push(d > 0 ? d : 0); dn.push(d < 0 ? -d : 0); }
  const wu = wilder(up, n), wd = wilder(dn, n);
  const rsi = [NaN].concat(wu.map((u, i) => (Number.isNaN(u) ? NaN : wd[i] === 0 ? 100 : 100 - 100 / (1 + u / wd[i]))));
  const ef = ewm(c, +cfg.macd.fast), es = ewm(c, +cfg.macd.slow);
  const macd = ef.map((x, i) => x - es[i]); const sig = ewm(macd, +cfg.macd.signal);
  const w = +cfg.volume.window;
  const volMa = new Array(N).fill(NaN); for (let i = w; i < N; i++) volMa[i] = mean(v, i - w, i);
  const tr = bars.map((b, i) => (i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  const atr = [NaN].concat(wilder(tr.slice(1), 14));
  return bars.map((b, i) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, closed: b.closed, ma20: ma20[i], ma60: ma60[i], bb_mid: mid[i], bb_up: mid[i] + k * sd[i], bb_lo: mid[i] - k * sd[i],
    rsi: rsi[i], macd: macd[i], macd_signal: sig[i], macd_hist: macd[i] - sig[i], vol_ma: volMa[i], atr: atr[i] }));
}
const warmup = (cfg) => Math.max(+cfg.macd.slow + +cfg.macd.signal, +cfg.bb.period, +cfg.rsi.period + 1, +cfg.volume.window + 1) + 1;
function detectSignals(ind, i, cfg, symbol, tf) {
  if (i < Math.max(1, warmup(cfg)) || i >= ind.length) return [];
  const cur = ind[i], prev = ind[i - 1], px = cur.c, t = cur.t, tl = MK_TF_LABEL[tf] || tf, out = [];
  const add = (rule, direction, title, detail, value) => out.push({ symbol, tf, rule, direction, title, detail, price: px, value: value == null ? null : Math.round(value * 1e4) / 1e4, bar_time: t });
  const r = cfg.rsi;
  if (r.enabled && ok(cur.rsi, prev.rsi)) {
    const ob = +r.overbought, os = +r.oversold, a = prev.rsi, b = cur.rsi;
    if (a < ob && ob <= b) add("rsi_overbought", "bear", `RSI 進入超買（>${gfmt(ob, 6)}）`, `${tl} RSI(${r.period}) 由 ${a.toFixed(1)} 升至 ${b.toFixed(1)}，留意回檔風險`, b);
    else if (a >= ob && ob > b) add("rsi_exit_overbought", "bear", "RSI 跌出超買區", `${tl} RSI 由 ${a.toFixed(1)} 回落至 ${b.toFixed(1)}，上漲動能轉弱`, b);
    if (a > os && os >= b) add("rsi_oversold", "bull", `RSI 進入超賣（<${gfmt(os, 6)}）`, `${tl} RSI(${r.period}) 由 ${a.toFixed(1)} 降至 ${b.toFixed(1)}，留意反彈機會`, b);
    else if (a <= os && os < b) add("rsi_exit_oversold", "bull", "RSI 回升離開超賣區", `${tl} RSI 由 ${a.toFixed(1)} 回升至 ${b.toFixed(1)}，下跌動能減弱`, b);
  }
  if (cfg.macd.enabled && ok(cur.macd_hist, prev.macd_hist)) {
    const a = prev.macd_hist, b = cur.macd_hist;
    if (a <= 0 && 0 < b) add("macd_golden", "bull", "MACD 黃金交叉", `${tl} MACD 線上穿訊號線（MACD ${gfmt(cur.macd, 4)}）`, cur.macd);
    else if (a >= 0 && 0 > b) add("macd_death", "bear", "MACD 死亡交叉", `${tl} MACD 線下穿訊號線（MACD ${gfmt(cur.macd, 4)}）`, cur.macd);
  }
  if (cfg.bb.enabled && ok(cur.bb_up, prev.bb_up, cur.bb_lo, prev.bb_lo)) {
    if (prev.c <= prev.bb_up && cur.c > cur.bb_up) add("bb_break_up", "bull", "收盤突破布林上軌", `${tl} 收盤 ${gfmt(px, 6)} 高於上軌 ${gfmt(cur.bb_up, 6)}`, cur.bb_up);
    else if (prev.c >= prev.bb_lo && cur.c < cur.bb_lo) add("bb_break_down", "bear", "收盤跌破布林下軌", `${tl} 收盤 ${gfmt(px, 6)} 低於下軌 ${gfmt(cur.bb_lo, 6)}`, cur.bb_lo);
  }
  const vc = cfg.volume;
  if (vc.enabled && ok(cur.vol_ma) && cur.vol_ma > 0) {
    const ratio = cur.v / cur.vol_ma;
    if (ratio >= +vc.multiplier) { const upc = cur.c >= cur.o;
      add("volume_spike", upc ? "bull" : "bear", `成交量異常放大 ${ratio.toFixed(1)} 倍`, `${tl} 成交量為過去 ${vc.window} 根平均的 ${ratio.toFixed(1)} 倍，K 線${upc ? "收紅（上漲）" : "收黑（下跌）"}`, ratio); }
  }
  return out;
}
function techScore(row) {
  const checks = [["收盤 > MA20", row.c, row.ma20], ["MA20 > MA60", row.ma20, row.ma60], ["MACD 柱 > 0", row.macd_hist, 0], ["RSI > 50", row.rsi, 50], ["收盤 > 布林中軌", row.c, row.bb_mid]];
  const items = checks.filter(([, a, b]) => ok(a, b)).map(([n, a, b]) => ({ name: n, bull: a > b }));
  if (!items.length) return null;
  const pct = Math.round((items.filter((x) => x.bull).length / items.length) * 100);
  const [label, arrow] = pct >= 80 ? ["多方偏強", "up"] : pct >= 60 ? ["偏多", "up"] : pct > 40 ? ["多空膠著", "flat"] : pct > 20 ? ["偏空", "down"] : ["空方偏強", "down"];
  return { bull_pct: pct, label, arrow, checks: items };
}
/* ---------------- 多週期技術多空 + 多空分歧（指標計算，非 AI）
   15分 = 進場時機、1H = 主要判斷、4H = 大方向。每個週期用 techScore 的 5 項檢查得到 bull_pct。 */
const MK_BIAS_TFS = ["15m", "1h", "4h"];
const MK_BIAS_W = { "15m": 0.25, "1h": 0.45, "4h": 0.3 };
const MK_BIAS_WINDOW_MS = 6 * 3600000;
function mkDir(pct) { return pct == null ? null : pct >= 60 ? "bull" : pct <= 40 ? "bear" : "flat"; }
/** dims: { "15m": {bull_pct}, "1h": {...}, "4h": {...} }；signals: 即時訊號陣列（含 tf / direction / bar_time）；now：毫秒。
 *  回傳 { combined, divergence }：
 *  - combined（綜合）：加權 bull_pct（15分 25%、1H 45%、4H 30%）→ 偏多 / 偏空 / 中性；並標示 15 分是否同向（進場時機）。
 *  - divergence（多空分歧欄）：
 *    1. 三個週期同向（皆 ≥60 或皆 ≤40）且近 6 小時沒有反向訊號 → 一致偏多 / 一致偏空（強訊號）。
 *    2. 週期方向衝突（同時有偏多與偏空的週期）→ 多空分歧。
 *    3. 近 6 小時 15分/1H/4H 同時出現多方與空方訊號 → 也算多空分歧；但若三週期同向且「順向訊號數 > 反向訊號數」，
 *       保留一致偏多 / 偏空，只加上「訊號分歧」提示（不翻轉）；反向訊號 ≥ 順向訊號時才翻成多空分歧。
 *    4. 其他 → 中性。 */
function mkBias(dims, signals, now) {
  const dirs = {}; let wsum = 0, wpct = 0;
  for (const tf of MK_BIAS_TFS) { const p = dims && dims[tf] ? dims[tf].bull_pct : null; dirs[tf] = mkDir(p); if (p != null) { wsum += MK_BIAS_W[tf]; wpct += MK_BIAS_W[tf] * p; } }
  const since = (now || Date.now()) - MK_BIAS_WINDOW_MS;
  const recent = (signals || []).filter((x) => MK_BIAS_TFS.includes(x.tf) && x.bar_time + (MK_TF_MS[x.tf] || 0) >= since);
  const bull = recent.filter((x) => x.direction === "bull").length, bear = recent.filter((x) => x.direction === "bear").length;
  const vals = MK_BIAS_TFS.map((t) => dirs[t]);
  const complete = vals.every((v) => v != null);
  const allBull = complete && vals.every((v) => v === "bull"), allBear = complete && vals.every((v) => v === "bear");
  const tfConflict = vals.includes("bull") && vals.includes("bear");
  const sigMixed = bull > 0 && bear > 0;
  let key, label, note = "";
  if (allBull || allBear) {
    const withN = allBull ? bull : bear, againstN = allBull ? bear : bull;
    if (againstN > 0 && againstN >= withN) { key = "div"; label = "多空分歧"; note = `三週期${allBull ? "偏多" : "偏空"}，但近 6 小時反向訊號較多`; }
    else { key = allBull ? "bull" : "bear"; label = allBull ? "一致偏多" : "一致偏空"; if (againstN > 0) note = "訊號分歧"; }
  } else if (tfConflict) { key = "div"; label = "多空分歧"; note = "週期方向衝突"; }
  else if (sigMixed) { key = "div"; label = "多空分歧"; note = "近 6 小時多空訊號並存"; }
  else { key = "flat"; label = "中性"; }
  const cp = wsum ? Math.round(wpct / wsum) : null, cd = mkDir(cp);
  const combined = cp == null ? null : {
    bull_pct: cp, dir: cd, label: allBull ? "一致偏多" : allBear ? "一致偏空" : cd === "bull" ? "偏多" : cd === "bear" ? "偏空" : "中性",
    timing: cd === "flat" || !dirs["15m"] ? "" : dirs["15m"] === cd ? "15分同向・時機佳" : "15分未同向・等待",
  };
  return { dirs, combined, divergence: { key, label, note, bull, bear, window_h: 6, strong: key === "bull" || key === "bear" } };
}
function riskLevel(atrPct) {
  if (atrPct == null || Number.isNaN(atrPct)) return null;
  const [lv, s] = atrPct < 1.2 ? ["偏低", 1] : atrPct < 2.5 ? ["中等", 2] : atrPct < 4 ? ["偏高", 3] : ["高", 4];
  return { level: lv, score: s, atr_pct: Math.round(atrPct * 100) / 100 };
}
const num = (x, nd = 8) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** nd) / 10 ** nd);
function publicBar(r) { const out = { t: r.t }; for (const k of ["o", "h", "l", "c", "v", "ma20", "ma60", "bb_up", "bb_mid", "bb_lo", "rsi", "macd", "macd_signal", "macd_hist", "vol_ma", "atr"]) out[k] = num(r[k]); out.closed = !!r.closed; return out; }
function publicSignal(s) { return { ...s, bar_time_iso: isoTPE(s.bar_time), close_time_iso: isoTPE(s.bar_time + (MK_TF_MS[s.tf] || 0)), tf_label: MK_TF_LABEL[s.tf] || s.tf, name: mkName(s.symbol) }; }

/* ---------------- Binance 即時報價：純函式（可在 node 測試）
   文件：https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams
   顯示價格 = aggTrade.p；24h 漲跌 = (last − open) / open（滾動 24 小時，非 UTC+8 日內）。 */
const BN_STABLE = new Set(["USDC", "USDT", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1", "PYUSD", "USDE", "RLUSD", "EUR", "EURI", "AEUR", "XUSD", "USDS", "USDG", "GBP", "BFUSD"]);
/** REST /fapi/v1/ticker/24hr 或 WS 24hrTicker 事件 → 統一欄位。 */
function bnTicker(d) {
  if (d.e) return { symbol: d.s, last: +d.c, open: +d.o, high: +d.h, low: +d.l, volume: +d.v, quote_volume: +d.q, ts: +d.E || 0 };
  return { symbol: d.symbol, last: +d.lastPrice, open: +d.openPrice, high: +d.highPrice, low: +d.lowPrice, volume: +d.volume, quote_volume: +d.quoteVolume, ts: +d.closeTime || 0 };
}
/** 合併一則 Binance 報價（kind = "trade"：aggTrade 事件 {s,p,T,a}；"ticker"：bnTicker 結果）。回傳新物件或 null（訊息較舊）。
 *  ticker 的 last 只有在 ticker 時間嚴格晚於目前成交時間時才會寫入價格，永遠不覆蓋較新的成交價。 */
function bnMerge(prev, kind, d, recvMs) {
  const sym = d && (d.s || d.symbol); if (!sym) return null;
  const q = prev ? { ...prev } : { symbol: sym, inst: sym, last: null, trade_id: -1, trade_time: 0, ticker_time: 0, change_pct: null, price_src: null };
  let ts;
  if (kind === "trade") {
    const id = +d.a; ts = +d.T;
    if (ts < q.trade_time) return null;                                  // 較舊的成交
    if (ts === q.trade_time && isFinite(id) && id <= q.trade_id) return null; // 重複
    q.last = +d.p; q.trade_time = ts; if (isFinite(id)) q.trade_id = id; q.price_src = "trade";
  } else if (kind === "ticker") {
    ts = +d.ts;
    if (ts < q.ticker_time) return null;
    const o = +d.open, last = +d.last;
    q.ticker_time = ts; q.open = o; q.high = +d.high; q.low = +d.low; q.volume = +d.volume;
    q.quote_volume = isFinite(+d.quote_volume) ? +d.quote_volume : null;
    q.change_pct = o > 0 && isFinite(last) ? Math.round(((last - o) / o) * 1e5) / 1e3 : null;
    if (q.last == null || ts > q.trade_time) { q.last = last; q.trade_time = ts; q.price_src = "ticker"; }
  } else return null;
  q.event_time = Math.max(ts || 0, q.event_time || 0); q.recv_at = recvMs;
  return q;
}
/** Binance USDC 永續 24h 成交額前 n（quoteVolume，USDC；排除穩定幣與交割合約）。輸入為 REST /fapi/v1/ticker/24hr 陣列。 */
function bnTopVolume(tickers, n = 10) {
  return tickers.filter((x) => /^[A-Z0-9]+USDC$/.test(x.symbol || "")).map((x) => ({ t: bnTicker(x), base: mkBase(x.symbol) }))
    .filter(({ base }) => !BN_STABLE.has(base))
    .map(({ t, base }) => ({ key: base, name: base, symbol: t.symbol, inst: t.symbol, last: t.last, change_pct: t.open > 0 ? Math.round(((t.last - t.open) / t.open) * 10000) / 100 : 0, quote_volume: t.quote_volume, members: [] }))
    .filter((x) => x.quote_volume > 0).sort((a, b) => b.quote_volume - a.quote_volume).slice(0, n);
}
/** REST K 線 [openTime,o,h,l,c,volume,closeTime,...] → 內部 bar（v = 幣本位成交量）。 */
function bnBar(r, now) { return { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: +r[6] < (now ?? Date.now()) }; }
/** WebSocket kline 事件的 k 物件 → 內部 bar。 */
function bnWsBar(k) { return { t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closed: !!k.x }; }
/** 合併 K 線（新到舊或舊到新皆可），以 t 去重、排序。 */
function bnMergeBars(old, rows) {
  const m = new Map(old.map((b) => [b.t, b])); for (const b of rows) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

if (typeof module !== "undefined") module.exports = { computeIndicators, detectSignals, techScore, riskLevel, warmup, MK_DEFAULT_CFG, mkBias, mkDir, MK_BIAS_TFS, bnMerge, bnTicker, bnTopVolume, bnBar, bnWsBar, bnMergeBars, bnCanon, BN_INT };

/* ---------------- 瀏覽器端：行情服務 */
/** 一條 Binance 合併串流 WebSocket：連線後 SUBSCRIBE；瀏覽器會自動回應伺服器 ping。
 *  狀態看 socket 是否開啟；60 秒完全沒有訊息（K 線串流每 250ms 更新，正常不會發生）就重連。 */
function bnSocket(name, urls, streams, onData, status, emitStatus) {
  const st = (status[name] = { state: "connecting", connected: false, ever_open: false, url: null, attempts: 0, reconnects: 0, messages: 0, last_msg_at: null, last_pong_at: null, last_close: null });
  let backoff = 1000, idx = 0, ws = null, idleT = null;
  const idle = () => { clearTimeout(idleT); idleT = setTimeout(() => { st.last_close = "60 秒沒有資料"; try { ws.close(); } catch (e) {} }, 60000); };
  const open = () => {
    const url = st.ever_open ? st.url : urls[idx % urls.length]; st.attempts++;
    st.state = st.ever_open ? "reconnecting" : st.attempts > urls.length ? "failed" : "connecting"; emitStatus();
    try { ws = new WebSocket(url); } catch (e) { st.last_close = String(e); idx++; return retry(); }
    ws.onopen = () => {
      st.ever_open = true; st.url = url; st.connected = true; st.state = "open"; backoff = 1000; emitStatus();
      for (let i = 0; i < streams.length; i += 100) setTimeout(() => { try { ws.send(JSON.stringify({ method: "SUBSCRIBE", params: streams.slice(i, i + 100), id: i / 100 + 1 })); } catch (e) {} }, (i / 100) * 300);
      idle();
    };
    ws.onmessage = (e) => {
      idle();
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.error) { st.last_error = m.error.msg || String(m.error); return; }
      if (!m.stream || !m.data) return;
      st.messages++; st.last_msg_at = new Date().toISOString(); st.last_pong_at = st.last_msg_at;
      onData(m.stream, m.data);
    };
    ws.onclose = (e) => {
      clearTimeout(idleT); st.connected = false;
      st.last_close = st.last_close === "60 秒沒有資料" ? st.last_close : `code ${e.code}${e.reason ? " " + e.reason : ""}`;
      if (!st.ever_open) idx++; else st.reconnects++;
      st.state = st.ever_open ? "reconnecting" : st.attempts >= urls.length ? "failed" : "connecting";
      emitStatus(); retry();
      if (st.ever_open && st.onReconnect) st.onReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  const retry = () => { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 60000); };
  st.send = (obj) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} };
  open();
  return st;
}

if (typeof window !== "undefined") {
  window.MK = {
    cfg: MK_DEFAULT_CFG, bars: {}, ind: {}, tickers: {}, quotes: {}, marks: {}, signals: new Map(), categories: { updated_at: null, items: [] }, sentiment: null,
    status: { ws_connected: false, last_msg_at: null, reconnects: 0, messages: 0, started_at: new Date().toISOString(), rest_base: MK_REST, ws_base: BN_WS_MARKET[0], rest_tested: {}, quote: null, kline: null, source: "Binance USDⓈ-M 永續合約（USDC 本位）", data_error: null },
    listeners: [], ready: null, lastChecked: {}, heatInst: [],
    sigTfs() { return [...new Set(this.cfg.signal_timeframes.concat(MK_BIAS_TFS))]; }, // 多空分歧需要 15分/1H/4H 的訊號
    emit(ev, d) { this.listeners.forEach((fn) => fn(ev, d)); },
    async rest(path) {
      let err;
      for (const base of [MK_REST, ...MK_REST_LIST.filter((b) => b !== MK_REST)]) {
        try { let r = await fetch(base + path); this.status.rest_tested[base] = r.status;
          if (r.status === 429 || r.status === 418) { await new Promise((ok) => setTimeout(ok, 1200)); r = await fetch(base + path); }
          if (r.ok) { const j = await r.json(); if (base !== MK_REST) { MK_REST = base; this.status.rest_base = base; } this.status.data_error = null; return j; }
          let msg = ""; try { const j = await r.json(); msg = j.msg || ""; } catch (e) {}
          err = new Error(`Binance HTTP ${r.status}${msg ? " " + msg : ""}`); }
        catch (e) { err = e; this.status.rest_tested[base] = this.status.rest_tested[base] || "error"; }
      }
      this.status.data_error = `無法連上 Binance（${err && err.message}）；不會改用其他交易所`;
      this.emitStatus();
      throw err;
    },
    async backfill(sym, tf, limit = 500) {
      const rows = (await this.rest(`/fapi/v1/klines?symbol=${sym}&interval=${BN_INT[tf]}&limit=${Math.min(1500, limit)}`)).map((r) => bnBar(r, Date.now()));
      const key = sym + "|" + tf;
      this.bars[key] = bnMergeBars(this.bars[key] || [], rows).slice(-600);
      this.recalc(sym, tf);
    },
    recalc(sym, tf) { this.ind[sym + "|" + tf] = computeIndicators(this.bars[sym + "|" + tf] || [], this.cfg); return this.ind[sym + "|" + tf]; },
    scan(sym, tf, source, onlyAfter) {
      const ind = this.ind[sym + "|" + tf] || []; const out = [];
      const closed = []; ind.forEach((b, i) => b.closed && closed.push(i));
      const todo = onlyAfter == null ? closed.slice(-300) : closed.filter((i) => ind[i].t > onlyAfter);
      for (const i of todo) for (const s of detectSignals(ind, i, this.cfg, sym, tf)) {
        const id = `${sym}|${tf}|${s.rule}|${s.bar_time}`;
        if (this.signals.has(id)) continue;
        const ps = publicSignal({ ...s, id, source, created_at: new Date().toISOString() }); this.signals.set(id, ps); out.push(ps);
      }
      this.lastChecked[sym + "|" + tf] = closed.length ? ind[closed[closed.length - 1]].t : null;
      return out;
    },
    async loadHeat() {
      // 市場板塊：載入時呼叫一次 Binance 24h tickers，之後由 WS ticker 更新
      const all = await this.rest(`/fapi/v1/ticker/24hr`);
      const top = bnTopVolume(all, 10);
      this.heatInst = top.map((x) => x.symbol);
      for (const x of all) if (this.heatInst.includes(x.symbol) || this.cfg.watchlist.includes(x.symbol)) {
        const q = bnMerge(this.quotes[x.symbol], "ticker", bnTicker(x), Date.now()); if (q) this.quotes[q.symbol] = q;
      }
      this.renderHeat();
      return this.heatInst;
    },
    renderHeat() {
      const items = this.heatInst.map((s) => this.quotes[s]).filter(Boolean)
        .map((q) => ({ key: mkBase(q.symbol), name: mkBase(q.symbol), symbol: q.symbol, inst: q.inst, last: q.last, change_pct: q.change_pct, quote_volume: q.quote_volume, members: [] }))
        .sort((a, b) => b.quote_volume - a.quote_volume);
      this.categories = { updated_at: new Date().toISOString(), items, kind: "top_volume", note: "Binance USDⓈ-M USDC 永續合約 24h 成交額前 10（quoteVolume，排除穩定幣；WebSocket 即時更新）" };
      this.emit("categories", this.categories);
    },
    async refreshSentiment() {
      try {
        const r = await (await fetch("https://api.alternative.me/fng/?limit=7")).json();
        const zh = { "Extreme Fear": "極度恐懼", Fear: "恐懼", Neutral: "中性", Greed: "貪婪", "Extreme Greed": "極度貪婪" };
        const hist = (r.data || []).map((d) => ({ value: +d.value, label: zh[d.value_classification] || d.value_classification, time: isoTPE(+d.timestamp * 1000) }));
        if (hist.length) this.sentiment = { ...hist[0], history: hist, source: "alternative.me Fear & Greed Index" };
      } catch (e) { /* 改用後台快照 */ }
    },
    async start(cfg) {
      if (cfg) this.cfg = { ...cfg, watchlist: [...new Set((cfg.watchlist || MK_DEFAULT_CFG.watchlist).map(bnCanon))] };
      const heat = this.loadHeat().catch((e) => { console.warn("heat", e); return []; });
      this.ready = (async () => {
        await Promise.all(this.cfg.watchlist.flatMap((s) => MK_TFS.map((tf) => this.backfill(s, tf).then(() => { if (this.sigTfs().includes(tf)) this.scan(s, tf, "history"); }).catch((e) => console.warn("backfill", s, tf, e)))));
      })();
      this.refreshSentiment();
      await heat;
      this.connectQuotes();
      await this.ready;
      this.connectCandles();
      setInterval(() => this.refreshSentiment(), 600000);
    },
    emitStatus() {
      const q = this.status.quote || {}, k = this.status.kline || {};
      this.status.ws_connected = !!k.connected; this.status.last_msg_at = k.last_msg_at; this.status.reconnects = k.reconnects || 0; this.status.messages = k.messages || 0; this.status.ws_base = k.url || BN_WS_MARKET[0];
      this.status.quote_ok = !!q.connected;
      this.emit("status", this.status);
    },
    connectQuotes() {
      const w = this.cfg.watchlist.map((x) => x.toLowerCase());
      const tick = [...new Set(this.cfg.watchlist.concat(this.heatInst))].map((x) => x.toLowerCase());
      const streams = w.map((x) => `${x}@aggTrade`).concat(tick.map((x) => `${x}@ticker`)).concat(w.map((x) => `${x}@markPrice@1s`));
      let heatT = null;
      const st = bnSocket("quote", BN_WS_MARKET, streams, (stream, d) => {
        const now = Date.now();
        if (d.e === "markPriceUpdate") { // 標記價格（模擬交易的未實現損益 / ROI 用）
          const sym = d.s, ts = +d.E; if (!this.marks[sym] || ts >= this.marks[sym].ts) { this.marks[sym] = { px: +d.p, ts }; this.emit("mark", { symbol: sym, px: +d.p, ts }); }
          return;
        }
        const kind = d.e === "aggTrade" ? "trade" : d.e === "24hrTicker" ? "ticker" : null; if (!kind) return;
        const q = bnMerge(this.quotes[d.s], kind, kind === "ticker" ? bnTicker(d) : d, now); if (!q) return;
        this.quotes[q.symbol] = q;
        if (this.cfg.watchlist.includes(q.symbol) && q.last != null) {
          st.last_quote_at = new Date(now).toISOString();
          const t = { symbol: q.symbol, last: q.last, change_pct: q.change_pct, open: q.open, high: q.high, low: q.low, volume: q.volume, quote_volume: q.quote_volume, event_time: q.event_time, trade_time: q.trade_time, recv_at: now, price_src: q.price_src };
          this.tickers[q.symbol] = t; this.emit("ticker", t);
        }
        if (kind === "ticker" && this.heatInst.includes(q.symbol) && !heatT) heatT = setTimeout(() => { heatT = null; this.renderHeat(); }, 2000);
      }, this.status, () => this.emitStatus());
      this.qst = st;
    },
    connectCandles() {
      const streams = this.cfg.watchlist.flatMap((s) => MK_TFS.map((tf) => `${s.toLowerCase()}@kline_${BN_INT[tf]}`));
      const st = bnSocket("kline", BN_WS_MARKET, streams, (stream, d) => {
        if (d.e !== "kline") return; const tf = BN_INT_REV[d.k.i]; if (!tf) return;
        this.onCandle(d.s, tf, bnWsBar(d.k));
      }, this.status, () => this.emitStatus());
      st.onReconnect = () => this.resync();
    },
    onCandle(sym, tf, bar) {
      const key = sym + "|" + tf, buf = this.bars[key] || (this.bars[key] = []);
      if (buf.length && buf[buf.length - 1].t === bar.t) buf[buf.length - 1] = bar;
      else if (!buf.length || bar.t > buf[buf.length - 1].t) { if (buf.length) buf[buf.length - 1].closed = true; buf.push(bar); if (buf.length > 600) buf.splice(0, buf.length - 600); }
      else return;
      const ind = this.recalc(sym, tf);
      this.emit("kline", { symbol: sym, tf, bar: publicBar(ind[ind.length - 1]), closed: bar.closed });
      if (bar.closed && this.sigTfs().includes(tf)) this.scan(sym, tf, "live", this.lastChecked[key] ?? bar.t - 1).forEach((x) => this.emit("signal", x));
    },
    async resync() {
      for (const s of this.cfg.watchlist) for (const tf of MK_TFS) {
        try { await this.backfill(s, tf, 300); if (this.sigTfs().includes(tf)) this.scan(s, tf, "recovered", this.lastChecked[s + "|" + tf]).forEach((x) => this.emit("signal", x)); } catch (e) {}
      }
    },
    klines(sym, tf, limit) { return { symbol: sym, tf, source: "Binance " + sym, bars: (this.ind[sym + "|" + tf] || []).slice(-Math.max(30, Math.min(limit || 300, 600))).map(publicBar) }; },
    summary(sym) {
      const out = { symbol: sym, base: mkBase(sym), name: mkName(sym), inst: sym, ticker: this.tickers[sym] || null };
      out.spark = (this.bars[sym + "|1h"] || []).slice(-30).map((b) => b.c);
      const dims = {};
      for (const tf of MK_TFS) {
        const ind = this.ind[sym + "|" + tf]; if (!ind || !ind.length) continue;
        const row = ind[ind.length - 1], sc = techScore(row);
        if (sc) { sc.rsi = num(row.rsi, 2); dims[tf] = sc; }
        if (tf === "4h") { out.risk = riskLevel(ok(row.atr, row.c) && row.c ? (row.atr / row.c) * 100 : null);
          out.snapshot = Object.fromEntries(["c", "ma20", "ma60", "rsi", "macd", "macd_signal", "macd_hist", "bb_up", "bb_mid", "bb_lo", "atr"].map((k) => [k, num(row[k], 6)])); }
      }
      out.tech = dims["4h"]; out.dims = dims;
      out.bias = mkBias(dims, [...this.signals.values()].filter((x) => x.symbol === sym), Date.now());
      const since = Date.now() - 86400000;
      out.signals_24h = [...this.signals.values()].filter((s) => s.symbol === sym && s.bar_time >= since).length;
      return out;
    },
    signalList({ symbol, tf, limit = 60 } = {}) {
      return [...this.signals.values()].filter((s) => (!symbol || s.symbol === symbol) && (!tf || s.tf === tf)).sort((a, b) => b.bar_time - a.bar_time || (a.id < b.id ? 1 : -1)).slice(0, limit);
    },
  };
}
