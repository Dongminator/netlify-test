# app.gsf.test

GSF俱乐部会员App的本地测试克隆，仿照 https://app.gsffc.org 的活动报名功能。

## 运行

```bash
npm install
npm start
```

打开 http://localhost:3000 （默认跳转到活动日历，未登录会先跳到登录页）。

需要一个 PostgreSQL 数据库（如 Supabase），在 `.env` 中配置 `DATABASE_URL` 和 `SESSION_SECRET`（见 `.env.example`）。表结构和种子数据在 `db/schema.sql`，**首次部署前手动在数据库执行一次**（应用代码不会自动建表）。

## 部署到 Netlify

整个 Express 应用通过 [`serverless-http`](https://github.com/dougmoscrop/serverless-http) 打包成单个 Netlify Function 运行，`public/` 下的静态资源由 CDN 直接提供。

1. 把仓库连接到 Netlify（或用 `netlify deploy`）。构建配置已在 `netlify.toml` 中：发布目录 `public/`，函数目录 `netlify/functions/`，并通过重定向把所有非静态请求转发给 `server` 函数。
2. 在 Netlify 站点的 **Site settings → Environment variables** 中设置：
   - `DATABASE_URL` —— PostgreSQL 连接串（Netlify Functions 是无状态的，需要一个外部数据库；session 也存在该库里）
   - `SESSION_SECRET` —— 任意随机字符串
3. Node 版本固定为 22（`package.json` 的 `engines` + 函数运行时）。

本地用 `netlify dev` 可模拟该环境（需要 `npm i -g netlify-cli`）。

## 测试账号

所有种子账号密码均为 `gsf2026`：

- demo@gsffc.org
- donglin@gsffc.org
- dike@gsffc.org / kevin@gsffc.org / lifeng@gsffc.org / yangfan@gsffc.org

## 功能

- 登录 / 登出（session认证，未登录访问受保护页面会重定向到 /login）
- `/calendar` 活动日历：即将开始 / 已结束的活动列表
- `/event/:id` 活动详情：时间地点说明、报名 / 取消报名（含容量上限）、报名名单、留言
- 到场签到：已报名会员点击"📍 到场签到"，浏览器获取手机GPS位置，服务端校验与球场坐标的距离 ≤ 签到半径（每个活动单独存储，默认10米）才签到成功；名单中显示"已签到"标记，取消报名会同时清除签到
- 🧪 测试设置（仅POC）：活动详情页右侧可直接修改该活动的签到点坐标和签到半径（也可点击地图选点、或一键填入自己当前位置），方便在任意位置测试GPS签到
- `/member-list` 会员列表

数据存储在 `data/db.json`（无需数据库）。原站 `/event/6a2a24a22e8d92aecd66b520` 对应的活动在本地同样可通过该id访问。

⚠️ 仅供本地测试：密码为明文存储，session secret硬编码。

## 用手机测试签到

浏览器定位API只在 **HTTPS 或 localhost** 下可用。手机直接访问 `http://<电脑IP>:3000` 会拿不到定位。可选方案：

- 用 `ngrok http 3000`（或 cloudflared）生成 HTTPS 临时地址给手机访问
- 或在电脑浏览器 DevTools 的 Sensors 面板模拟坐标进行测试（球场坐标见 `data/db.json`）

另外手机GPS精度通常为5~20米，10米阈值在实际使用中可能偏严，可在活动详情页的"🧪 测试设置"中调大该活动的签到半径。
