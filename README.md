# Social Signal Control Plane

面向中文内容平台的插件化监控与推送中枢。项目聚焦于“监控最新发布内容 -> 统一聚合 -> 多渠道实时分发”，当前默认覆盖抖音、微博、微信公众号、小红书，并提供浏览器端 Dashboard、SSE 实时流、Telegram、企业微信机器人、Webhook 等推送能力。

![Dashboard Preview](docs/assets/dashboard-feed.png)

## 项目定位

`Social Signal Control Plane` 不是单一平台爬虫，而是一套可扩展的消息情报工作台：

- 平台侧采用插件化设计，可继续扩展新的内容源
- 渠道侧采用模块化设计，可继续扩展新的推送方式
- 支持在页面中维护监控用户、登录状态、通知渠道
- 监控发现后的进程内分发延迟预算可压到毫秒级
- UI 同时提供管理视角和实时消息流视角，适合内容运营、舆情观察、情报汇总场景

## 核心能力

- 平台插件：抖音、微博、微信公众号、小红书
- 实时消息流：按发布时间倒序展示，支持平台分页、用户筛选
- 登录管理：需要登录的平台会在页面中展示状态，并支持点击发起登录
- 通知能力：浏览器通知、SSE、Telegram、企业微信机器人、Webhook、Console
- 热更新配置：支持在页面中动态添加、编辑、删除监控目标
- 去重与新消息基线：默认不回灌旧内容，只保留监控启动后新发现的内容

## 页面预览

- 左侧导航：功能页切换、菜单折叠
- Dashboard：全局状态、监控规模、登录状态、告警信息
- Feed：实时消息流、平台筛选、用户筛选、缩略图、发布时间
- Targets / Auth / Channels：监控目标维护、登录态维护、通知渠道维护

## 架构概览

```mermaid
flowchart LR
    A["平台插件<br/>Douyin / Weibo / WeChat / Xiaohongshu"] --> B["采集驱动<br/>Browser Session / Signed API / MP Backend"]
    B --> C["运行时中枢<br/>Watcher Scheduler / Dedupe / State Store"]
    C --> D["消息事件模型<br/>PublishedAt / Media / Source URL"]
    C --> E["Dashboard + Feed<br/>HTTP / SSE / Browser Notification"]
    C --> F["渠道插件<br/>Telegram / WeCom Bot / Webhook / Console / Custom"]
```

## 默认平台支持

| 平台 | 采集方式 | 是否需要登录 | 当前状态 |
| --- | --- | --- | --- |
| 抖音 | 浏览器登录态 + 作品接口 | 是 | 已接入 |
| 微博 | 浏览器登录态 + 页面同源接口 | 是 | 已接入 |
| 微信公众号 | `mp.weixin.qq.com` 登录态 + 后台接口 | 是 | 已接入 |
| 小红书 | 浏览器登录态 + 页面签名接口 | 是 | 已接入 |

## 默认推送渠道

| 渠道 | 说明 |
| --- | --- |
| Browser SSE | 本地页面实时消息流 |
| Browser Notification | 浏览器原生通知弹窗 |
| Telegram | 通过 Bot 推送到指定会话 |
| WeCom Bot | 通过企业微信群机器人 Webhook 推送到群聊 |
| Webhook | 推送到任意 HTTP 接收端 |
| Console | 本地终端日志输出 |

## 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

启动后访问：

- `http://127.0.0.1:3030`
- `http://127.0.0.1:3030/health`

### 3. 单次采集

```bash
node src/index.js --once
```

## 登录命令

```bash
npm run auth:douyin
npm run auth:weibo
npm run auth:wechat
npm run auth:xiaohongshu
```

说明：

- 项目不会提交任何真实登录态文件
- 浏览器登录态默认保存在 `data/browser/*.storage-state.json`
- 这些文件已经加入 `.gitignore`

## 配置说明

主配置文件位于 [config/default.config.js](config/default.config.js)。

重点配置项：

- `platforms.<platform>.targets`
  - 平台默认监控用户列表
- `platforms.<platform>.source.type`
  - 平台采集驱动类型
- `channels`
  - 推送渠道开关与参数
- `channels.wecom-bot`
  - 企业微信机器人配置，支持 `webhookKey` 或 `webhookUrl`
- `runtime.externalPlugins`
  - 外部插件加载入口
- `runtime.browser`
  - 浏览器采集参数

企业微信机器人环境变量示例：

```bash
NEWS_WECOM_BOT_WEBHOOK_KEY=your-wecom-bot-key
NEWS_WECOM_BOT_MESSAGE_TYPE=markdown
NEWS_WECOM_BOT_MENTIONED_MOBILE_LIST=
NEWS_WECOM_BOT_MENTIONED_LIST=
```

## 真实时效说明

项目默认将 `runtime.latencyBudgetMs = 10` 解释为：

- 监控进程在“发现新内容之后”完成内部事件分发的预算

这不等于互联网端到端送达必定 `1-10ms`。真实到达时间取决于：

- 平台是否提供及时可见的页面或接口数据
- 轮询周期
- 浏览器加载和风控验证
- 外部通知渠道网络状况

当前工程能力是：

- 尽快检测到平台新增内容
- 检测到后立刻进入本地页面流和通知渠道
- 默认不回灌旧消息，只推送运行期间新发现的消息

## 项目结构

```text
src/
  app/          应用装配
  channels/     推送渠道插件
  core/         运行时、HTTP、SSE、状态管理
  platforms/    平台插件与采集驱动
config/
  default.config.js
scripts/
  平台登录、辅助工具
test/
  运行时与接口测试
```

## 自定义扩展

- 新平台：参考 `src/platforms`
- 新通知渠道：参考 `src/channels`
- 外部插件：通过 `runtime.externalPlugins` 动态挂载

示例见：

- [examples/custom-plugins/slack-webhook.js](examples/custom-plugins/slack-webhook.js)

## 开发与测试

```bash
npm test
```

## 公开仓库说明

出于安全与可复用性考虑，公开仓库中不会包含：

- 任何真实浏览器登录态
- 运行时用户目标状态文件
- 本地日志
- 临时截图与验证产物

如果你打算在自己的环境中直接运行，请先完成对应平台登录，再从页面中添加你自己的监控目标。

## License

[MIT](LICENSE)
