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
const UP_DOWN_PAGE_SIZE = 10;

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

function upDownTable(headers, rows, empty) {
  if (!rows.length) return `<p class="dim up-down-empty">${esc(empty)}</p>`;
  return `<div class="up-down-table-wrap"><table class="tbl up-down-table">
    <thead><tr>${headers.map(label => `<th scope="col">${esc(label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map((value, index) =>
      `<td data-label="${esc(headers[index])}">${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
}

function upDownPageHTML(snapshot, historyPage, unavailable = false) {
  if (!snapshot) return `<section class="card up-down-card" aria-labelledby="up-down-title">
    <h1 id="up-down-title">BTC 漲跌合約</h1><p class="dim">${unavailable ? "資料暫時無法讀取，將在下一次同步時重試。" : "等待主機發布模擬帳戶資料。"}</p></section>`;
  const periods = new Map((Array.isArray(snapshot.periods) ? snapshot.periods : []).map(period => [period.minutes, period]));
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  const pageCount = Math.max(1, Math.ceil(history.length / UP_DOWN_PAGE_SIZE));
  const page = Math.min(pageCount, historyPage);
  const status = upDownStatusLabel(snapshot.status);
  const periodName = (record) => UP_DOWN_PERIODS.get(record.period_minutes) || "—";
  return `<div class="up-down-page">
    <section class="card up-down-card" aria-labelledby="up-down-title" id="up-down-summary">
      <div class="up-down-heading"><h1 id="up-down-title">BTC 漲跌合約</h1><span class="tag">${status}</span></div>
      <p class="dim">三個週期共用同一個模擬帳戶・更新 ${esc(upDownTime(snapshot.updated_at))}（台北）</p>
      ${snapshot.status_reason ? `<p class="up-down-reason">${esc(snapshot.status_reason)}</p>` : ""}
      <dl class="up-down-metrics up-down-account">${upDownFields([
        ["起始資金", upDownMoney(snapshot.initial_balance)], ["可用資金", upDownMoney(snapshot.balance)],
        ["委託預留", upDownMoney(snapshot.reserved)], ["已實現淨損益", upDownMoney(snapshot.realized_pnl, true)],
      ])}</dl>
    </section>
    <section class="up-down-periods" aria-label="各週期合約、決策與訓練">
      ${Array.from(UP_DOWN_PERIODS.keys(), minutes => upDownPeriodHTML(minutes, periods.get(minutes))).join("")}
    </section>
    <section class="card up-down-card" id="up-down-positions">
      <h2>目前持倉</h2>
      ${upDownTable(["週期", "方向", "投入", "份數", "成交價", "手續費", "比較價", "到期時間", "模型"],
        positions.map(row => [periodName(row), upDownDirection(row.direction), upDownMoney(row.stake),
          upDownNumber(row.shares, 4), upDownNumber(row.entry_price, 3), upDownMoney(row.fees),
          upDownNumber(row.target_price), upDownTime(row.expires_at), row.model || "—"]), "目前無持倉")}
    </section>
    <section class="card up-down-card" id="up-down-orders">
      <h2>待成交委託</h2>
      ${upDownTable(["合約", "方向", "動作", "委託金額／份數", "限價", "到期時間", "模型"],
        orders.map(row => [row.market_id || "—", upDownDirection(row.direction), upDownAction(row.action),
          row.action === "SELL" ? "全部" : upDownMoney(row.amount),
          upDownNumber(row.price, 3), upDownTime(row.expires_at), row.model || "—"]),
        "目前無待成交委託")}
    </section>
    <section class="card up-down-card" id="up-down-history">
      <h2>結算紀錄</h2>
      ${upDownTable(["週期", "方向", "投入", "手續費", "比較價", "BTC 結算價", "賣出份額價", "結果", "淨損益", "完成時間", "模型"],
        history.slice((page - 1) * UP_DOWN_PAGE_SIZE, page * UP_DOWN_PAGE_SIZE).map(row =>
          [periodName(row), upDownDirection(row.direction), upDownMoney(row.stake), upDownMoney(row.fees),
            upDownNumber(row.target_price), upDownNumber(row.settlement_price), upDownNumber(row.exit_share_price, 3), upDownResult(row.result),
            upDownMoney(row.pnl, true), upDownTime(row.settled_at), row.model || "—"]), "尚無結算紀錄")}
      ${pageCount > 1 ? `<div class="up-down-pages"><button class="btn sm" type="button" data-history-page="${page - 1}" ${page === 1 ? "disabled" : ""}>上一頁</button>
        <span>第 ${page}／${pageCount} 頁</span><button class="btn sm" type="button" data-history-page="${page + 1}" ${page === pageCount ? "disabled" : ""}>下一頁</button></div>` : ""}
    </section></div>`;
}

async function pageUpDown() {
  setTitle("BTC 漲跌合約");
  const app = $("#app");
  let snapshot = null;
  let page = 1;
  let active = true;
  pageCleanup.push(() => { active = false; });
  const refresh = async () => {
    let unavailable = false;
    try {
      const data = await J(UP_DOWN_FILE);
      if (data && typeof data === "object" && !Array.isArray(data)) snapshot = data;
    } catch (error) {
      unavailable = !snapshot && !String(error.message).includes("資料尚未同步");
    }
    if (active) patchHTML(app, upDownPageHTML(snapshot, page, unavailable));
  };
  const click = (event) => {
    const button = event.target.closest("[data-history-page]");
    if (!button || button.disabled) return;
    page = Number(button.dataset.historyPage);
    patchHTML(app, upDownPageHTML(snapshot, page));
  };
  app.addEventListener("click", click);
  pageCleanup.push(() => app.removeEventListener("click", click));
  onData([UP_DOWN_FILE], refresh);
  await refresh();
}
