(async function () {
  'use strict';
  const host = 'https://easonagents-share.pages.dev';
  const bridge = host + '/site-bridge/';
  const reportPath = /^\/reports\/[A-Za-z0-9_-]+\/report\.html$/;
  const path = location.pathname;
  const get = id => document.getElementById(id);
  const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
  let device, session, active = false, busy = false, timer, popup, previous;
  const requestButton = get('request'), linkButton = get('link'), retryButton = get('retry');

  if (!['/', '/index.html', '/debate', '/debate.html'].includes(path) && !reportPath.test(path)) {
    get('title').textContent = '找不到這個頁面';
    const home = document.createElement('a');
    home.href = '/';
    home.textContent = '回到首頁';
    get('detail').replaceChildren(home);
    return;
  }

  function show(title, detail, buttons = []) {
    get('title').textContent = title;
    get('detail').textContent = detail;
    for (const button of [requestButton, linkButton, retryButton]) button.hidden = !buttons.includes(button);
  }
  function credential(storage, name) {
    let value = storage.getItem(name);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) {
      value = hex(crypto.getRandomValues(new Uint8Array(32)));
      storage.setItem(name, value);
    }
    return value;
  }
  async function api(relative, method = 'GET') {
    return fetch(bridge+relative, {method, headers:{Authorization:'Bearer '+device,'X-Eason-Session':session},
      cache:'no-store', mode:'cors', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer',
      signal:AbortSignal.timeout(15000)});
  }
  async function controlled() {
    const sw = navigator.serviceWorker;
    await sw.register('/access-worker.js', {scope:'/', updateViaCache:'none'});
    await sw.ready;
    if (!sw.controller) {
      await new Promise((resolve,reject) => {
        function finish() { clearTimeout(limit); sw.removeEventListener('controllerchange', finish); resolve(); }
        const limit = setTimeout(() => { sw.removeEventListener('controllerchange', finish); reject(Error()); }, 8000);
        sw.addEventListener('controllerchange', finish);
        if (sw.controller) finish();
      });
    }
    if (new URL(sw.controller.scriptURL).pathname !== '/access-worker.js') throw Error();
  }
  async function openPrivatePage() {
    const report = reportPath.test(path), debate = path === '/debate' || path === '/debate.html';
    const asset = report ? path.slice(1) : debate ? 'debate.html' : 'index.html';
    if (!report) await controlled();
    const result = await api('content/'+asset);
    if (result.status === 404) { show('找不到這份內容','請從研究報告頁重新選取。'); return; }
    if (!result.ok) throw Error();
    const html = await result.text();
    if (report) {
      const frame = document.createElement('iframe');
      frame.id = 'report-view'; frame.title = '研究報告';
      frame.setAttribute('sandbox','allow-modals');
      frame.referrerPolicy = 'no-referrer';
      const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
      frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="'+policy+'">'+html;
      document.title = '研究報告 · easonAgents';
      document.body.replaceChildren(frame);
      return;
    }
    const doc = new DOMParser().parseFromString(html,'text/html');
    const scripts = Array.from(doc.querySelectorAll('script'));
    for (const script of scripts) script.remove();
    const gateStyle = document.querySelector('link[href="/access.css"]');
    document.title = doc.title || 'easonAgents';
    document.documentElement.dataset.siteAccess = 'private';
    for (const node of doc.head.querySelectorAll('meta[name],link,style')) document.head.appendChild(document.importNode(node,true));
    document.body.replaceChildren(...Array.from(doc.body.childNodes, node => document.importNode(node,true)));
    gateStyle?.remove();
    for (const original of scripts) {
      const script = document.createElement('script');
      if (original.src) {
        const url = new URL(original.getAttribute('src'), location.origin+'/');
        if (url.origin !== location.origin) throw Error();
        script.src = url.href;
        await new Promise((resolve,reject) => {
          script.onload = resolve; script.onerror = reject; document.body.appendChild(script);
        });
      } else if (debate) {
        script.textContent = original.textContent;
        document.body.appendChild(script);
      }
    }
  }
  function repeat(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!document.hidden) check(); else repeat(delay); }, delay);
  }
  async function check() {
    if (busy) return;
    busy = true;
    try {
      const response = await api('access/status');
      if (!response.ok) throw Error();
      const {status} = await response.json();
      if (status === 'allow' || status === 'once') {
        if (!active) { await openPrivatePage(); active = true; }
        document.documentElement.style.visibility = '';
        repeat(30000);
      } else if (active) {
        location.reload();
      } else {
        const pending = status === 'pending', blocked = status === 'block';
        const denied = status === 'denied';
        requestButton.textContent = denied || status === 'expired' ? '重新申請訪問' : '申請訪問';
        show(pending ? '等待核准' : blocked ? '訪問已封鎖' : denied ? '本次申請已拒絕' : status === 'expired' ? '訪問已到期' : '此裝置尚未獲准',
          pending ? '申請已送出。管理者核准後，這個頁面會自動開啟。' : blocked ? '這個瀏覽器目前無法訪問網站。' :
          denied ? '如仍需要訪問，可以重新送出申請。' :
          '申請時會將公網 IP、瀏覽器及作業系統提供給網站管理者。',
          pending || blocked ? [] : [requestButton, ...(status === 'new' ? [linkButton] : [])]);
        repeat(pending ? 5000 : 30000);
      }
      previous = status;
    } catch {
      if (!get('access') && !active) {
        const message = document.createElement('p');
        message.textContent = '網站元件載入中斷，請重新載入頁面。';
        const retry = document.createElement('button');
        retry.type = 'button'; retry.textContent = '重新載入'; retry.onclick = () => location.reload();
        document.body.replaceChildren(message, retry);
        return;
      }
      if (!active) show('暫時無法連線','請確認網路連線後重試。',[retryButton]);
      repeat(15000);
    } finally { busy = false; }
  }

  try {
    if (!('serviceWorker' in navigator) || !crypto.subtle) throw Error();
    const create = () => credential(localStorage,'eason.site.device.v1');
    device = navigator.locks ? await navigator.locks.request('eason.site.identity',create) : create();
    session = credential(sessionStorage,'eason.site.session.v1');
  } catch {
    show('瀏覽器無法儲存訪問權限','請允許此網站使用瀏覽器儲存空間，再重新整理。');
    return;
  }
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.source !== navigator.serviceWorker.controller ||
        new URL(event.source.scriptURL).pathname !== '/access-worker.js') return;
    if (event.data?.type === 'eason-visitor-credentials') event.ports[0]?.postMessage({device,session});
    if (event.data?.type === 'eason-access-recheck') check();
  });
  requestButton.onclick = async () => {
    requestButton.disabled = true;
    try {
      const result = await api('access/request','POST');
      if (!result.ok) throw Error();
      await check();
    } catch { get('detail').textContent = '目前無法送出申請，請稍後再試。'; }
    finally { requestButton.disabled = false; }
  };
  linkButton.onclick = () => {
    popup = window.open(host+'/site-link','eason-site-link','popup,width=440,height=490');
    if (!popup) get('detail').textContent = '請允許此網站開啟白名單確認視窗。';
  };
  window.addEventListener('message', async event => {
    if (!popup || event.source !== popup || event.origin !== host) return;
    if (event.data?.type === 'eason-site-link-ready' && previous === 'new') {
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(device))));
      popup?.postMessage({type:'eason-site-link-device',digest},host);
    }
    if (event.data?.type === 'eason-site-linked') { popup = null; check(); }
  });
  retryButton.onclick = check;
  // Reports often open a new tab. Keep a single-visit grant with its original tab.
  document.addEventListener('click', event => {
    if (previous !== 'once' || event.defaultPrevented || event.button !== 0 ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[target="_blank"][href]');
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin === location.origin && reportPath.test(url.pathname)) {
      event.preventDefault();
      location.assign(url.href);
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('pagehide', () => { if (active) document.documentElement.style.visibility = 'hidden'; });
  window.addEventListener('pageshow', event => { if (event.persisted) check(); });
  await check();
})();
