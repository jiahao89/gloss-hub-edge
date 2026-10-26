// GlossaHub EdgeOne 入口适配层 (CommonJS)
// 在加载 app.cjs 之前设置 EDGEONE_FUNCTION 标记,
// 让 app.cjs 跳过 app.listen —— Cloud Functions 环境只导出 Express 实例。
process.env.EDGEONE_FUNCTION = '1';
module.exports = require('./app.cjs');
