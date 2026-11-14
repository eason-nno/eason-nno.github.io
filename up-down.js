/* BTC 漲跌合約的獨立模擬帳戶。行情、決策與結算均由後台匯出。 */
"use strict";

const UP_DOWN_FILE = "up-down.json";
const UP_DOWN_ROUTE = "#/paper/up-down";
const UP_DOWN_PERIODS = new Map([[5, "5 分鐘"], [15, "15 分鐘"], [60, "1 小時"]]);
const UP_DOWN_STATES = {
  awaiting_key: "等待資料來源設定", observing: "觀察中", ready: "盤口與模型就緒", unavailable: "資料來源暫不可用",
};
const UP_DOWN_TRAINING = {
  ready: "訓練完成", trained: "訓練完成", observing: "觀察中", collecting: "收集已結算資料",
  insufficient_data: "樣本不足", not_started: "尚未訓練", waiting_training: "尚未訓練", unavailable: "訓練資料不可用",
  validation_failed: "未通過驗證",
};

function upDownStatusLabel(status) {
  return Object.hasOwn(UP_DOWN_STATES, status) ? UP_DOWN_STATES[status] : "待確認";
}

function upDownTrainingLabel(training) {
  const state = training?.status ?? training?.state;
  return Object.hasOwn(UP_DOWN_TRAINING, state) ? UP_DOWN_TRAINING[state] : "尚無訓練結果";
}

function upDownManagerHTML(snapshot) {
  const periods = new Map((Array.isArray(snapshot?.periods) ? snapshot.periods : []).map(period => [period.minutes, period]));
  const items = Array.from(UP_DOWN_PERIODS, ([minutes, label]) => {
    const data = periods.get(minutes);
    const decision = data?.decision;
    const decisionText = [upDownAction(decision?.action), decision?.model, upDownTime(decision?.at)]
      .filter(value => value && value !== "—").join("・");
    return `<li><b>${label}</b><span>${esc(upDownTrainingLabel(data?.training))}・${esc(decisionText || "尚無決策")}</span></li>`;
  }).join("");
  return `<p class="up-down-team-status"><span class="pill gray">${snapshot ? upDownStatusLabel(snapshot.status) : "尚無同步資料"}</span>${snapshot?.status_reason ? ` ${esc(snapshot.status_reason)}` : ""}</p>
    <ul class="up-down-team-periods">${items}</ul>
    ${upDownTime(snapshot?.updated_at) !== "—" ? `<p class="note">狀態更新 ${esc(upDownTime(snapshot.updated_at))}（台北）</p>` : ""}`;
}

function upDownBranchHTML() {
  return `<section class="strategy-branch up-down-team" aria-label="BTC 漲跌合約流程">
    <div class="branch-node"><h3>幣安 BTC 漲跌場次</h3><p>場次資料、參考價格與官方結算</p></div>
    <span class="branch-arrow" aria-hidden="true">→</span>
    <article class="agent branch-node" id="ag-updown-manager"><div class="ah"><span class="ai">${ICON.scale}</span><h3 class="an">漲跌合約經理</h3><span class="chip-muted">即時狀態</span></div>
      <div id="up-down-team-status">${upDownManagerHTML(null)}</div></article>
    <span class="branch-arrow" aria-hidden="true">→</span>
    <div class="branch-node"><h3>漲跌合約模擬帳戶</h3><p>三個 BTC 週期共用帳戶</p><a class="ok" href="${UP_DOWN_ROUTE}">查看漲跌合約 ›</a></div>
  </section>`;
}

