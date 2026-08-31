// Vercel Serverless 入口（Node.js Serverless Functions 模式）
// 所有请求（页面静态文件 + /api/*）统一进入这里处理：
//   - api/index.js 内含登录鉴权（未登录跳转 /login.html）
//   - 文件上传走 Vercel Blob，数据库走 Neon PostgreSQL
module.exports = require('./api/index.js');
