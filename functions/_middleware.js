/**
 * Pages Functions 中间件 —— 「历史快照地址」服务端兜底
 *
 * ── 为什么存在（2026-10-04）────────────────────────────────────
 * Cloudflare Pages 每次部署都会额外生成一个**永久冻结**的快照地址
 * `<8位hex>.endfield-av3.pages.dev`：内容不可改、换域名也影响不到它。
 * 历史快照里有旧版页面（提交数据不带版本锁 → 从那交会丢；部分网络还打不开）。
 *
 * 各页 <head> 里已有一段「快照地址保险」的 JS，但那是**浏览器层**：
 * 要等页面下载完并执行 JS 才跳转。本中间件是**服务端层**的同一道保险 ——
 * 请求一进来（还没返回任何内容）就 302 跳回正式域名，因此：
 *   ✔ 不依赖 JS（爬虫、禁用 JS、分享预览卡都生效）
 *   ✔ 比 JS 更快，不会先闪一下旧页面
 *   ✔ 覆盖未来任何新页面（哪怕某次改动漏加了那段 JS）
 *
 * ⚠️ 只对「本中间件部署之后」产生的新快照生效 —— 已冻结的老快照内容改不了，
 *    它们只能靠删除部署（已做）或等边缘缓存过期。
 * ⚠️ 任何异常都必须放行（next()）—— 绝不能因为这里出错影响正式站。
 * ⚠️ 生效前提：_routes.json 的 include 必须覆盖到页面路径（现为 ["/*"]）。
 */

const CANONICAL = 'https://endfield-av3.pages.dev';

/** 只拦「8 位十六进制」形式的快照地址；正式域名、分支别名一律放行 */
const SNAP_RE = /^[0-9a-f]{8}\.endfield-av3\.pages\.dev$/;

export async function onRequest(context) {
  const { request, next } = context;
  try {
    const u = new URL(request.url);
    if (SNAP_RE.test(u.hostname)) {
      return Response.redirect(CANONICAL + u.pathname + u.search, 302);
    }
  } catch (e) {
    // 判断过程出错就放行，绝不影响正常访问
  }
  return next();
}