function upDownNumber(value, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function upDownTime(value) {
  if (value == null || value === "" || !Number.isFinite(new Date(value).getTime())) return "—";
  return fmtTime(value);
}

function upDownMoney(value, signed = false) {
  const amount = upDownNumber(value);
  return amount === "—" ? amount : (signed && value > 0 ? "+" : "") + amount + " USDT";
}

function upDownDirection(value) {
  const direction = String(value || "").toUpperCase();
  return { UP: "漲", DOWN: "跌", WAIT: "觀望", SKIP: "略過", NONE: "—" }[direction] || "—";
}

function upDownAction(action) {
  return {
    BUY: "買入", OPEN: "買入", BUY_UP: "買入漲", BUY_DOWN: "買入跌", WAIT: "觀望",
    SKIP: "略過", HOLD: "持有", REJECTED: "未成交", SELL: "賣出", CANCEL: "取消委託", PENDING: "等待成交",
  }[String(action || "").toUpperCase()] || "—";
}

function upDownResult(result) {
  return {
    WIN: "勝", WON: "勝", LOSS: "負", LOST: "負", TIE: "平手", FLAT: "平手", PUSH: "退回", SELL: "賣出",
    VOID: "作廢", REFUND: "退回", REFUNDED: "退回", UNRESOLVED: "待確認",
    PENDING: "待結算", CANCELLED: "取消", UP: "收漲", DOWN: "收跌",
  }[String(result || "").toUpperCase()] || "—";
}

function upDownFields(fields) {
  return fields.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
}

function upDownPeriodHTML(minutes, data = {}) {
  const { market, decision, training } = data;
  const directions = upDownDirection(decision?.direction);
  const probability = typeof decision?.probability === "number" && decision.probability >= 0 && decision.probability <= 1
    ? `${upDownNumber(decision.probability * 100, 1)}%` : "—";
  const buyFee = upDownNumber(typeof market?.taker_fee_bps === "number" ? market.taker_fee_bps / 100 : null, 3);
  return `<article class="card up-down-period" data-sync-key="up-down-period-${minutes}">
    <div class="up-down-heading"><h2>${UP_DOWN_PERIODS.get(minutes)}</h2>${market?.market_id ? `<small title="${esc(market.market_id)}">合約 ${esc(market.market_id)}</small>` : ""}</div>
    ${market ? `<dl class="up-down-metrics">${upDownFields([
      ["BTC 參考價", upDownNumber(market.reference_price)],
      ["結算比較價", upDownNumber(market.target_price)],
      ["市場來源", market.provider || "—"],
      ["開盤時間", upDownTime(market.opens_at)], ["到期時間", upDownTime(market.expires_at)],
      ...(market.trade_ends_at != null && market.trade_ends_at !== market.expires_at
        ? [["停止交易", upDownTime(market.trade_ends_at)]] : []),
      ["漲 最高買價／最低賣價", `${upDownNumber(market.up_bid, 3)}／${upDownNumber(market.up_ask, 3)}`],
      ["跌 最高買價／最低賣價", `${upDownNumber(market.down_bid, 3)}／${upDownNumber(market.down_ask, 3)}`],
      ...(typeof market.book_ready === "boolean"
        ? [["官方委託簿", market.book_ready ? "已核對買賣深度" : "等待有效買賣深度"]] : []),
      ...(typeof market.up_indicative === "number" || typeof market.down_indicative === "number"
        ? [["漲／跌 參考份額價", `${upDownNumber(market.up_indicative, 3)}／${upDownNumber(market.down_indicative, 3)}`]] : []),
      ["吃單費率（基準）", buyFee === "—" ? buyFee : buyFee + "%"], ["行情時間", upDownTime(market.updated_at)],
    ])}</dl>` : '<p class="dim">尚無可核對的合約行情</p>'}
    <div class="up-down-subsection"><h3>最新決策</h3>
      ${decision ? `<dl class="up-down-metrics">${upDownFields([
        ["動作", upDownAction(decision.action)], ["方向", directions], ["模型", decision.model || "—"],
        ["評估時間", upDownTime(decision.at)], [directions === "—" ? "收漲機率" : "方向機率", probability],
        ["評估合約", decision.market_id || "—"],
      ])}</dl>${decision.reason ? `<p class="up-down-reason">${esc(decision.reason)}</p>` : ""}`
      : '<p class="dim">尚無決策</p>'}</div>
    <div class="up-down-subsection"><h3>訓練狀態</h3>
      ${training ? `<dl class="up-down-metrics">${upDownFields([
        ["狀態", upDownTrainingLabel(training)],
        ["訓練／驗證筆數", `${upDownNumber(training.training_count ?? training.training_samples, 0)}／${upDownNumber(training.validation_count ?? training.validation_samples, 0)}`],
        ["Brier", upDownNumber(training.brier ?? training.validation?.brier, 4)],
        ["訓練時間", upDownTime(training.trained_at ?? training.at)],
        ["官方已結算場次", upDownNumber(training.official_settled, 0)],
      ])}</dl>` : '<p class="dim">尚無訓練資料</p>'}</div>
  </article>`;
}

function upDownTrades(snapshot, tab, pages) {
  const periodName = row => UP_DOWN_PERIODS.get(row.period_minutes) || "—";
  const name = row => `BTC・${periodName(row)}`;
  const positions = snapshot.positions || [], orders = snapshot.orders || [], history = snapshot.history || [];
  const ordersHTML = list => tradeTable(["合約", "方向", "動作", "委託金額／份數", "限價", "到期時間（台北）", "模型"],
    list.map(o => [o.period_minutes ? name(o) : o.market_id || "—", upDownDirection(o.direction), upDownAction(o.action),
      o.action === "SELL" ? "全部" : upDownMoney(o.amount), upDownNumber(o.price, 3), upDownTime(o.expires_at), o.model || "—"]),
    "目前無待成交委託");
  if (tab === "funding") return '<div class="empty-state"><b>漲跌合約無資金費</b></div>';
  const saved = snapshot.fills || [];
  const savedSales = new Set(saved.filter(row => row.action === "SELL").map(row => `${row.market_id}:${row.at}`));
  const fills = [...saved, ...history.filter(row => row.result === "SELL" && !savedSales.has(`${row.market_id}:${row.settled_at}`))
    .map(row => ({...row, action: "SELL", at: row.settled_at, price: row.exit_share_price}))]
    .sort((a, b) => b.at - a.at);
  const { rows, footer } = tradePage({ pos: positions, ord: orders, hist: history, orders: snapshot.order_history || [],
    fills }[tab] || [], pages, tab);
  if (tab === "pos") return tradeTable(["合約", "方向", "投入", "份數", "成交價", "手續費", "結算比較價", "到期時間（台北）", "模型"],
    rows.map(o => [name(o), upDownDirection(o.direction), upDownMoney(o.stake), upDownNumber(o.shares, 4),
      upDownNumber(o.entry_price, 3), upDownMoney(o.fees), upDownNumber(o.target_price), upDownTime(o.expires_at), o.model || "—"]),
    "目前沒有倉位") + footer;
  if (tab === "ord") return ordersHTML(rows) + footer;
  if (tab === "orders") {
    const labels = {filled: "已成交", pending: "掛單中", unfilled: "未成交", cancelled: "已取消", expired: "已到期", closed: "已結束"};
    return tradeTable(["委託時間（台北）", "合約", "方向", "動作", "申請金額", "保護價／限價", "狀態", "模型"],
      rows.map(o => [upDownTime(o.created_at), name(o), upDownDirection(o.direction), upDownAction(o.action),
        o.action === "SELL" ? "全部" : upDownMoney(o.amount), upDownNumber(o.price, 3),
        labels[o.current_status || o.status] || "—", o.model || "—"]), "尚無已保存的歷史委託資料") + footer;
  }
  if (tab === "fills") return tradeTable(["成交時間（台北）", "合約", "方向", "成交動作", "成交價", "份數", "手續費", "模型"],
    rows.map(o => [upDownTime(o.at), name(o), upDownDirection(o.direction), upDownAction(o.action), upDownNumber(o.price, 3),
      upDownNumber(o.shares, 4), upDownMoney(o.fee), o.model || "—"]), "尚無已保存的成交紀錄") + footer;
  return tradeTable(["合約", "方向", "投入", "手續費", "結算比較價", "BTC 結算價", "賣出份額價", "結果",
    "已實現淨損益", "完成時間（台北）", "模型"],
    rows.map(o => [name(o), upDownDirection(o.direction), upDownMoney(o.stake), upDownMoney(o.fees),
      upDownNumber(o.target_price), upDownNumber(o.settlement_price), upDownNumber(o.exit_share_price, 3), upDownResult(o.result),
      upDownMoney(o.pnl, true), upDownTime(o.settled_at), o.model || "—"]), "尚無平倉或結算紀錄") + footer;
}

function upDownPageHTML(snapshot, unavailable = false) {
  if (!snapshot) return `<section class="card" aria-label="BTC 漲跌合約"><div class="empty-state"><b>${unavailable
    ? "資料暫時無法讀取，將在下一次同步時重試。" : "等待主機發布模擬帳戶資料。"}</b></div></section>`;
  const periods = new Map((snapshot.periods || []).map(period => [period.minutes, period]));
  const noPositions = !(snapshot.positions || []).length;
  const equity = snapshot.equity ?? (noPositions && Number.isFinite(snapshot.initial_balance) && Number.isFinite(snapshot.realized_pnl)
    ? snapshot.initial_balance + snapshot.realized_pnl : null);
  return tradeDashboard("漲跌合約", snapshot, {
    open: (snapshot.positions || []).length, pending: (snapshot.orders || []).length,
    metrics: `
      <div class="card kcard"><small>目前權益（含未實現）</small><div class="row"><span class="big num">${upDownNumber(equity)}</span></div>
        <small>可用資金 ${upDownMoney(snapshot.balance)}・委託預留 ${upDownMoney(snapshot.reserved)}</small></div>
      <div class="card kcard"><small>已入帳淨損益</small><div class="row"><span class="big num ${signCls(snapshot.realized_pnl)}">${upDownNumber(snapshot.realized_pnl)}</span></div>
        <small>手續費 ${upDownMoney(snapshot.fees_paid)}</small></div>
      <div class="card kcard"><small>勝率</small><div class="row"><span class="big num">${Number.isFinite(snapshot.win_rate) ? upDownNumber(snapshot.win_rate) + "%" : "—"}</span></div>
        <small>${Number.isFinite(snapshot.trades) ? `${snapshot.wins} 勝／${snapshot.trades} 筆已平倉` : "尚無統計"}</small></div>
      <div class="card kcard"><small>最大回撤（已實現權益）</small><div class="row"><span class="big num ${snapshot.max_drawdown_pct > 0 ? "down" : ""}">${Number.isFinite(snapshot.max_drawdown_pct)
        ? upDownNumber(snapshot.max_drawdown_pct) + "%" : "—"}</span></div><small>含成交手續費</small></div>`,
    equity: tradeEquityHTML("up-down-curve", "已入帳權益・含手續費"),
    sections: `<section class="card new-section"><div class="card-h"><h2>${ICON.brief}漲跌合約經理</h2><span class="chip-muted">${upDownStatusLabel(snapshot.status)}</span></div>
      <p class="note">${esc(snapshot.status_reason || "")}・更新 ${esc(upDownTime(snapshot.updated_at))}（台北）</p>
      <div class="up-down-periods" aria-label="各週期行情、決策與訓練">${Array.from(UP_DOWN_PERIODS, ([minutes]) =>
        upDownPeriodHTML(minutes, periods.get(minutes))).join("")}</div></section>`,
  });
}

async function pageUpDown() {
  setTitle("漲跌合約");
  const view = location.hash, app = $("#app"), pages = {};
  let snapshot = null, tab = "pos", series, chart;
  const active = () => location.hash === view;
  const render = (next = tab) => {
    if (!active() || !snapshot || !$("#pp-body")) return;
    tab = next;
    selectTradeTab(tab);
    patchHTML($("#pp-body"), upDownTrades(snapshot, tab, pages));
    bindTradePager(pages, tab, render);
  };
  async function refresh(isActive = active) {
    let data;
    try { data = await J(UP_DOWN_FILE); }
    catch (error) {
      if (isActive() && !snapshot) patchHTML(app, upDownPageHTML(null, !String(error.message).includes("資料尚未同步")));
      return;
    }
    if (!isActive() || !data || typeof data !== "object" || Array.isArray(data) || data === snapshot) return;
    snapshot = data;
    patchHTML(app, upDownPageHTML(snapshot), "#up-down-curve,#pp-body");
    bindTradeTabs(render);
    render();
    if (!series) {
      chart = makeChart($("#up-down-curve"), 240, {timeScale: {timeVisible: true}});
      series = chart.addAreaSeries({lineColor:"#0ecb81", topColor:"rgba(14,203,129,.2)", bottomColor:"rgba(14,203,129,0)"});
    }
    const points = new Map((snapshot.curve || []).map(p => [Math.floor(p.t / 1000) + TZ_SHIFT, p.equity]));
    if (!points.size && Number.isFinite(snapshot.updated_at) && Number.isFinite(snapshot.initial_balance)
        && snapshot.realized_pnl === 0 && !snapshot.history?.length) {
      points.set(Math.floor(snapshot.updated_at / 1000) + TZ_SHIFT, snapshot.initial_balance);
    }
    const visible = chart.timeScale().getVisibleLogicalRange();
    series.setData(Array.from(points, ([time, value]) => ({time, value})));
    if (visible) chart.timeScale().setVisibleLogicalRange(visible);
    else chart.timeScale().fitContent();
  }
  onData([UP_DOWN_FILE], refresh);
  await refresh();
}
