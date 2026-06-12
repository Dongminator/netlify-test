# app.gsf.test

GSF俱乐部会员App的本地测试克隆，仿照 https://app.gsffc.org 的活动报名功能。

## 运行

```bash
npm install
npm start
```

打开 http://localhost:3000 （默认跳转到活动日历，未登录会先跳到登录页）。

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
