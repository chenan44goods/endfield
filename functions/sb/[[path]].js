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
