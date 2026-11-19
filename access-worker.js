/* Only the fixed private origin receives the local visitor credentials. */
'use strict';
const bridge = 'https://easonagents-share.pages.dev/site-bridge/';
const reportPath = /^\/reports\/[A-Za-z0-9_-]+\/report\.html$/;
const privateAsset = /^\/(?:app\.js|market\.js|up-down\.js|trade-ui\.js|new-paper\.js|styles\.css|favicon\.svg|vendor\/lightweight-charts\.standalone\.production\.js|data\/(?:runs\/)?[A-Za-z0-9_.-]+\.json)$/;
const debateJob = /^\/api\/remote\/jobs\/[a-f0-9]{32}$/;
const failed = status => new Response(null, {status, headers: {'Cache-Control':'no-store'}});
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function readKeys(client) {
  if (!client) return null;
  const page = new URL(client.url);
  if (page.origin !== self.location.origin ||
      !(['/', '/index.html', '/debate', '/debate.html'].includes(page.pathname) || reportPath.test(page.pathname))) return null;
  const pair = new MessageChannel();
  return new Promise(resolve => {
    function finish(keys) {
      clearTimeout(timer);
      pair.port1.close();
      resolve(keys);
    }
    const timer = setTimeout(() => finish(null), 4000);
    pair.port1.onmessage = ({data}) => finish(
      typeof data?.device === 'string' && /^[a-f0-9]{64}$/.test(data.device) &&
      typeof data?.session === 'string' && /^[a-f0-9]{64}$/.test(data.session) ? data : null);
    client.postMessage({type:'eason-visitor-credentials'}, [pair.port2]);
  });
}

async function privateRequest(event, path, remote) {
  const client = event.clientId && await self.clients.get(event.clientId);
  const keys = await readKeys(client);
  if (!keys) return failed(403);
  const req = event.request;
  const headers = new Headers({'Authorization':'Bearer '+keys.device, 'X-Eason-Session':keys.session});
  if (remote) {
    for (const name of ['Content-Type', 'X-Eason-Visitor']) {
      if (req.headers.has(name)) headers.set(name, req.headers.get(name));
    }
  }
  const result = await fetch(bridge + (remote ? path.slice('/api/'.length) : 'content'+path), {
    method:req.method, headers, body:req.method === 'POST' ? await req.arrayBuffer() : undefined,
    credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer', signal:req.signal,
  });
  if (result.status === 403) client.postMessage({type:'eason-access-recheck'});
  const reply = new Headers({'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff'});
  if (result.headers.has('Content-Type')) reply.set('Content-Type', result.headers.get('Content-Type'));
  return new Response(result.body, {status:result.status, headers:reply});
}

self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (req.mode === 'navigate' && (reportPath.test(path) || path === '/debate' || path === '/debate.html')) {
    event.respondWith(fetch('/index.html', {cache:'no-store', redirect:'error'}).catch(() => failed(503)));
    return;
  }
  const remote = (req.method === 'POST' && path === '/api/remote/queue') ||
      (req.method === 'GET' && debateJob.test(path));
  if (!remote && !(privateAsset.test(path) && ['GET','HEAD'].includes(req.method))) return;
  event.respondWith(privateRequest(event, path, remote).catch(() => failed(503)));
});
