# mobile-console — DSH 插件：手机访问

在**手机浏览器**里打开这台电脑上的 DeepSeek Harness：点侧边栏底部的
「手机访问」，开启通道，扫二维码——手机上出现的就是**同一个界面、同一份会话**。

- 桌面端：侧边栏底部一个小按钮 → 一个**小窗**（不遮挡、不接管界面），里面有
  一个二维码、一条地址、三步连接说明，以及开关。
- 手机端：系统相机扫二维码 → 打开浏览器 → 就是完整的 DSH Web GUI，可以直接
  看会话、发消息、处理审批、看任务与目标。

上一版是一个「手机专用控制台」：点开后全屏接管主界面、功能很多、还回不去。
那一版被否决了，也已整体删除——本版只做一件事：把界面递到手机上。

## 安装

前置：已经装好 DeepSeek Harness（Desktop 应用，或 `dsh` 命令行）。

这个插件不在 npm 上，安装 = 把仓库里的 **`plugin/` 目录**作为一个本地 bundle 加进你的
profile。在 Harness 的 **Plugins** 页面 →「添加插件」里，两种都行：

**方式一 · 一行地址**（最省事）：

```
github:lwx071001/dsh-mobile-console#path:/plugin
```

`#path:/plugin` 是包管理器的「仓库子目录」写法；等价的 https 形式是
`https://github.com/lwx071001/dsh-mobile-console#path:/plugin`。

**方式二 · 本地目录**：`git clone https://github.com/lwx071001/dsh-mobile-console.git`
（或在仓库页点 `Code → Download ZIP` 解压），然后在同一个输入框里填入 `plugin`
目录的**绝对路径**。等价的 agent 调用：
`plugin_manager  action: install_bundle  target: <…>\plugin`

装完都要 **重启一次 Harness**；刷新页面后侧边栏底部才会出现「手机访问」。

> ⚠️ **不要**直接填仓库根地址（`https://github.com/lwx071001/dsh-mobile-console`）：
> bundle 在 `plugin/` 子目录里，根目录的 `package.json` 是开发用的
> （`mobile-console-dev`，没有 `dsh` 字段）。这一点实测过——`pnpm add github:lwx071001/dsh-mobile-console`
> 装下来的是 `mobile-console-dev`，装完什么都不会发生。

重启为什么不能省：宿主半体是新的 JS 模块，而 Node 的 ESM 缓存按 URL 命中，
在 Harness 里停用/再启用插件行**不会**重新导入同一个文件（浏览器半体会随页面刷新更新）。

## 环境要求

| 项 | 要求 |
|---|---|
| Harness | **Desktop 应用**——本插件是针对它的行为写的：Web 服务只监听回环、`ctx.connection` 提供 `requestRejection` / `authenticatedUrl`、侧边栏存在 `sidebar.footer.action` 座位。CLI 的 `dsh web` 理论上同样可用，但**未实测**。 |
| 手机 | 与电脑在同一局域网；任一现代手机浏览器（用系统相机扫码即可） |
| 开发自检 | Node ≥ 20；`pnpm install` 只用于装测试依赖 `jsqr`（`plugin/` 本身零运行时依赖） |

插件只使用宿主的公开接口，但**不承诺跨版本兼容**。换 DSH 版本后，30 秒验收：

1. 重启后访问 `http://127.0.0.1:<端口>/api/mobile-console/handoff` —— 未携带会话 cookie 时
   应得到 **401**，且响应体里**不含任何令牌**（这条路由只回答已登录的页面）；
2. 页面里点「手机访问 → 开启手机访问」，出现二维码即说明两条路由与桥都工作；
3. 离线自检：`node tools/verify.mjs && node tools/smoke.mjs`（106 + 50 条断言；其中桥的
   代理转发与 WebSocket 升级是拿**真实上游**做的，不依赖 Harness）。

## 为什么需要一个「桥」

Desktop 版 Harness 用固定的 `--port 19387`、**不带** `--host` 启动 Web 服务，
所以 `dsh-host-webserver` 只监听 `127.0.0.1`。也就是说：

- 手机**从来**连不上那个端口，二维码指向局域网地址只是「永远打不开」；
- 这个绑定是启动期的配置事实，改它要改 profile 补丁 + 重启，而且会让**整个部署**
  永久对局域网开放。

所以本插件的宿主半体自带一个**局域网桥**：一个只在你说「开启」时才存在的反向代理，
监听 `0.0.0.0` 的 OS 分配端口，转发到回环上的 GUI。转发时把 `Host` / `Origin`
改写成回环权威，因此每个请求在 `dsh-client-connection` 眼里都和桌面窗口自己的请求
一样：越过 DNS-rebinding 栅栏、复用同一张签名 cookie。桥自己不持有任何秘密、
不做任何认证——没带令牌的手机拿到的就是 GUI 原样的 `401`。

## 使用

1. 刷新页面（浏览器半体随页面更新）。
2. 点侧边栏底部「手机访问」→ 小窗打开。
3. 点「开启手机访问」→ 小窗里出现二维码与地址。
4. 手机连同一个 Wi-Fi，用相机扫二维码。
5. 用完点「停止手机访问」；关掉小窗或刷新页面都会让通道消失。

若第 3 步提示「没有找到局域网 IPv4 地址」，说明这台电脑没有接入局域网。

**激活需要重启一次 Harness**：宿主半体的 JavaScript 换了文件内容，但 Node 的 ESM
模块缓存按 URL 命中，重新启用插件行不会重新导入同一个文件。重启后宿主半体才是新版。

