/**
 * /qr → 手机扫码页「固定入口」跳板（2026-11-03）
 *
 * ── 为什么存在 ────────────────────────────────────────────────
 * 扫码页（NapCat 二维码 / 重启 / 状态）跑在腾讯云服务器上，靠 cloudflared
 * 的免费「快速隧道」暴露到公网。快速隧道的域名是**随机的**，而且**隧道一重启
 * 域名就变** —— 团长存进手机的书签 / 收藏就废了（2026-10-31 重启过一次，
 * 团长 11-03 反馈「手机上那个网站打不开了」就是这原因，不是网站坏了）。
 *
 * 这个路径永远不变：https://endfield-av3.pages.dev/qr
 * → 自动跳到当前隧道地址。隧道换了只要改下面 TARGET 一行，书签不用动。
 *
 * ── 取当前地址 ───────────────────────────────────────────────
 *   ssh root@114.215.209.254 "grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
 *       /var/log/gtbot-qr-tunnel.log | tail -1"
 * 尾巴上那段 32 位 hex 是钥匙，少一段就 404。
 *
 * ⚠️ 探测本身出错（超时/网络异常）**照样跳转** —— 宁可比错误页多一跳，
 *    也不要误报「已失效」让人白跑。
 * ⚠️ 只有隧道明确返回 5xx（530 / 1033 = 隧道已断）才显示换地址提示页。
 */

const TARGET = 'https://smooth-sure-strand-toolkit.trycloudflare.com/68302852168bb2f8f3149a88f1664278/';

const GONE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫码页地址已更换</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#12100e;color:#e8dcc8;font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.box{max-width:520px;padding:28px 22px;text-align:center}
h1{font-size:19px;margin:0 0 14px}
p{margin:8px 0;font-size:14px;color:#b9ab95}
b{color:#e8dcc8}
</style></head><body><div class="box">
<h1>扫码页换地址了</h1>
<p>服务器上的隧道重启过，旧地址已经失效。</p>
<p>这个入口（<b>/qr</b>）不会变，是跳板那边还没更新。</p>
<p>在群里喊一声<b>辰安</b>，或者让他把新地址贴上来就行。</p>
</div></body></html>`;

export async function onRequest() {
  let dead = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    // 带上钥匙路径问一下服务活着没；隧道断了 Cloudflare 会回 530 / 1033
    const r = await fetch(TARGET + 'status', {
      signal: ctl.signal,
      cf: { cacheTtl: 0 },
      headers: { 'cache-control': 'no-cache' },
    });
    clearTimeout(timer);
    dead = r.status >= 500;
  } catch (e) {
    dead = false; // 探测失败不算证据，放行
  }

  if (dead) {
    return new Response(GONE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return new Response(null, {
    status: 302,
    headers: { location: TARGET, 'cache-control': 'no-store' },
  });
}
