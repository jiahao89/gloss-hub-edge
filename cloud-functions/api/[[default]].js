// GlossaHub EdgeOne Pages Node Function 入口
//
// 路由机制 (经 CLI 源码确认): 本文件位于 cloud-functions/api/[[default]].js,
// 平台生成路由 /api/*, 运行时把剥离了 /api 前缀后的路径写入 req.url
// (例如 /api/health → /health), 再调用本文件导出的框架实例。
// 而 server/app.cjs 的所有路由都注册在 /api/xxx 下, 因此这里用 router
// 把请求重新映射回 /api 前缀, 与 Render/Vercel 代理直连时的行为对齐。
//
// 注意 1: 不得启动 HTTP server / listen (server/edgeone-entry.cjs
// 会先设置 EDGEONE_FUNCTION 标记再加载 app.cjs, 使 app.cjs 跳过 listen)。
// 注意 2: CLI 构建器按 "export default app" 字面量识别 Express 框架实例,
// 因此 default export 的变量名必须叫 app。
import express from 'express';
import glossahub from '../../server/edgeone-entry.cjs';

const app = express();
app.use('/', (req, _res, next) => {
  // 平台已把 /api/health 剥成 /health, 这里还原成 /api/health 供内部路由匹配
  if (!req.url.startsWith('/api')) {
    req.url = `/api${req.url === '/' ? '' : req.url}`;
  }
  next();
}, glossahub);

export default app;
