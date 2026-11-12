/* 雙策略共用唯讀交易區。只使用已保存的委託／成交，不產生交易資料。 */
const TRADE_TABS = [["pos", "倉位"], ["ord", "當前委託"], ["orders", "歷史委託"], ["fills", "歷史成交"], ["hist", "倉位歷史"], ["funding", "資金費紀錄"]];
function formatLeverage(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toLocaleString("en-US",{maximumFractionDigits:8})}X`;
}
function tradePanelHTML(open, pending) {
  return `<section class="card paper-history trade-panel"><div class="card-h"><div class="tabs pp-tabs" id="pp-tabs" role="tablist" aria-label="模擬交易紀錄">${TRADE_TABS.map(([k,t])=>`<button class="tab" id="trade-tab-${k}" role="tab" aria-controls="pp-body" data-t="${k}">${t}${k === "pos" ? `（${open}）` : k === "ord" ? `（${pending}）` : ""}</button>`).join("")}</div></div><div id="pp-body" role="tabpanel"></div></section>`;
}
function selectTradeTab(tab) {
  $$("#pp-tabs .tab").forEach(b => { const on = b.dataset.t === tab; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
  $("#pp-body").setAttribute("aria-labelledby", `trade-tab-${tab}`);
}
function bindTradeTabs(render) {
  $$("#pp-tabs .tab").forEach(b => {
    b.onclick = () => render(b.dataset.t);
    b.onkeydown = e => { const i = TRADE_TABS.findIndex(t => t[0] === b.dataset.t); let next;
      if (e.key === "ArrowRight") next = (i+1)%TRADE_TABS.length; else if (e.key === "ArrowLeft") next = (i+TRADE_TABS.length-1)%TRADE_TABS.length;
      else if(e.key === "Home") next=0; else if(e.key === "End") next=TRADE_TABS.length-1; else return;
      e.preventDefault(); render(TRADE_TABS[next][0]); $(`#trade-tab-${TRADE_TABS[next][0]}`).focus();
    };
  });
}
function tradePage(items, pages, tab) {
  const size = 5, total = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(pages[tab] || 0, total - 1));
  pages[tab] = page;
  const footer = total === 1 ? "" : `<nav class="trade-pager" aria-label="倉位分頁">
    <button type="button" class="tab outline" data-trade-page="${page - 1}" ${page === 0 ? "disabled" : ""}>上一頁</button>
    <span aria-live="polite">${page + 1} / ${total} 頁・共 ${items.length} 筆</span>
    <button type="button" class="tab outline" data-trade-page="${page + 1}" ${page === total - 1 ? "disabled" : ""}>下一頁</button>
  </nav>`;
  return {rows: items.slice(page * size, (page + 1) * size), footer};
}
function bindTradePager(pages, tab, render) {
  $$("#pp-body [data-trade-page]").forEach(button => {
    button.onclick = () => { pages[tab] = Number(button.dataset.tradePage); render(); };
  });
}
function tradeFundingHTML(account, pages) {
  const time = row => row.funding_ms ?? row.ts;
  const cycles = new Map((account.cycles || []).map(cycle => [cycle.id, cycle]));
  const funding = (account.funding || []).slice().sort((a, b) => time(b) - time(a));
  const {rows, footer} = tradePage(funding, pages, "funding");
  if (!rows.length) return '<div class="empty-state"><b>尚無資金費紀錄</b><small>跨過 Binance 結算時點才計入。</small></div>';
  const totals = account.funding_paid == null ? "" : `<p class="note">已付 ${fmtPrice(account.funding_paid, 4)}・已收 ${fmtPrice(account.funding_received, 4)}</p>`;
  return `${totals}<div class="table-scroll"><table class="tbl"><thead><tr><th>結算時間（台北）</th><th>合約</th><th>方向</th><th>費率</th><th>結算價</th><th>金額</th></tr></thead><tbody>
    ${rows.map(row => {
      const cycle = cycles.get(row.cycle_id), side = row.side || cycle?.side;
      return `<tr><td class="num">${fmtTime(time(row))}</td><td>${esc(row.symbol || cycle?.symbol || "—")}</td><td>${side === "LONG" ? "做多" : side === "SHORT" ? "做空" : "—"}</td><td class="num">${(row.rate * 100).toFixed(4)}%</td><td class="num">${fmtPrice(row.price)}</td><td class="num ${signCls(row.payment)}">${row.payment > 0 ? "+" : ""}${fmtPrice(row.payment, 4)}</td></tr>`;
    }).join("")}</tbody></table></div>${footer}`;
}
function tradeReportId(order) {
  return order.position_review_id ? order.report_id : (order.report_id || order.run_id);
}
function tradeFills(P, strategy) {
  const out = [];
  if (strategy === "original") {
    for(const o of P.orders || []) {
      if (["open", "closed"].includes(o.status) && o.fill_ms && o.fill_price > 0 && o.qty > 0) out.push({id:`${o.id}-open`,symbol:o.symbol,side:o.side,action:"開倉",ts:o.fill_ms,price:o.fill_price,qty:o.qty,report_id:tradeReportId(o)});
      if(o.status === "closed" && o.close_ms && o.close_price > 0 && o.qty > 0) out.push({id:`${o.id}-close`,symbol:o.symbol,side:o.side,action:"平倉",ts:o.close_ms,price:o.close_price,qty:o.closed_qty || o.qty,report_id:tradeReportId(o)});
    }
  } else {
    for(const c of P.cycles || []) {
      for(const l of c.legs || []) if(l.ts && l.price > 0 && l.qty > 0) {
        const order=(P.orders || []).find(o=>o.id===l.order_id);
        out.push({id:l.order_id,symbol:c.symbol,side:c.side,action:l.seq ? `第 ${l.seq} 次加倉` : "開倉",ts:l.ts,price:l.price,qty:l.qty,report_id:order?.report_id || c.report_id});
      }
      if(["test2", "test3"].includes(strategy)) for(const e of c.exits || [])out.push({id:e.id,symbol:c.symbol,side:c.side,action:e.forced?"強平（模擬）":"部分／全部平倉",ts:e.ts,price:e.price,qty:e.qty,pnl_net:e.pnl_net,report_id:e.report_id});
      if(!["test2", "test3"].includes(strategy) && c.status === "closed" && c.close_ms && c.close_price > 0 && c.qty > 0) out.push({id:`${c.id}-close`,symbol:c.symbol,side:c.side,action:"平倉",ts:c.close_ms,price:c.close_price,qty:c.qty,report_id:c.report_id});
    }
  }
  return out.sort((a,b)=>b.ts-a.ts);
}
function tradeOrdersHTML(orders, strategy) {
  const names={pending:"掛單中",filled:"已成交",open:"已成交・持倉中",closed:"已成交・已平倉",cancelled:"已取消",rejected:"拒單",same_dir_refresh:"同向更新紀錄"};
  if(!orders.length)return '<div class="empty-state"><b>尚無委託紀錄</b></div>';
  return `<div class="table-scroll"><table class="tbl trade-record-table"><thead><tr><th>合約／方向</th><th>委託方式</th><th>委託價</th><th>${strategy === "original" ? "數量" : ["test2", "test3"].includes(strategy) ? "投入保證金／減倉量" : "申請保證金（USDC）"}</th><th>狀態</th><th>委託時間（台北）</th><th>成交時間（台北）</th><th>備註</th><th></th></tr></thead><tbody>${orders.slice().sort((a,b)=>b.created_ms-a.created_ms).map(o=>`<tr><td><b>${esc(o.symbol)}</b><small class="${(o.position_side || o.side) === "LONG" ? "up" : "down"}"> ${["REDUCE","CLOSE"].includes(o.action) ? ((o.position_side || o.side) === "LONG" ? "平多" : "平空") : ((o.position_side || o.side) === "LONG" ? "做多" : "做空")}</small></td><td>${o.order_type === "MARKET" ? "市價" : o.order_type === "LIMIT" ? "限價" : "—"}</td><td class="num">${fmtPrice(o.entry_price ?? o.entry)}</td><td class="num">${["REDUCE","CLOSE"].includes(o.action) ? fmtPrice(o.qty ?? (o.close_lots || []).reduce((sum,l)=>sum+l.qty,0),6)+" "+esc(baseOf(o.symbol)) : fmtPrice(strategy === "original" ? o.qty : o.requested_margin_usdc, strategy === "original" ? 6 : 2)}</td><td>${esc(names[o.status] || o.status)}</td><td class="num">${fmtTime(o.created_ms)}</td><td class="num">${fmtTime(o.fill_ms)}</td><td class="wrap">${esc(o.note || o.close_reason || o.reason || "—")}</td><td>${tradeReportId(o) ? `<a class="ok" href="#/report/${encodeURIComponent(tradeReportId(o))}">研究報告</a>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="note">沿用已保存資料；未記錄的欄位顯示 —。同向更新是紀錄，不代表新增成交。</p>`;
}
function tradeFillsHTML(fills) {
  if(!fills.length)return '<div class="empty-state"><b>尚無已成交紀錄</b><small>未成交、取消與拒單不列入。</small></div>';
  return `<div class="table-scroll"><table class="tbl trade-record-table"><thead><tr><th>成交時間（台北）</th><th>合約</th><th>持倉方向</th><th>成交動作</th><th>成交價</th><th>成交量</th><th>名目金額</th><th>已實現損益</th><th></th></tr></thead><tbody>${fills.map(f=>`<tr><td class="num">${fmtTime(f.ts)}</td><td><b>${esc(f.symbol)}</b></td><td class="${f.side === "LONG" ? "up" : "down"}">${f.side === "LONG" ? "做多" : "做空"}</td><td>${esc(f.action)}</td><td class="num">${fmtPrice(f.price)}</td><td class="num">${fmtPrice(f.qty,6)} ${esc(baseOf(f.symbol))}</td><td class="num">${fmtPrice(f.qty*f.price)} ${esc(unitOf(f.symbol))}</td><td class="${f.pnl_net == null ? "muted" : f.pnl_net>=0 ? "up" : "down"}">${f.pnl_net == null ? "—" : fmtPrice(f.pnl_net)+" USDC"}</td><td>${f.report_id ? `<a class="ok" href="#/report/${encodeURIComponent(f.report_id)}">研究報告</a>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="note">依已保存的開倉、加倉、平倉資料呈現模擬成交；不補造歷史逐筆成交。</p>`;
}
