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

/* ══ 🧩 服务端拼接写入（2026-11-23）════════════════════════════════════════
   团长反馈：团员用**夸克**提交支付凭证，图已经传上去了，登记那一步报 HTTP 400。

   定位：提交一次要把**整份 image_data（536KB）**读下来、再整份 PATCH 回去。
   这份大 JSON 过夸克那层云端加速/省流代理之后已经损坏 → Supabase 解析不了 → 400。
   （同一份请求在服务器上五种写法全部 200：带 548KB 真数据、带版本锁、真写进去，
     所以不是数据、权限、版本锁的问题，是手机端那一层的传输问题。）

   现在团员只发**这一条新记录（约 1KB）**，由这里读库 → 拼接 → 带版本锁写回。
   ① 走本函数独有的路径 /sb/__append_leader：老版本反代不认识它（会原样转给
      Supabase → 404），前端探测不到就自动退回老的整份写法，
     绝不会出现 image_data 被写成 {append:...} 把数据清空的事故。
   ② 数组按 id 去重 → 网络重试幂等，同一条不会追加两遍。
   ③ 读库失败一律 503 且**一个字都不写**（宁可让前端走老路，也不能拿空数组覆盖）。
   ④ void_bot：网站提交后作废「同人 + 同批次 + 同订单类型」的 QQ 待审记录，
      规则与前端 voidBotProofsOnWebSubmit 一致；时间文案由前端传（这里跑 UTC 会差 8 小时）。 */

const _normCn = function (s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
};