## 目录

| 路径 | 作用 |
|---|---|
| `plugin/` | 被安装的 bundle（`package.json` + `cordis.patch.yml` + `index.js` + `client.js`） |
| `plugin/qr.js` | 二维码编码器源码（只被测试导入，实现内联进 `client.js`） |
| `tools/verify.mjs` | 101 条断言：清单、补丁、路由、**真实代理与 WebSocket 升级**、编码器、样式 |
| `tools/smoke.mjs` | 48 条断言：真实 bundle 装载、座位注册、小窗生命周期与拆除 |
| `tools/inline-qr.mjs` | 把 `qr.js` 内联进 `client.js`（生成物由 verify 复核） |
| `tools/qr-decode.mjs` | 用独立解码器 jsQR 做可读性回归 |
| `plugin/README.md` | bundle 的安装说明与宿主路由契约 |

## 自检

```
cd dsh-mobile-console      # 克隆下来的仓库目录
pnpm install
node tools/verify.mjs
node tools/smoke.mjs
```

## 五个关键设计决定

1. **小窗，不是接管。** 面板是 `position: fixed` 的一层，挂在 `<body>` 上，从不
   改写 `<html>` 的标记、也不隐藏主界面；唯一占用的座位是侧边栏底部那一行。
   上一次的「回不去主界面」正是全屏接管造成的，形态上被彻底去掉。
2. **桥，不是 `--host 0.0.0.0`。** 重新绑定是启动期配置，要改 profile 补丁、要重启、
   且永久放大整个部署的暴露面；桥只有一个套接字、只在你开启时存在、卸载即消失，
   并且在**没有命令行可用**的 Desktop 应用里也能工作。
3. **递过去的是原版界面。** 手机加载的是这个部署自己的 Web GUI，走同一套协议。
   没有第二套客户端要与上游同步，也没有「手机版缺了什么功能」的问题。
4. **令牌只发给已认证的页面。** `handoff` 与 `bridge` 两条路由都先过
   `ctx.connection.requestRejection`；令牌由 `ctx.connection.authenticatedUrl()`
   铸造，而这个接口只在那道门之后被调用。公开路由里绝不出现凭据。
5. **半关闭要显式传递。** Node 里已升级的套接字是 `allowHalfOpen`，对端 FIN 只会
   产生 `end`、永不产生 `close`——照抄常见写法会让每台关掉标签页的手机在 GUI 侧
   留下一个上游套接字。verify 对真实上游断言了这件事。

## 安全边界（请读）

- 开启期间，**同一局域网内拿到该地址的人都能打开这个 Harness**。地址里的令牌是
  本进程级的 bearer 凭据；请只在可信网络上开启，用完点「停止」。
- 关闭后端口立即不再监听；桥不会在后台保留任何套接字。
- 手机拿到的是与桌面窗口同等的权限（它就是同一个已认证会话）。
- 插件的宿主半体不做任何超出「转发到回环」的事：无 TLS 终止、无凭据存储、
  无第二条协议。

## 验证记录

| 项 | 结果 |
|---|---|
| `node tools/verify.mjs` | 106 条断言全过（含真实上游的代理转发、`Host`/`Origin` 改写、WebSocket `101`、关闭后端口不再监听、卸载即关闭桥、侧边栏通栏胶囊与无填充强调色） |
| `node tools/smoke.mjs` | 50 条断言全过（真实 bundle 装载 → `apply` → 座位注册 → 开/启/停/关闭 → 收起栏只留状态点 → 全部 effect 拆除干净） |
| `cordis_inspect` 实时服务契约 | `ctx.get("connection")` + `requestRejection` + `authenticatedUrl` 与代码用法逐项一致 |
| **对着正在运行的 GUI 的在线桥测试** | 用本进程的 `plugin/index.js` 直接起桥（`upstreamPort=19387`），以 `192.168.71.25:<bridgePort>` 为权威发起请求：匿名 `GET /` → `401`；带会话 cookie `GET /` → `200`（36456 字节，含 `__DSH_BOOT__`）；`/assets/index-5SrrfWpU.js` → `200`（633245 字节）；`/api/remote.mux` 匿名 → `401`、带 cookie → **`101 websocket`**；`close()` 后端口拒绝连接 |
| 在线探测（重启前） | `GET /api/mobile-console/handoff` 仍返回**旧版**载荷 ⇒ 确认宿主半体需要重启才生效 |

在线桥测试用的会话 cookie 是按本机 `~/.dsh/.credentials.yaml` 里
`client-connection/browser-session` 的签名密钥、针对权威 `127.0.0.1:19387` 现签的，
所以它证明的正是手机将走过的同一条路径：局域网权威 → 桥 → 回环权威 → 签名 cookie。

## 仍未验证

- **真机**：手机上的触控、软键盘、安全区，以及二维码在真实相机下的识别；
  这里只有 jsQR 的离线解码证据（8 个载荷、版本 1–10）。
- **重启后的插件激活**：上面的在线桥测试是直接在进程外调用 `plugin/index.js` 完成的；
  插件行本身在**重启之后**才会加载这份新宿主代码，重启前的在线探测仍返回旧载荷。
- 局域网里存在多张网卡时，二维码默认用第一张网卡的地址（其余地址列在
  `addresses` 里但界面上不显示）。

## 许可

[MIT](LICENSE) © 2026 lwx071001
