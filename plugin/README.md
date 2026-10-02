# @local/mobile-console — 可安装 bundle

这是实际被安装的产物。上手指南见 [上级 README](../README.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`exports`、`files`、`dsh.bundle.patch`、`dsh.client` |
| `cordis.patch.yml` | 向 profile 组合插入一行插件条目 |
| `index.js` | **宿主半体**：两条控制路由 + 局域网桥（反向代理） |
| `client.js` | **浏览器半体**：侧边栏底部的「手机访问」小窗（含内联 QR 编码器） |
| `qr.js` | 二维码编码器**源码**，只被测试导入；实现由 `tools/inline-qr.mjs` 内联进 `client.js` |
| `icon.svg` | 插件管理页图标 |
| `locale/{en,zh}.json` | 插件管理页的标题与描述（运行时文案有意写死，不随语言变化） |

`qr.js` 不进 `files`：它是测试源码，安装产物里只应该有内联后的一份。

## 安装与卸载

安装（推荐，一行）：在 Harness 的 **Plugins** 页面 →「添加插件」里粘

```
github:lwx071001/dsh-mobile-console#path:/plugin
```

`#path:/plugin` 是包管理器的「仓库子目录」写法——本仓库的 bundle 在这个子目录里，
根目录的 `package.json` 是开发用的，直接填仓库根地址会装成 `mobile-console-dev`
（什么都没发生）。

已经 clone 到本机的话，也可以直接填本目录的绝对路径：

```
Plugins → 添加 → <仓库目录>\plugin
```

等价的 agent 调用：

```
plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

**安装或改动宿主半体后需要重启 Harness**：Node 的 ESM 模块缓存按 URL 命中，
重新启用插件行不会重新导入同一个文件（浏览器半体则会随页面刷新更新）。
卸载：Plugins 页里移除该 bundle。浏览器半体注册的一切（座位、样式表、DOM 根、
事件监听）都经 `ctx.effect` 回收；宿主半体若在监听，也在同一处关闭套接字。

## 自检

```
cd ..            # 到 mobile-console/
pnpm install     # 只装测试依赖 jsqr
node tools/verify.mjs     # 106 条：清单、补丁、两条路由、桥的真实代理与升级、编码器、样式
node tools/smoke.mjs      # 50 条：真实 bundle 装载、座位注册、小窗生命周期与拆除
```

`node tools/inline-qr.mjs` 在 `qr.js` 改动后重新生成 `client.js` 里的内联块。

## 宿主半体契约

两条路由都是 `kind: 'exact'`，都在 `ctx.webServer` 上注册，都先过
`ctx.connection.requestRejection(req)`：只有已经持有本进程浏览器会话 cookie
的页面才拿得到答案（否则 `401`，且响应体里不会出现任何令牌）。

### `GET|HEAD /api/mobile-console/handoff`

```jsonc
{
  "bridge": "stopped" | "listening",
  "bridgePort": null | 41000,          // 桥实际绑定的端口（OS 分配）
  "guiPort": 19387,                    // 回环 GUI 的端口
  "addresses": [                       // 每个非内部 IPv4 一条，含启动令牌
    { "address": "192.168.1.24", "url": "http://192.168.1.24:41000/?token=…" }
  ],
  "url": "…" | null,                   // addresses[0].url，方便使用
  "networkCount": 1,
  "hint": "…"                          // 一句可执行的指引
}
```

`url` 由 `ctx.connection.authenticatedUrl()` 生成——这是产品自己的令牌铸造口，
也只有通过上面那道门才会被调用。令牌是本进程级的 bearer 凭据，因此这条路由
**必须**保持认证，而不是像静态资源那样公开。

### `POST /api/mobile-console/bridge`

请求体 `{"action":"start"|"stop"}`，回答同上（开启后 `bridge` 为 `listening`）。

- `start` → 在 `0.0.0.0:0` 上监听一个反向代理，转发到 `127.0.0.1:<guiPort>`；
- `stop` → 关闭监听并断开所有（含已升级的）套接字；
- 插件被卸载/停用时同样关闭。

## 桥为什么长这样

转发时把 `Host` 与 `Origin` 改写成回环权威，于是每个请求在
`dsh-client-connection` 看来都和桌面窗口自己的请求一模一样：越过
DNS-rebinding 栅栏，并复用同一张签名 cookie。桥自己不持有任何秘密、不做任何认证：
没带令牌的手机收到的就是 GUI 原样的 `401`。响应体、压缩、WebSocket 帧都是原样
管道转发，因此手机上跑的是原版界面，而不是第二套会漂移的简化实现。

已升级的套接字在 Node 里是 `allowHalfOpen` 的：一端的 FIN 只会产生 `end`，
永远不会产生 `close`。桥因此显式双向传递半关闭，否则每个关掉标签页的手机都会
在 GUI 侧留下一个上游套接字（`tools/verify.mjs` 会对着真实上游断言这一点）。