function _jsonOut(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

async function _appendLeader(request, url) {
  let body = null;
  try { body = JSON.parse(await request.text()); } catch (e) { body = null; }
  if (!body || typeof body !== 'object' || !body.append || typeof body.append !== 'object') {
    return _jsonOut({ error: 'append_bad_body' }, 400);
  }
  let sent = 0;
  for (const k of Object.keys(body.append)) {
    if (Array.isArray(body.append[k])) sent += body.append[k].length;
  }
  if (!sent) return _jsonOut({ error: 'append_empty' }, 400);

  const qp = new URLSearchParams(url.search);
  const key = qp.get('query_key') || '4goods';
  const wantVer = qp.get('version');

  const headers = new Headers(request.headers);
  for (const h of STRIP_HEADERS) headers.delete(h);
  headers.delete('content-length');
  headers.set('origin', ORIGIN);
  headers.set('content-type', 'application/json');

  let cur = null;
  try {
    const r = await fetch(
      ORIGIN + '/rest/v1/leader_data?query_key=eq.' + encodeURIComponent(key) + '&select=image_data,version',
      { method: 'GET', headers, redirect: 'manual' });
    if (!r.ok) return _jsonOut({ error: 'append_read_failed', status: r.status }, 503);
    const arr = await r.json();
    cur = (arr && arr[0]) || null;
  } catch (e) {
    return _jsonOut({ error: 'append_read_failed', detail: String(e) }, 503);
  }
  if (!cur) return _jsonOut({ error: 'append_row_missing' }, 404);

  let img = cur.image_data;
  if (typeof img === 'string') { try { img = JSON.parse(img); } catch (e) { img = {}; } }
  if (!img || typeof img !== 'object' || Array.isArray(img)) img = {};
  const ver = (cur.version === undefined || cur.version === null) ? null : Number(cur.version);

  if (wantVer && ver !== null && String(wantVer) !== 'eq.' + ver) {
    return _jsonOut({ conflict: 1 }, 409);
  }

  let changed = 0;
  for (const k of Object.keys(body.append)) {
    const add = body.append[k];
    if (!Array.isArray(add) || !add.length) continue;
    const arr = Array.isArray(img[k]) ? img[k] : [];
    const have = Object.create(null);
    for (const it of arr) { const id = String((it && it.id) || ''); if (id) have[id] = true; }
    const pre = [];
    for (const it of add) {
      if (!it || typeof it !== 'object') continue;
      const id = String(it.id || '');
      if (id && have[id]) continue;
      if (id) have[id] = true;
      pre.push(it);
    }
    if (pre.length) { img[k] = pre.concat(arr); changed += pre.length; }
  }

  const vb = body.void_bot;
  if (vb && vb.match && Array.isArray(img.pay_proofs)) {
    for (const p of img.pay_proofs) {
      if (!p || typeof p !== 'object') continue;
      let ok = true;
      for (const mk of Object.keys(vb.match)) {
        const want = vb.match[mk];
        const w = (mk === 'cn') ? _normCn(want) : String(want == null ? '' : want);
        const g = (mk === 'cn') ? _normCn(p.cn) : String(p[mk] == null ? '' : p[mk]);
        if (w !== g) { ok = false; break; }
      }
      if (ok) {
        const set = vb.set || {};
        for (const sk of Object.keys(set)) p[sk] = set[sk];
        changed++;
      }
    }
  }

  if (!changed) {
    return _jsonOut(ver === null ? [{ ok: true }] : [{ version: ver }], 200);
  }

  const patch = { image_data: img };
  let t = ORIGIN + '/rest/v1/leader_data?query_key=eq.' + encodeURIComponent(key) + '&select=version';
  if (ver !== null) { patch.version = ver + 1; t += '&version=eq.' + ver; }
  headers.set('prefer', 'return=representation');

  let w;
  try {
    w = await fetch(t, { method: 'PATCH', headers, body: JSON.stringify(patch), redirect: 'manual' });
  } catch (e) {
    return _jsonOut({ error: 'append_write_failed', detail: String(e) }, 502);
  }
  let txt = '';
  try { txt = await w.text(); } catch (e) { txt = ''; }
  return new Response(txt || '[]', {
    status: w.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // ── 健康探针 ──
  if (url.pathname === HEALTH_PATH) {
    return new Response(
      JSON.stringify({ ok: true, proxy: 'sb', origin: ORIGIN, append: 1, t: Date.now() }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

  /* 🧩 服务端拼接写入：见文件末尾 _appendLeader 的说明。
     GET 只用来给前端探测「这版反代支不支持」（老版本会转给 Supabase → 404）。 */
  if (url.pathname === '/sb/__append_leader') {
    if (request.method !== 'PATCH') {
      return _jsonOut({ ok: true, append: 1 }, 200);
    }
    return await _appendLeader(request, url);
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
     整批改批次名全部放行；读库失败 fail-open。

     ── 🛡 删除墓碑（2026-11-09 16:20）──────────────────────────────
     后台是「整份 group_data 覆盖」，删除只记在当前页内存里，别的设备
     不知道，一保存就把已删条目原样带回来（11-09 15:10 删 4 条、16:10
     复活即是）。现在把删除编号存进 image_data.deleted_item_ids：
     每次 PATCH 都把库中已有名单 ∪ 本次提交的名单合并写回，并从提交的
     group_data 里剔除命中的条目 —— 旧页面（连旧版前端）也带不回来。
     读库失败 fail-open，不改原代理流程。                              */
  let _patchedBody = null;
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
        if (_body && typeof _body === 'object') {
          if (typeof _body.image_data === 'string') {
            try { _body.image_data = JSON.parse(_body.image_data); } catch (e) { /* 保持原样 */ }
          }
          const _curResp = await fetch(
            ORIGIN + '/rest/v1/leader_data?select=group_data,image_data&' + _filter,
            { method: 'GET', headers, redirect: 'manual' });
          if (_curResp.ok) {
            const _curArr = await _curResp.json();
            const _curRow = (_curArr && _curArr[0]) || {};
            let _cur = _curRow.group_data || [];
            if (typeof _cur === 'string') {
              try { _cur = JSON.parse(_cur); } catch (e) { _cur = []; }
            }
            let _curImg = _curRow.image_data || {};
            if (typeof _curImg === 'string') {
              try { _curImg = JSON.parse(_curImg); } catch (e) { _curImg = {}; }
            }

            /* ① 原整批消失护栏，判定逻辑一字未改 */
            if (Array.isArray(_body.group_data)) {
              const _idsIn = Object.create(null);
              for (const it of _body.group_data) {
                if (!it || typeof it !== 'object') continue;
                const _id = String(it.item_id || it.id || '');
                if (_id) _idsIn[_id] = true;
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

            /* ② 删除墓碑：库中已有 ∪ 本次提交 */
            const _tomb = Object.create(null);
            const _addTomb = function (arr) {
              if (!Array.isArray(arr)) return;
              for (const t of arr) { const s = String(t || ''); if (s) _tomb[s] = true; }
            };
            if (_curImg && typeof _curImg === 'object') _addTomb(_curImg.deleted_item_ids);
            if (_body.image_data && typeof _body.image_data === 'object') {
              _addTomb(_body.image_data.deleted_item_ids);
            }
            const _tombList = Object.keys(_tomb);
            if (_tombList.length) {
              let _changed = false;
              if (Array.isArray(_body.group_data)) {
                const _filtered = _body.group_data.filter(function (it) {
                  if (!it || typeof it !== 'object') return true;
                  return !_tomb[String(it.item_id || it.id || '')];
                });
                if (_filtered.length !== _body.group_data.length) {
                  _body.group_data = _filtered; _changed = true;
                }
              }
              if (_body.image_data && typeof _body.image_data === 'object') {
                _body.image_data.deleted_item_ids = _tombList;
                _changed = true;
              }
              if (_changed) _patchedBody = JSON.stringify(_body);
            }
          }
        }
      }
    } catch (e) {
      // fail-open：护栏自身异常不能拖垮正常保存
    }
  }
  const init = { method: request.method, headers, redirect: 'manual' };
  if (_patchedBody !== null) {
    init.body = _patchedBody;
    headers.delete('content-length');   // body 改过，旧长度会让上游等字节
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
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
