/* 雙策略共用唯讀交易區。只使用已保存的委託／成交，不產生交易資料。 */
const TRADE_TABS = [["pos", "倉位"], ["ord", "當前委託"], ["orders", "歷史委託"], ["fills", "歷史成交"], ["hist", "倉位歷史"]];
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
      if (e.key === "ArrowRight") next = (i+1)%5; else if (e.key === "ArrowLeft") next = (i+4)%5;
      else if(e.key === "Home") next=0; else if(e.key === "End") next=4; else return;
      e.preventDefault(); render(TRADE_TABS[next][0]); $(`#trade-tab-${TRADE_TABS[next][0]}`).focus();
    };
  });
}
function tradeFills(P, strategy) {
  const out = [];
  if (strategy === "original") {
    for(const o of P.orders || []) {
      if (["open", "closed"].includes(o.status) && o.fill_ms && o.fill_price > 0 && o.qty > 0) out.push({id:`${o.id}-open`,symbol:o.symbol,side:o.side,action:"開倉",ts:o.fill_ms,price:o.fill_price,qty:o.qty,report_id:o.run_id});
      if(o.status === "closed" && o.close_ms && o.close_price > 0 && o.qty > 0) out.push({id:`${o.id}-close`,symbol:o.symbol,side:o.side,action:"平倉",ts:o.close_ms,price:o.close_price,qty:o.closed_qty || o.qty,report_id:o.run_id});
    }
  } else {
    for(const c of P.cycles || []) {
      for(const l of c.legs || []) if(l.ts && l.price > 0 && l.qty > 0) {
        const order=(P.orders || []).find(o=>o.id===l.order_id);
        out.push({id:l.order_id,symbol:c.symbol,side:c.side,action:l.seq ? `第 ${l.seq} 次加倉` : "開倉",ts:l.ts,price:l.price,qty:l.qty,report_id:order?.report_id || c.report_id});
      }
      if(c.status === "closed" && c.close_ms && c.close_price > 0 && c.qty > 0) out.push({id:`${c.id}-close`,symbol:c.symbol,side:c.side,action:"平倉",ts:c.close_ms,price:c.close_price,qty:c.qty,report_id:c.report_id});
    }
  }
  return out.sort((a,b)=>b.ts-a.ts);
}
function tradeOrdersHTML(orders, strategy) {
  const names={pending:"掛單中",filled:"已成交",open:"已成交・持倉中",closed:"已成交・已平倉",cancelled:"已取消",rejected:"拒單",same_dir_refresh:"同向更新紀錄"};
  if(!orders.length)return '<div class="empty-state"><b>尚無委託紀錄</b></div>';
  return `<div class="table-scroll"><table class="tbl pos-tbl"><thead><tr><th>合約／方向</th><th>委託方式</th><th>委託價</th><th>${strategy === "original" ? "數量" : "申請保證金（USDC）"}</th><th>狀態</th><th>委託時間（台北）</th><th>成交時間（台北）</th><th>備註</th><th></th></tr></thead><tbody>${orders.slice().sort((a,b)=>b.created_ms-a.created_ms).map(o=>`<tr><td><b>${esc(o.symbol)}</b><small class="${o.side === "LONG" ? "up" : "down"}"> ${o.side === "LONG" ? "做多" : "做空"}</small></td><td>${o.order_type === "MARKET" ? "市價" : o.order_type === "LIMIT" ? "限價" : "—"}</td><td class="num">${fmtPrice(o.entry_price ?? o.entry)}</td><td class="num">${fmtPrice(strategy === "original" ? o.qty : o.requested_margin_usdc, strategy === "original" ? 6 : 2)}</td><td>${esc(names[o.status] || o.status)}</td><td class="num">${fmtTime(o.created_ms)}</td><td class="num">${fmtTime(o.fill_ms)}</td><td class="wrap">${esc(o.note || o.close_reason || o.reason || "—")}</td><td>${o.report_id || o.run_id ? `<a class="ok" href="#/report/${encodeURIComponent(o.report_id || o.run_id)}">研究報告</a>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="note">沿用已保存資料；未記錄的欄位顯示 —。同向更新是紀錄，不代表新增成交。</p>`;
}
function tradeFillsHTML(fills) {
  if(!fills.length)return '<div class="empty-state"><b>尚無已成交紀錄</b><small>未成交、取消與拒單不列入。</small></div>';
  return `<div class="table-scroll"><table class="tbl pos-tbl"><thead><tr><th>成交時間（台北）</th><th>合約</th><th>持倉方向</th><th>成交動作</th><th>成交價</th><th>成交量</th><th>名目金額</th><th></th></tr></thead><tbody>${fills.map(f=>`<tr><td class="num">${fmtTime(f.ts)}</td><td><b>${esc(f.symbol)}</b></td><td class="${f.side === "LONG" ? "up" : "down"}">${f.side === "LONG" ? "做多" : "做空"}</td><td>${esc(f.action)}</td><td class="num">${fmtPrice(f.price)}</td><td class="num">${fmtPrice(f.qty,6)} ${esc(baseOf(f.symbol))}</td><td class="num">${fmtPrice(f.qty*f.price)} ${esc(unitOf(f.symbol))}</td><td>${f.report_id ? `<a class="ok" href="#/report/${encodeURIComponent(f.report_id)}">研究報告</a>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="note">依已保存的開倉、加倉、平倉資料呈現模擬成交；不補造歷史逐筆成交。</p>`;
}
