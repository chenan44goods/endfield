/* 山团大观园 · Service Worker
   ═══ 设计铁律（勿改）══════════════════════════════════════════
   本文件存在的唯一目的：让手机能「安装成 App」（桌面图标 + 全屏无地址栏）。

   它【不】做加速。所有请求一律先走网络、拿到最新的，只有网络挂了才回退缓存。
   原因：团长每天都在改后台发版，一旦缓存了旧 index.html / admin.app.js，
   团员手机上会永远停在旧页面，团长会以为「我改的东西没生效 / 数据丢了」。
   这类问题极难排查 —— 所以宁可慢一点，也绝不许出现旧页面。

   ⚠️ 禁止改成 cache-first（图片除外也没必要），禁止在 fetch 里缓存 HTML/JS。
   ═════════════════════════════════════════════════════════════ */

var CACHE = 'shantuan-shell-v1';
var SHELL = ['/', '/app-icons/icon-192.png', '/app-icons/icon-512.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL).catch(function () { /* 单个失败不影响安装 */ });
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  // 只管 GET；POST/PATCH 之类的写操作绝不拦截
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 跨域（Supabase / 字体 / 拍卖接口）一律不碰
  if (url.origin !== self.location.origin) return;

  // 站内数据接口不碰
  if (url.pathname.indexOf('/sb/') === 0) return;

  // 网络优先；失败才回退上次缓存的壳
  e.respondWith(
    fetch(req).then(function (res) {
      // 只缓存「本身就是静态壳」的东西，且只缓存图片，绝不缓存 html/js
      try {
        if (res && res.ok && /\.(png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf)$/i.test(url.pathname)) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
      } catch (err) {}
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        // 页面导航断网时，至少给个壳
        if (req.mode === 'navigate') {
          return caches.match('/').then(function (root) {
            return root || new Response(
              '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
              '<title>山团大观园</title><body style="font-family:system-ui;background:#d6d8c5;color:#212121;' +
              'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">' +
              '<div><p style="font-size:17px;font-weight:600">网络没连上</p>' +
              '<p style="font-size:13px;color:#666;margin-top:8px">连上网后重新打开就好</p></div></body>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          });
        }
        return Response.error();
      });
    })
  );
});
