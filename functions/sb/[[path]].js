/**
 * /sb/*  →  Supabase 反向代理（Cloudflare Pages Function）
 *
 * ── 为什么存在（2026-09-25 实战定位）────────────────────────────────
 * 团员在手机端查询时报「查询异常: Failed to fetch」。逐层排查结论：
 *   DNS 解析正常（Cloudflare IP）、TCP 三次握手正常，但 TLS ClientHello
 *   带上 ServerName = *.supabase.co 之后连接被立即 RST。
 *   对照实验：同一个 IP 换 SNI 为 www.cloudflare.com / example.com 全部握手成功，
 *   只有 supabase.co 被断 → 属于**按域名（SNI）阻断**，不是 IP 被封、也不是
 *   CORS/数据/代码问题（服务器侧 curl 一直是 200）。
 *
 * 解法：让浏览器只访问本站域名（endfield-av3.pages.dev 在受影响网络上可达），
 *      由 Cloudflare 边缘去取 Supabase。边缘节点访问 Supabase 不经受该阻断。
 *
 * ── 前端怎么用 ───────────────────────────────────────────────────
 *   https://xxx.supabase.co/rest/v1/leader_data?...
 *     →  /sb/rest/v1/leader_data?...
 *   见 index.html 的 sbFetch() / sbUrl()：默认走同源反代，
 *   反代不可用时（本函数未部署 / 边缘异常）自动回退直连，保证老路径仍能用。
 *
 * ── 局限与注意 ───────────────────────────────────────────────────
 *   ⚠️ 只解决「阻断域名」这一类问题；若某网络把 pages.dev 也挡住了，则本方案无效。
 *   ⚠️ 每次请求（含每张图片）都计入 Pages Functions 免费额度（10 万次/天）。
 */

const ORIGIN = 'https://oknhlfhdqbsukskdxqre.supabase.co';

/** 前端探测端点：/sb/__health —— 用它判断"同源反代是否可用" */
const HEALTH_PATH = '/sb/__health';

/** 透传时要剥掉的、由本层/Cloudflare 自己加的头（带上会让 Supabase 误判来源） */
const STRIP_HEADERS = [
  'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-ew-via', 'cdn-loop', 'x-forwarded-proto', 'x-forwarded-for',
  'x-real-ip', 'x-forwarded-host',
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // ── 健康探针 ──
  if (url.pathname === HEALTH_PATH) {
    return new Response(
      JSON.stringify({ ok: true, proxy: 'sb', origin: ORIGIN, t: Date.now() }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

  const target = ORIGIN + url.pathname.replace(/^\/sb/, '') + url.search;

  const headers = new Headers(request.headers);
  for (const h of STRIP_HEADERS) headers.delete(h);
  // 让 Supabase 看到真实来源（它据此回显 CORS 头）
  if (!headers.has('origin')) headers.set('origin', url.origin);

  /* ── 🛡 整批消失护栏（2026-11-09，14:35 改为按 item_id 判定）─────────
     事故复盘：后台「轻量写库」会推进 CURRENT_VERSION 却不刷新 RAW_ITEMS，
     旧页面再点主保存时版本锁通过，一份没有新批次的旧排表整份盖回去。
     这里在服务端兜底：PATCH leader_data 且带 group_data 时，先读库中现有
     排表；库中某批次 >=3 条、且这批的 item_id 在本次提交里一条都不存在，
     才判定「整批消失」并 409。按批次名判会误伤「整批改批次名」（id 还在、
     名字变了），所以改按 id 判。正常保存、单条删除、只改 image_data、
     整批改批次名全部放行；读库失败 fail-open。                            */
  const _sbPath = url.pathname.replace(/^\/sb/, '');
  if (request.method === 'PATCH' && _sbPath.indexOf('/rest/v1/leader_data') === 0) {
    try {
      const _qp = new URLSearchParams(url.search);
      let _filter = '';
      for (const _k of ['query_key', 'id']) {
        const _v = _qp.get(_k);
        if (_v) { _filter = _k + '=' + encodeURIComponent(_v); break; }
      }
      if (_filter) {
        const _probe = request.clone();
        const _raw = await _probe.text();
        let _body = null;
        try { _body = JSON.parse(_raw); } catch (e) { _body = null; }
        if (_body && Array.isArray(_body.group_data)) {
          const _idsIn = Object.create(null);
          for (const it of _body.group_data) {
            if (!it || typeof it !== 'object') continue;
            const _id = String(it.item_id || it.id || '');
            if (_id) _idsIn[_id] = true;
          }
          const _curResp = await fetch(
            ORIGIN + '/rest/v1/leader_data?select=group_data&' + _filter,
            { method: 'GET', headers, redirect: 'manual' });
          if (_curResp.ok) {
            const _curArr = await _curResp.json();
            let _cur = (_curArr && _curArr[0] && _curArr[0].group_data) || [];
            if (typeof _cur === 'string') {
              try { _cur = JSON.parse(_cur); } catch (e) { _cur = []; }
            }
            const _byName = Object.create(null);
            for (const it of (Array.isArray(_cur) ? _cur : [])) {
              if (!it || typeof it !== 'object') continue;
              const n = String(it.batch_name || '').trim();
              const _id = String(it.item_id || it.id || '');
              if (!n || !_id) continue;
              if (!_byName[n]) _byName[n] = [];
              _byName[n].push(_id);
            }
            const _lost = [];
            for (const n of Object.keys(_byName)) {
              const _ids = _byName[n];
              if (_ids.length < 3) continue;
              let _any = false;
              for (const _id of _ids) { if (_idsIn[_id]) { _any = true; break; } }
              if (!_any) _lost.push([n, _ids.length]);
            }
            if (_lost.length) {
              const _names = _lost.slice(0, 3).map(function (p) { return p[0]; }).join('、');
              const _detail = _lost.slice(0, 3).map(function (p) {
                return p[0] + '（' + p[1] + ' 条）';
              }).join('，');
              return new Response(JSON.stringify({
                message: '保存已拦下：这次会把「' + _names + '」整批删掉（'
                  + _detail + '）。当前页面可能是旧的，请刷新后台后重新保存；'
                  + '确实要删整批请联系维护者。',
                error: 'batch_guard', hint: 'refresh'
              }), {
                status: 409,
                headers: {
                  'content-type': 'application/json; charset=utf-8',
                  'access-control-allow-origin': '*',
                  'cache-control': 'no-store',
                },
              });
            }
          }
        }
      }
    } catch (e) {
      // fail-open：护栏自身异常不能拖垮正常保存
    }
  }
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  let resp;
  try {
    resp = await fetch(target, init);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'proxy_fetch_failed', detail: String(e) }),
      {
        status: 502,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

  const out = new Headers(resp.headers);
  // 响应体在这里已被运行环境解压，保留 content-encoding 会让浏览器二次解压报错
  out.delete('content-encoding');
  out.delete('content-length');
  // 若上游给了指向 supabase.co 的重定向，改写成本站路径，否则浏览器会跳回被阻断的域名
  const loc = out.get('location');
  if (loc && loc.indexOf(ORIGIN) === 0) {
    out.set('location', '/sb' + loc.slice(ORIGIN.length));
  }
  if (!out.has('access-control-allow-origin')) {
    out.set('access-control-allow-origin', '*');
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: out,
  });
}
