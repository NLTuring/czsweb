# 创智算 · 数字科技协会协作平台 (CZS Community)

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/Neon-PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![SQLite](https://img.shields.io/badge/Node-SQLite-003B57?logo=sqlite&logoColor=white)
![Vercel](https://img.shields.io/badge/Deploy-Vercel%20%2F%20Cloudflare-000000?logo=vercel&logoColor=white)

围绕高校科技社团（南京林业大学创智算数字科技协会）日常运转自主研发的全栈协作平台。系统从零实现**成员注册鉴权、社费凭证核验门禁、学科竞赛动态数据库、在线组队大厅与入队申请审批**的完整业务闭环。

---

## 核心特性

- **双模存储与 Serverless 架构**
  - **本地轻量模式 (`server-local.js` / `server-sqlite-legacy.js`)**：基于 Node.js 内置 `http`、`node:sqlite` 与 `crypto` 实现零外部依赖启动，开箱即用。
  - **云原生生产模式 (`api/index.js`)**：适配 Vercel Serverless Functions + Neon PostgreSQL + Vercel Blob 对象存储，支持自动扩缩容与全球 CDN 加速。
- **安全鉴权与核验门禁**
  - 采用 `scrypt` 加盐哈希存储密码，基于 `HttpOnly Cookie` 维护 7 天会话状态。
  - 实现真实的**社费核验状态机**：未核验用户登录后触发凭证上传流（状态置为 `PENDING`），管理员于 `/admin.html` 审核通过后解锁全站权限，杜绝前端绕过。
- **单一数据源的竞赛与资源引擎**
  - **学科竞赛库 (`js/competitions-data.js`)**：收录官方核实的国家级/省级赛事时间线、参赛要求与官网直达链接，支持按当天日期动态计算赛事阶段状态。
  - **立项报销映射 (`js/funding-data.js`)**：关联学校学科竞赛立项名单（75 项），支持立项金额查询与官网跳转。
  - **技术方向与资源索引 (`js/fields-data.js` / `js/resources-data.js`)**：涵盖嵌入式、Web 全栈、AI 等 9 大技术方向路径及 890+ 条结构化课程资源。
- **实时组队大厅与审批闭环**
  - 成员可发起绑定特定赛事的组队需求（`POST /api/team/create`）并投递入队申请（`POST /api/team/apply`）。
  - 队长端具备独立的申请人管理面板，支持一键审批入队、缺口自动扣减、满员状态标记及公告撤销。

---

## 目录结构

```text
czsweb/
├── api/                        # Vercel Serverless Functions 后端入口
├── cf-worker/                  # Cloudflare Workers 边缘部署适配
├── js/                         # 前端业务脚本与结构化竞赛/资源数据层
├── scripts/                    # 数据库初始化与 SQLite -> PostgreSQL 迁移脚本
├── index.html                  # 协会首页与竞赛/组队总览
├── competition-detail.html     # 赛事详情、动态时间线与立项报销映射页
├── team-post.html              # 组队需求发布页
├── team-detail.html            # 队伍详情与队长审批管理面板
├── admin.html                  # 管理员后台（缴费凭证审核、内部赛事发布）
├── server-local.js             # 本地开发环境服务端
├── server-sqlite-legacy.js     # 零依赖 SQLite 独立服务端
├── 数据说明.md                  # 架构设计、数据模型与接口文档
└── 部署说明.md                  # Vercel + Neon + Blob 生产环境部署指南
```

---

## 快速启动

### 1. 本地零依赖启动（SQLite 模式）

要求 Node.js `>= 22.5`（支持内置 `node:sqlite`）：

```bash
node server-sqlite-legacy.js
```

启动后访问 `http://localhost:8080`，首次运行将自动初始化 `users.db` 并在终端打印初始管理员凭据。

### 2. PostgreSQL 开发与云端部署

```bash
npm install
export DATABASE_URL="postgres://user:password@localhost:5432/czsweb"
npm run dev
```

完整的云端 Serverless 部署与数据迁移步骤详见 [部署说明.md](部署说明.md)，数据库表结构与接口规范详见 [数据说明.md](数据说明.md)。
