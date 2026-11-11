/* 測試1號與團隊策略共用 trade-ui.js；公開頁面只讀。 */
const NEW_ACTIONS = {EVALUATION_FAILED:"評估失敗",REVERSE_LONG:"停損反手做多",REVERSE_SHORT:"停損反手做空",OPEN_LONG:"新開多單",OPEN_SHORT:"新開空單",ADD:"加倉",HOLD:"續抱",WAIT:"觀望",PAUSE_ADD:"暫停加倉",CANCEL_ENTRY:"取消委託",REDUCE:"部分減倉",CLOSE:"全部平倉",UPDATE_PROTECTION:"調整獲利保護"};
function originalActionHTML(dec, execution) {
  const names={WAIT:"觀望",OPEN:"新開倉",HOLD:"續抱",CLOSE:"只平倉",REVERSE:"反手",UPDATE_RISK:"調整保護",CANCEL_ORDER:"取消委託"};
  return dec?.action ? `<div class="callout"><b>AI 團隊持倉動作：${esc(names[dec.action]||dec.action)}</b><span>${execution?esc(execution.reason||execution):"執行結果請見模擬交易紀錄。"}</span></div>` : "";
}
function dailyUsageHTML(u) {
  if(!u)return "";
  return `<section class="card usage-card"><div class="card-h"><h2>API 當日累計請求（RPD）</h2><span class="chip-muted">美西配額日 ${esc(u.quota_day)}</span></div><div class="usage-slots">${Object.entries(u.slots).map(([k,v])=>`<article><small>第 ${esc(k)} 組${k === "5" ? "・OpenAI" : k === "4" ? "・策略測試" : "・AI 團隊"}</small><b class="num">${v.calls}<small> 次</small></b><span>成功 <strong class="up">${v.ok}</strong>・失敗 <strong class="down">${v.errors}</strong>・未完成 ${v.pending}</span>${quotaRowsHTML(v,k,u.quotas)}<details><summary>API 回報與錯誤明細</summary>${Object.entries(v.models).map(([m,d])=>`<p><b>${esc(m)}</b> × ${d.calls}<br>API 回報：${esc(Object.keys(d.actual_models).join("、") || "尚無成功回報")}<br>錯誤：${esc(Object.entries(d.error_codes || {}).map(([c,n])=>`${c} × ${n}`).join("、") || "無")}</p>`).join("") || '<p>當日尚無請求</p>'}</details></article>`).join("")}</div></section>`;
}
function quotaRowsHTML(slot, number, quotas) {
  const names={"gpt-6-luna":"GPT-6 Luna","gemini-3.5-flash-lite":"Gemini 3.5 Flash-Lite","gemini-3.1-flash-lite":"Gemini 3.1 Flash-Lite","gemini-3.6-flash":"Gemini 3.6 Flash","gemini-3.8-flash":"Gemini 3.8 Flash"};
  return `<div class="quota-models">${Object.entries(slot.models).sort(([a],[b])=>{const order=["gemini-3.8-flash","gemini-3.6-flash","gemini-3.5-flash-lite","gemini-3.1-flash-lite"],rank=m=>order.includes(m)?order.indexOf(m):99;return rank(a)-rank(b)||a.localeCompare(b);}).map(([model,data])=>{
    const q=quotas?.[number]?.[model],limit=Number(q?.rpd),known=Number.isFinite(limit)&&limit>0,ratio=known?data.calls/limit:0;
    return `<div class="quota-model"><div><b>${esc(names[model] || model)}</b><strong class="num ${ratio>=1?"down":ratio>=.8?"warn":""}">${data.calls}${known?" / "+limit:""}</strong></div>${known?`<progress max="${limit}" value="${Math.min(data.calls,limit)}" class="${ratio>=1?"over":ratio>=.8?"near":""}" aria-label="${esc(names[model] || model)} 當日觀測用量"></progress>`:""}</div>`;
  }).join("") || '<p class="note">當日尚無模型請求。</p>'}</div>`;
}
function liquidationHTML(dv) {
  const q=dv.liquidations;
  if(!q || q.venue!=="OKX")return '<span class="muted">等待 OKX 清算快照</span>';
  const money=v=>v == null?"—":Math.abs(v)>=1e6?`$${(v/1e6).toFixed(2)}M`:`$${fmtPrice(v,2)}`;
  return `<span class="down">${money(q.long)}</span> / <span class="up">${money(q.short)}</span><small class="liq-meta ${q.stale?"warn":"muted"}">${esc(q.inst)}・${esc(q.status)}・${q.n} 筆<br>更新 ${fmtTime(q.last_success_ms)}（台北）・約涵蓋 ${Number(q.hours || 0).toFixed(1)}h<br>${esc(q.note)}</small>`;
}
function strategyManagerHTML(P) {
  if(!P)return '<p class="note">測試1號狀態尚未推送。</p>';
  const m=P.manager || {}, d=P.decisions?.[0], cfg=P.settings || {}, binding=P.binding;
  const backup=cfg.strategy_backup?.model||cfg.model||"gemini-3.5-flash-lite";
  const luna=cfg.hourly_luna_only?"整點":"每小時優先";
  return `<p>${esc(m.message || "等待初始化")}</p><dl class="manager-details"><dt>評估 API</dt><dd>${cfg.hourly_luna_active ? esc(luna)+"用 GPT-6 Luna（"+esc(cfg.hourly_luna_thinking || "high")+"），失敗由 "+esc(backup)+" 補評" : "第 4 組 Gemini"}</dd><dt>例行主模型</dt><dd>${esc(cfg.model || "gemini-3.5-flash-lite")}</dd><dt>例行備援模型</dt><dd>${esc(cfg.fallback_model || "gemini-3.1-flash-lite")}</dd><dt>評估狀態</dt><dd>${m.busy ? "評估中" : esc(m.message || "等待")}</dd><dt>最近評估</dt><dd>${m.last_evaluated ? fmtTime(m.last_evaluated*1000) : "尚未評估"}${m.model ? `・${esc(m.model)}` : ""}</dd><dt>報告標的</dt><dd>${binding ? esc(binding.symbol) : "等待研究報告"}</dd><dt>最新決策</dt><dd>${d ? `${esc(NEW_ACTIONS[d.action] || d.action)}・${fmtTime(d.created_ms)}<br>${esc(d.reason)}` : "尚無決策紀錄"}</dd></dl>${binding ? `<a class="ok" href="#/report/${encodeURIComponent(binding.run_id)}">對應研究報告 ›</a>` : ""}<p class="note">每五分鐘只評估當前報告標的，先對照上一份同標的研究與各自帳戶實際結果；已填 RPD 時按預算降頻。報告最多沿用兩小時；過期後暫停新增曝險，既有持倉仍依最新行情評估，停利、資金費及強平持續運作。兩個測試共用評估，分別記錄結果。</p>`;
}
function previousReviewHTML(review, link = true) {
  if(!review)return "";
  const market=review.observed_market || {}, previous=review.previous_decision || {};
  const date = `前次報告：${esc(fmtTime(review.report_finished_at))}`;
  const reference = !review.report_id ? "尚無可用的前次同標的報告"
    : link ? `<a class="ok" href="#/report/${encodeURIComponent(review.report_id)}">${date}</a>` : date;
  return `<section class="card new-section"><div class="card-h"><h2>前次研究與實際結果回顧</h2></div><p>${reference}</p><p>先前方向 ${esc(previous.decision || "—")}・觀測最高 ${fmtPrice(market.high)}／最低 ${fmtPrice(market.low)}・${review.horizon_matured ? "已到原定觀察期限，仍依實際成交判讀" : "階段檢討，尚不提前判定整份報告成敗"}</p><p class="note">${esc(market.coverage || review.note || "回顧資料不足時如實保留未知。")}</p><p class="note">對照前次理由與已保存成交，由各角色說明本次延續或修正的證據；價格觸及不等於實際成交。</p></section>`;
}
function strategyBranchHTML(P, details = strategyManagerHTML(P)) {
  return `<div class="strategy-branch"><div class="branch-node" id="strategy-research"><h3>團隊市場研究報告</h3><p>四位分析師、多空研究員、研究經理的研究摘要</p><small class="muted">供兩個測試帳戶參考市場背景</small></div><span class="branch-arrow" aria-hidden="true">→</span><div class="agent branch-node" id="ag-new-strategy" role="button" tabindex="0" aria-label="策略測試經理：查看評估狀態"><div class="ah"><span class="ai">${ICON.brief}</span><span class="an">策略測試經理</span></div>${details}</div><span class="branch-arrow" aria-hidden="true">→</span><div class="branch-node"><h3>測試1號／測試2號</h3><b class="num">各 10,000 USDC</b><p>獨立資金與持倉<br>只處理報告標的</p><a class="ok" href="#/paper/new">查看測試1號 ›</a> <a class="ok" href="#/paper/test2">查看測試2號 ›</a></div><p class="branch-note note">原團隊 12 位維持原流程，只裁決 AI 團隊策略；策略測試經理獨立評估，不計入上方 12 位研究進度。</p></div>`;
}
function strategyReportBody(report) {
  const decision = report.decision || {};
  const fields = [
    ["本次評估", decision.reason], ["執行結果", report.reason], ["風險評估", decision.risk_plan],
    ["反證", decision.counter_evidence], ["前次調整", decision.review_adjustment],
    ["下次檢查", decision.next_review_trigger],
  ];
  const plan = [
    ["AI 提案", NEW_ACTIONS[decision.action] || decision.action],
    ["委託方式", {MARKET: "市價", LIMIT: "限價"}[decision.order_type]],
    ["進場價", decision.entry_price], ["投入保證金（USDC）", decision.requested_margin_usdc],
    ["槓桿", decision.leverage == null ? null : formatLeverage(decision.leverage)],
    ["委託有效秒數", decision.valid_for_seconds], ["停利價", decision.take_profit_price],
    ["獲利啟動（USDC）", decision.profit_activation_usdc], ["獲利回吐（USDC）", decision.profit_giveback_usdc],
    ["擬減倉數量", decision.close_lots?.length ? decision.close_lots.reduce((sum, lot) => sum + Number(lot.qty || 0), 0) : null],
  ].filter(([, value]) => value != null);
  return `<dl class="manager-details">
    ${fields.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}
    ${plan.map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}
    </dl>${previousReviewHTML(report.review, false)}`;
}
function strategyReportsHTML(result, account) {
  const route = account === "test2" ? "#/paper/test2" : "#/paper/new";
  const rows = result.rows.map(report => {
    const action = NEW_ACTIONS[report.action] || report.action || "—";
    const status = {done: "已處理", failed: "評估失敗", skipped: "未執行"}[report.status] || "未執行";
    return `<details class="din" data-sync-key="${esc(report.id)}" data-report-file="${esc(report.file || "")}" data-report-rev="${esc(report.detail_rev || "")}">
      <summary>${esc(baseOf(report.symbol))}・${fmtTime(report.created_ms)}・${esc(status)}・${esc(action)}・${esc(report.model || "模型 —")}${report.source === "hourly_fallback" ? "・整點補評" : ""}</summary>
      <div class="strategy-report-body" data-sync-key="${esc(report.detail_rev || report.id)}">${report.file ? "" : strategyReportBody(report)}</div></details>`;
  }).join("");
  return `<section class="card new-section" id="strategy-reports"><div class="card-h"><h2>策略測試經理報告</h2><span class="chip-muted">共 ${result.count} 份</span></div>
    ${rows ? `<div class="review-list">${rows}</div>` : '<p class="note">尚無評估紀錄。</p>'}
    ${reportPager(result, route, "策略測試經理報告分頁")}</section>`;
}
function bindStrategyReports() {
  $$("#strategy-reports details[data-report-file]").forEach(panel => {
    const load = async () => {
      const file = panel.dataset.reportFile;
      const body = panel.querySelector(".strategy-report-body");
      if (!panel.open || !file || body.dataset.loaded) return;
      body.dataset.loaded = "pending";
      body.textContent = "載入評估中…";
      try {
        DATA.revisions[file] = panel.dataset.reportRev;
        body.innerHTML = strategyReportBody(await J(file));
        body.dataset.loaded = "yes";
      } catch {
        delete body.dataset.loaded;
        body.textContent = "載入失敗，請收合後再展開。";
      }
    };
    panel.ontoggle = load;
    if (panel.open) load();
  });
}
async function pageNewPaper(account = "test1", params = new URLSearchParams()) {
  const view = location.hash;
  const selectAccount = data => account === "test2" ? data.test2 : data;
  let P = selectAccount(await J("new-paper.json"));
  if (view !== location.hash) return;
  if(!P){$("#app").innerHTML='<div class="empty-state"><b>等待測試2號帳戶資料</b><small>請在本機更新後等待正常推送。</small></div>';return;}
  const loadReports = state => catalogPage(account, Number(params.get("page")), () => state.decisions || []);
  let reports = await loadReports(P);
  if (view !== location.hash) return;
  const test2=P.strategy_id === "test2", name=test2 ? "測試2號" : "測試1號";
  setTitle(name, "獨立虛擬帳戶");
  const n=(v,d=2)=>v == null ? "—" : Number(v).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
  const money=v=>v == null ? "—" : `${v>0?"+":""}${n(v)}`;
  const report=c=>`<a class="ok" href="#/report/${encodeURIComponent(c.report_id)}">研究報告</a>`;
  const contract=c=>`<div class="pc-name">${coinIcon(baseOf(c.symbol),22)}<b>${esc(c.symbol)}</b><span class="tag">永續</span><span class="tag">${formatLeverage(c.leverage)} 逐倉</span><span class="tag ${c.side === "LONG" ? "t-up" : "t-down"}">${c.side === "LONG" ? "做多" : "做空"}</span></div>`;
  const legs=c=>`${test2 ? `<p class="note">AI 停利價 ${fmtPrice(c.protection?.take_profit_price)}・獲利啟動 ${n(c.protection?.profit_activation_usdc)} USDC・回吐額 ${n(c.protection?.profit_giveback_usdc)} USDC・保護${c.protection?.armed?"已啟動":"尚未啟動"}；未設定顯示 —。</p><div class="table-scroll"><table class="tbl"><thead><tr><th>批次</th><th>原始成本</th><th>剩餘數量</th><th>剩餘保證金</th><th>未分攤資金費</th></tr></thead><tbody>${(c.lots || []).map(l=>`<tr><td>${fmtTime(l.ts)}</td><td>${fmtPrice(l.price)}</td><td>${n(l.remaining_qty,6)}</td><td>${n(l.margin_remaining)}</td><td>${money(l.funding_remaining)}</td></tr>`).join("")}</tbody></table></div>` : ""}<details class="new-legs"><summary>首次進場與 ${c.add_count} 次加倉明細</summary><div class="table-scroll"><table class="tbl"><thead><tr><th>時間（台北）</th><th>階段</th><th>成交價</th><th>數量</th><th>投入保證金</th><th>槓桿</th></tr></thead><tbody>${(c.legs || []).map(l=>`<tr><td>${fmtTime(l.ts)}</td><td>${l.seq ? `第 ${l.seq} 次加倉` : "首次進場"}</td><td>${fmtPrice(l.price)}</td><td>${n(l.qty,6)}</td><td>${n(l.margin)} USDC</td><td>${formatLeverage(l.leverage)}</td></tr>`).join("")}</tbody></table></div></details>`;
  const closedCycles = () => P.cycles.filter(c=>c.status === "closed").sort((a,b)=>b.close_ms-a.close_ms);
  const layout = () => `<div class="ro-banner">${name}・獨立虛擬 ${n(P.initial)} USDC・只做模擬</div>
    <div class="grid-4"><div class="card kcard"><small>目前權益（含未實現）</small><div class="row"><span class="big num" id="new-eq">${n(P.equity)}</span></div><small>可用資金 ${n(P.available)} USDC</small></div><div class="card kcard"><small>已實現損益（含資金費）</small><div class="row"><span class="big num ${signCls(P.realized_pnl)}">${money(P.realized_pnl)}</span></div><small>資金費 ${money(P.funding_net)} USDC</small></div><div class="card kcard"><small>勝率</small><div class="row"><span class="big num">${P.win_rate == null ? "—" : n(P.win_rate)+"%"}</span></div><small>${P.wins} 勝／${P.trades} 筆已平倉</small></div><div class="card kcard"><small>最大回撤（已實現權益）</small><div class="row"><span class="big num down">${n(P.max_drawdown_pct)}%</span></div><small>模擬強平 ${P.liquidations} 次</small></div></div>
    ${tradePanelHTML(P.open.length,P.pending.length)}
    <section class="card new-section"><div class="card-h"><h2>${ICON.trendUp}權益曲線</h2><span class="chip-muted">已實現權益・含資金費</span></div><div id="new-eq-chart"></div></section>
    ${P.engine.last_error || P.engine.protection_warning ? `<div class="callout"><b>模擬帳戶狀態</b><span>${esc(P.engine.last_error || P.engine.protection_warning)}</span></div>` : ""}
    ${strategyReportsHTML(reports, account)}
    <section class="card new-manager"><div class="card-h"><h2>${ICON.brief}策略測試經理</h2><span class="chip-muted">${P?.settings?.hourly_luna_active ? "GPT-6 Luna" : "第 4 組・Flash-Lite"}</span></div>${strategyManagerHTML(P)}</section>`;
  $("#app").innerHTML = layout();
  bindStrategyReports();
  const pos=open=>open.length ? `<div class="table-scroll"><table class="tbl pos-tbl"><thead><tr><th>合約</th><th>數量</th><th>持倉均價</th><th>標記價格</th><th>強平價格</th><th>累計保證金</th><th>淨盈虧（收益率）</th><th>${test2 ? "回本價（扣已實現損益）" : "停利價格／目標"}</th><th>${test2 ? "已實現調整損益" : "下次加倉候選價"}</th><th></th></tr></thead><tbody>${open.map(c=>`<tr><td>${contract(c)}</td><td>${n(c.qty,6)}</td><td>${fmtPrice(c.avg_price)}</td><td data-new-mark="${c.id}">${fmtPrice(c.mark_price)}</td><td class="warn">${fmtPrice(c.liq_price)}</td><td>${n(c.margin)} USDC</td><td data-new-pnl="${c.id}">${money(c.unrealized)}</td><td class="num">${test2 ? fmtPrice(c.break_even_price) : fmtPrice(c.take_profit)+"／"+n(c.margin*.1)+" USDC"}</td><td>${test2 ? money(c.realized_partial || 0)+" USDC" : fmtPrice(c.next_add_price)}${c.add_paused ? '<br><small>AI 暫停加倉</small>' : ""}</td><td>${report(c)}</td></tr><tr class="position-legs" data-sync-key="legs-${c.id}"><td colspan="10">${legs(c)}</td></tr>`).join("")}</tbody></table></div><div class="pos-cards new-pos-cards">${open.map(c=>`<article class="pcard" data-sync-key="pos-${c.id}"><div class="pc-h">${contract(c)}</div><div class="pc-pnl"><div><small>淨盈虧（收益率）</small><b data-new-pnl="${c.id}">${money(c.unrealized)} USDC</b></div></div><dl class="mobile-pos-grid">${[["數量",n(c.qty,6)],["持倉均價",fmtPrice(c.avg_price)],["標記價格",`<span data-new-mark="${c.id}">${fmtPrice(c.mark_price)}</span>`],["強平價格",fmtPrice(c.liq_price)],["累計保證金",n(c.margin)+" USDC"],[test2?"回本價（扣已實現）":"停利價格",fmtPrice(test2?c.break_even_price:c.take_profit)],[test2?"已實現調整損益":"獲利目標",test2?money(c.realized_partial || 0)+" USDC":n(c.margin*.1)+" USDC"],[test2?"加倉時機":"下次加倉候選價",test2?"AI 決定":fmtPrice(c.next_add_price)]].map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${c.add_paused?'<p class="warn">AI 暫停加倉</p>':""}${legs(c)}<div class="pc-foot">${report(c)}</div></article>`).join("")}</div>` : '<div class="empty-state"><b>目前沒有倉位</b><small>AI 依報告標的決定進場或觀望；不保證每次評估都掛單。</small></div>';
  let tab=(pageNewPaper.state?.[account]?.tab) || "pos", range=(pageNewPaper.state?.[account]?.range) || "3m";
  const pages=pageNewPaper.state?.[account]?.pages || {};
  const ranges=[["1d","一天",1],["1w","一週",7],["1m","一個月",30],["3m","三個月",90]];
  const hist=()=>{const since=Date.now()-(ranges.find(r=>r[0] === range)?.[2] || 90)*86400000;
    const {rows,footer}=tradePage(closedCycles().filter(c=>c.close_ms>=since),pages,"hist");
    return `<div class="tabs compact pp-range">${ranges.map(([k,t])=>`<button class="tab outline ${range === k ? "active" : ""}" data-range="${k}">${t}</button>`).join("")}</div><div class="hist-rows">${rows.length ? rows.map(c=>`<article class="hist-row" data-sync-key="closed-${c.id}"><div class="hist-head"><div class="hist-contract">${contract(c)}<span class="hist-state">完全平倉</span></div><div class="hist-times"><span>開倉 ${fmtTime(c.fill_ms)}</span><span>平倉 ${fmtTime(c.close_ms)}</span><span>持續 ${fmtDur(c.close_ms-c.fill_ms)}</span></div></div><dl class="hist-metrics">${[["已實現盈虧（含資金費）",`${money(c.pnl_net)} USDC`],["收益率",fmtPct(c.roi_pct)],["已平倉量",`${n(c.closed_qty ?? c.qty,6)} ${esc(baseOf(c.symbol))}`],["持倉均價",fmtPrice(c.avg_price)],["平倉價格",fmtPrice(c.close_price)],["最大未平倉量",n(c.max_qty ?? c.qty,6)]].map(([k,v],i)=>`<div><dt>${k}</dt><dd class="num ${i<2 ? signCls(c.pnl_net) : ""}">${v}</dd></div>`).join("")}</dl><div class="hist-foot"><span>${esc(c.close_reason)}</span><span>價差 ${money(c.pnl_price)}・資金費 ${money(c.funding_paid_total ?? c.funding_total)}・累計投入保證金 ${n(c.invested_margin ?? c.margin)}</span>${report(c)}</div>${legs(c)}</article>`).join("") : '<div class="empty-state"><b>所選期間內沒有已平倉的倉位</b></div>'}</div>${footer}`;};
  const render=(next=tab)=>{tab=TRADE_TABS.some(t=>t[0] === next) ? next : "pos";pageNewPaper.state ||= {};pageNewPaper.state[account]={tab,range,pages};selectTradeTab(tab);patchHTML($("#pp-body"),{pos:()=>{const {rows,footer}=tradePage(P.open,pages,"pos");return pos(rows)+footer},ord:()=>tradeOrdersHTML(P.pending,P.strategy_id),orders:()=>tradeOrdersHTML(P.orders || [],P.strategy_id),fills:()=>tradeFillsHTML(tradeFills(P,P.strategy_id)),hist,funding:()=>tradeFundingHTML(P,pages)}[tab]());$$("[data-range]").forEach(b=>b.onclick=()=>{range=b.dataset.range;pages.hist=0;render();});bindTradePager(pages,tab,render);update();};
  const update=()=>{let u=0,complete=true;for(const c of P.open){const px=MK.marks[coinKey(c.symbol)]?.px ?? c.mark_price;if(px == null){complete=false;continue;}const net=(px-c.avg_price)*c.qty*(c.side === "LONG" ? 1 : -1)+c.funding_total;u+=net;const a=$$(`[data-new-mark="${c.id}"]`),b=$$(`[data-new-pnl="${c.id}"]`);a.forEach(e=>e.textContent=fmtPrice(px));b.forEach(e=>{e.textContent=`${money(net)} USDC (${fmtPct(net/c.margin*100)})`;e.className=signCls(net);});}if(complete)$("#new-eq").textContent=n(P.initial+P.realized_pnl+u);};
  bindTradeTabs(render);render();const timer=setInterval(update,1000);pageCleanup.push(()=>clearInterval(timer));
  const chart=makeChart($("#new-eq-chart"),240,{timeScale:{timeVisible:true}}),series=chart.addAreaSeries({lineColor:"#0ecb81",topColor:"rgba(14,203,129,.2)",bottomColor:"rgba(14,203,129,0)"});
  const renderCurve = () => { const points=[];for(const p of P.curve){const pt={time:Math.floor(p.t/1000)+TZ_SHIFT,value:p.equity};if(points.length && points.at(-1).time === pt.time)points[points.length-1]=pt;else points.push(pt);}if(!points.length)points.push({time:Math.floor(Date.now()/1000)+TZ_SHIFT,value:P.initial});series.setData(points); };
  renderCurve(); series.createPriceLine({price:P.initial,color:"#929aa5",lineStyle:2,axisLabelVisible:false,title:"起始"});chart.timeScale().fitContent();
  onData(["new-paper.json", catalogFile(account)], async (active) => {
    const next = selectAccount(await J("new-paper.json"));
    if (!next || !active()) return;
    const nextReports = await loadReports(next);
    if (!active()) return;
    const changedAccount = next !== P;
    const visible = chart.timeScale().getVisibleLogicalRange();
    P = next;
    reports = nextReports;
    patchHTML($("#app"), layout(), "#new-eq-chart,#pp-body,#new-eq,.strategy-report-body");
    bindStrategyReports();
    if (changedAccount) {
      bindTradeTabs(render); render(); renderCurve();
      if (visible) chart.timeScale().setVisibleLogicalRange(visible);
    }
  });
}
