// Cloudflare Workers 静态托管入口
// 将 /admin 重写为 /admin.html，其余交给静态资产 (ASSETS) 处理
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /admin -> /admin.html（补全扩展名，避免 404）
    if (path === '/admin' || path === '/admin/') {
      return env.ASSETS.fetch(new Request(url.origin + '/admin.html', request));
    }

    // 根路径 -> index.html（静态托管一般自动处理，这里兜底）
    if (path === '/' || path === '') {
      return env.ASSETS.fetch(new Request(url.origin + '/index.html', request));
    }

    // 其他路径交给静态资产
    return env.ASSETS.fetch(request);
  }
};
