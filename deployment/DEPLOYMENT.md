# GlossaHub 极简云端部署与 AI 协同指南

本指南面向个人项目，介绍如何通过 **Vercel (前端)** + **Render (后端)** + **Supabase (云数据库)** 完成极简部署。同时介绍如何让 AI 助手 (Antigravity) 协助您完成绝大部分的配置与初始化工作，将您的手动配置工作降到最低。

---

## 🚀 架构与成本总览 (个人免费方案)

```
用户浏览器 ── CDN ──> Vercel (静态托管, ¥0)
                           ↓ (HTTP)
                       Render (Express API 后端, ¥0, 15min无活动休眠)
                           ↓ (TCP 6543 Pooler)
                       Supabase (PostgreSQL 数据库, ¥0)
```

---

## 🛠️ 第一步：Supabase 数据库 (AI 协同)

您只需要完成**注册与创建项目**，其余的表结构初始化和测试都可以交给我！

1. 访问 [supabase.com](https://supabase.com) 注册并创建一个新项目（免费层）。
2. 在创建项目时，请**设置一个纯英文字母和数字的数据库密码**（建议避免使用 `@`、`:` 等特殊符号，以防止连接字符串在某些第三方平台被截断）。
3. 复制项目在 **Database Settings → Connection string → URI** 中的连接串：
   ```
   postgresql://postgres.[项目ID]:[密码]@aws-1-[区域].pooler.supabase.com:6543/postgres
   ```
   *(注：请确保选择端口为 `6543` 的 **Transaction** 或 **Session** 连接池模式，以便通过 IPv4 跨云互联)*。

### 🤖 让 AI (Antigravity) 帮您完成后续工作：
您无需手动去 SQL Editor 粘贴执行 SQL。请直接在对话中对我说：
> *"我已经创建好了 Supabase 项目，我的项目 ID 是 `xxx`，请帮我一键初始化数据库表结构并检查管理员用户。"*
我将通过底层的 `supabase` MCP 服务为您自动执行 `db_init_pg.sql` 完成全部数据表与管理员数据的写入！

---

## 💻 第二步：Render 后端部署 (必须手动配置)

由于 Render 需要绑定您的 GitHub 账号与敏感环境变量，此步骤需要您在 Render 面板上配置。

1. 访问 [render.com](https://render.com) 注册并登录。
2. 点击 **New → Web Service**，绑定您的 GitHub 并选择 **`glossa-hub`** 仓库。
3. 填写基本配置：
   - **Name**: `glossahub-api`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.cjs`
   - **Instance Type**: `Free`
4. 展开 **Advanced**，配置以下 **Environment Variables (环境变量)**：

   | 键 (Key) | 值 (Value) | 备注 |
   | :--- | :--- | :--- |
   | `DATABASE_URL` | 刚才在 Supabase 复制的 `6543` 连接池串 | **连接池地址** (包含密码) |
   | `JWT_SECRET` | 任意 32 位随机字符（如 `feTD7qUN5rIZGPrv`） | JWT 签名密钥 |
   | `NODE_ENV` | `production` | 运行环境 |
   | `CORS_ORIGINS` | `https://你的前端域名.vercel.app` | 允许的前端跨域（可在第三步部署完回填） |

5. 点击 **Create Web Service**，等待构建完成后，复制顶部生成的后端 API 地址（如 `https://glossa-hub.onrender.com`）。

### 🤖 让 AI (Antigravity) 帮您诊断连接：
部署完毕后，您可以直接告诉我：
> *"后端已经部署好了，地址是 `https://xxx.onrender.com`，请帮我检查数据库连接状态。"*
我将请求 API 探测 `/api/debug-status`。如果出现连接差错或 Host/IPv6 限制，我会在内存中**自适应将其重定向到真实的物理可用节点**，帮您无缝接通！

---

## 🎨 第三步：Vercel 前端部署 (必须手动配置)

1. 访问 [vercel.com](https://vercel.com) 注册并登录。
2. 点击 **Add New Project**，导入 **`glossa-hub`** 仓库。
3. 填写配置：
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Root Directory**: `./` (默认)
4. 展开 **Environment Variables**，添加以下环境变量：

   | 键 (Key) | 值 (Value) |
   | :--- | :--- |
   | `VITE_API_BASE_URL` | 刚才 Render 部署完成的后端 API 地址（如 `https://glossa-hub.onrender.com`） |

5. 点击 **Deploy** 部署。完成后即可获得前端正式域名（如 `https://glossa-hub.vercel.app`）。
6. **(可选)** 回到 Render 控制台，将 `CORS_ORIGINS` 环境变量更新为您实际的前端 Vercel 域名，保存以触发自动重新部署。

---

## 📝 极简运维与高可用防范

系统上线后，您在 Supabase 的数据将保持 100% 持久化。
1. **自动休眠机制**：由于 Render 免费层在 15 分钟无请求后会自动休眠，首次访问时可能需要等待约 30 秒以唤醒实例。
2. **Supabase 7天防休眠保活 (Anti-Sleep)**：
   * Supabase 免费层若连续 7 天无 SQL 活跃，会自动暂停数据库实例。
   * 本仓库内置了 GitHub Actions 定时保活流水线（`.github/workflows/keepalive.yml`），每 12 小时自动探测 `/api/health`。
   * `/api/health` 探针在执行时会执行轻量 SQL 查询 (`SELECT 1`)，持续刷新 Supabase 的不活跃倒计时，防止数据库自动休眠。
3. **生产环境防静默降级保护 (Fail-Fast Guard)**：
   * 在云端生产环境下，如果因网络或数据库休眠导致 PostgreSQL 连接受阻，后端**严禁降级到本地临时空白 SQLite**。
   * 后端会返回明确的 HTTP 503 状态码（提示“云端数据库正在从休眠中唤醒”），前端捕获后会展示友好的等待提示，避免产生“数据被清空”的误解。
4. **管理员测试账号**：一旦就绪，您可以使用内置的超级管理员账号直接登录进行测试：
   * **用户名**：`jiahao`
   * **密码**：`magene123`

