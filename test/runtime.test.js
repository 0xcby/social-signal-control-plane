import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import AiBot from "@wecom/aibot-node-sdk";

import { buildSettingsSnapshot, mergeConfigWithState } from "../src/core/config-service.js";
import { wecomBotChannel } from "../src/channels/wecom-bot.js";
import { wecomSmartBotChannel } from "../src/channels/wecom-smart-bot.js";
import { AuthManager } from "../src/core/auth-manager.js";
import { createLogger } from "../src/core/logger.js";
import { resolvePlatformStorageStatePath } from "../src/core/platform-auth.js";
import { MonitorRuntime } from "../src/core/monitor-runtime.js";
import { PluginRegistry } from "../src/core/plugin-registry.js";
import { RealtimeHub } from "../src/core/realtime-hub.js";
import { RuntimeStateStore } from "../src/core/runtime-state-store.js";
import {
  createDouyinBrowserSourceDriver,
  extractDouyinSecUserId
} from "../src/platforms/source-drivers/douyin-browser-source-driver.js";
import { createSourceDriverFactory } from "../src/platforms/source-drivers/index.js";
import {
  parseWechatMpPublishResponse,
  parseWechatMpSearchResponse
} from "../src/platforms/source-drivers/wechat-mp-browser-source-driver.js";
import { parseWechatSearchResults } from "../src/platforms/source-drivers/wechat-sogou-source-driver.js";
import {
  parseXiaohongshuPostedResponse,
  parseXiaohongshuProfileText
} from "../src/platforms/source-drivers/xiaohongshu-browser-source-driver.js";

function createSilentLogger() {
  const logger = createLogger("test");
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  logger.child = () => logger;
  return logger;
}

test("runtime dispatches a message once and deduplicates on repeat polling", async () => {
  const captured = [];
  const registry = new PluginRegistry({ logger: createSilentLogger() });

  registry.register({
    type: "platform",
    id: "fixture-platform",
    async createWatchers({ platformConfig }) {
      return [
        {
          id: "fixture-platform:user-1",
          target: { userId: "user-1", label: "User 1" },
          intervalMs: 10,
          async poll() {
            return platformConfig.items;
          }
        }
      ];
    }
  });

  registry.register({
    type: "channel",
    id: "capture",
    async createSender() {
      return {
        id: "capture",
        async send(event) {
          captured.push(event);
        }
      };
    }
  });

  const runtime = new MonitorRuntime({
    config: {
      runtime: { latencyBudgetMs: 10, dedupeMaxSize: 100, emitHistoricalOnStart: true },
      platforms: {
        "fixture-platform": {
          enabled: true,
          items: [
            {
              dedupeKey: "fixture-platform:user-1:1",
              platformId: "fixture-platform",
              platformName: "Fixture Platform",
              targetId: "user-1",
              targetLabel: "User 1",
              authorId: "user-1",
              authorName: "User 1",
              externalId: "1",
              title: "Hello",
              content: "World",
              url: "https://example.com/1",
              publishedAt: "2026-03-15T08:00:00.000Z",
              raw: { id: 1 }
            }
          ]
        }
      },
      channels: {
        capture: { enabled: true }
      }
    },
    registry,
    sourceDriverFactory: createSourceDriverFactory(),
    logger: createSilentLogger(),
    shared: {
      cwd: process.cwd(),
      realtimeHub: new RealtimeHub()
    }
  });

  await runtime.initialize();

  const first = await runtime.runOnce();
  const second = await runtime.runOnce();

  assert.equal(first.totalNewMessages, 1);
  assert.equal(second.totalNewMessages, 0);
  assert.equal(captured.length, 1);
});

test("runtime resolves custom channel instances by pluginId instead of random channel id", async () => {
  const captured = [];
  let createdChannelId;
  const registry = new PluginRegistry({ logger: createSilentLogger() });

  registry.register({
    type: "platform",
    id: "fixture-platform",
    async createWatchers({ platformConfig }) {
      return [
        {
          id: "fixture-platform:user-1",
          target: { userId: "user-1", label: "User 1" },
          intervalMs: 10,
          async poll() {
            return platformConfig.items;
          }
        }
      ];
    }
  });

  registry.register({
    type: "channel",
    id: "capture",
    async createSender({ channelId }) {
      createdChannelId = channelId;

      return {
        id: channelId,
        async send(event) {
          captured.push(event);
        }
      };
    }
  });

  const runtime = new MonitorRuntime({
    config: {
      runtime: { latencyBudgetMs: 10, dedupeMaxSize: 100, emitHistoricalOnStart: true },
      platforms: {
        "fixture-platform": {
          enabled: true,
          items: [
            {
              dedupeKey: "fixture-platform:user-1:1",
              platformId: "fixture-platform",
              platformName: "Fixture Platform",
              targetId: "user-1",
              targetLabel: "User 1",
              authorId: "user-1",
              authorName: "User 1",
              externalId: "1",
              title: "Hello",
              content: "World",
              url: "https://example.com/1",
              publishedAt: "2026-03-15T08:00:00.000Z",
              raw: { id: 1 }
            }
          ]
        }
      },
      channels: [
        {
          id: "b575c0a5-ac82-404a-bd1d-0cc2087e460f",
          pluginId: "capture",
          enabled: true
        }
      ]
    },
    registry,
    sourceDriverFactory: createSourceDriverFactory(),
    logger: createSilentLogger(),
    shared: {
      cwd: process.cwd(),
      realtimeHub: new RealtimeHub()
    }
  });

  await runtime.initialize();
  const result = await runtime.runOnce();

  assert.equal(createdChannelId, "b575c0a5-ac82-404a-bd1d-0cc2087e460f");
  assert.equal(result.totalNewMessages, 1);
  assert.equal(captured.length, 1);
});

test("runtime ignores startup historical messages and only dispatches newly discovered items", async () => {
  const captured = [];
  const registry = new PluginRegistry({ logger: createSilentLogger() });
  const platformConfig = {
    enabled: true,
    items: [
      {
        dedupeKey: "fixture-platform:user-1:1",
        platformId: "fixture-platform",
        platformName: "Fixture Platform",
        targetId: "user-1",
        targetLabel: "User 1",
        authorId: "user-1",
        authorName: "User 1",
        externalId: "1",
        title: "Historical",
        content: "Historical content",
        url: "https://example.com/1",
        publishedAt: "2026-03-15T08:00:00.000Z",
        raw: { id: 1 }
      }
    ]
  };

  registry.register({
    type: "platform",
    id: "fixture-platform",
    async createWatchers() {
      return [
        {
          id: "fixture-platform:user-1",
          target: { userId: "user-1", label: "User 1" },
          intervalMs: 10,
          async poll() {
            return platformConfig.items;
          }
        }
      ];
    }
  });

  registry.register({
    type: "channel",
    id: "capture",
    async createSender() {
      return {
        id: "capture",
        async send(event) {
          captured.push(event);
        }
      };
    }
  });

  const runtime = new MonitorRuntime({
    config: {
      runtime: { latencyBudgetMs: 10, dedupeMaxSize: 100 },
      platforms: {
        "fixture-platform": platformConfig
      },
      channels: {
        capture: { enabled: true }
      }
    },
    registry,
    sourceDriverFactory: createSourceDriverFactory(),
    logger: createSilentLogger(),
    shared: {
      cwd: process.cwd(),
      realtimeHub: new RealtimeHub()
    }
  });

  await runtime.initialize();

  const first = await runtime.runOnce();
  platformConfig.items = [
    ...platformConfig.items,
    {
      dedupeKey: "fixture-platform:user-1:2",
      platformId: "fixture-platform",
      platformName: "Fixture Platform",
      targetId: "user-1",
      targetLabel: "User 1",
      authorId: "user-1",
      authorName: "User 1",
      externalId: "2",
      title: "Latest",
      content: "Latest content",
      url: "https://example.com/2",
      publishedAt: "2026-03-15T09:00:00.000Z",
      raw: { id: 2 }
    }
  ];
  const second = await runtime.runOnce();

  assert.equal(first.totalNewMessages, 0);
  assert.equal(second.totalNewMessages, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].message.title, "Latest");
});

test("runtime stop aborts long-running browser polls after a short timeout", async () => {
  let browserClosed = false;
  let channelsClosed = false;

  const runtime = new MonitorRuntime({
    config: {
      runtime: {
        stopTimeoutMs: 20
      },
      platforms: {},
      channels: {}
    },
    registry: new PluginRegistry({ logger: createSilentLogger() }),
    sourceDriverFactory: createSourceDriverFactory(),
    logger: createSilentLogger(),
    shared: {
      cwd: process.cwd(),
      realtimeHub: new RealtimeHub(),
      browserSessionManager: {
        async close() {
          browserClosed = true;
        }
      }
    }
  });
  runtime.channelManager = {
    async close() {
      channelsClosed = true;
    },
    senders: []
  };

  runtime.activeRuns.add(new Promise(() => {}));

  const startedAt = Date.now();
  await runtime.stop();

  assert.equal(browserClosed, true);
  assert.equal(channelsClosed, true);
  assert.ok(Date.now() - startedAt < 250);
});

test("plugin registry loads an external channel plugin module", async () => {
  const registry = new PluginRegistry({ logger: createSilentLogger() });
  await registry.loadExternalModules(["./examples/custom-plugins/slack-webhook.js"], process.cwd());
  assert.ok(registry.getChannel("slack-webhook"));
});

test("wechat parser keeps exact account matches", () => {
  const html = `
    <li id="sogou_vr_11002601_box_0">
      <div class="txt-box">
        <h3><a href="/link?url=abc">天府发布：最新通知</a></h3>
        <p class="txt-info">文章摘要</p>
        <div class="s-p"><span class="all-time-y2">天府发布</span><span class="s2"><script>document.write(timeConvert('1773541727'))</script></span></div>
      </div>
    </li>
    <li id="sogou_vr_11002601_box_1">
      <div class="txt-box">
        <h3><a href="/link?url=def">其他账号提到天府发布</a></h3>
        <p class="txt-info">其他摘要</p>
        <div class="s-p"><span class="all-time-y2">成都发布</span><span class="s2"><script>document.write(timeConvert('1773541000'))</script></span></div>
      </div>
    </li>
  `;
  const items = parseWechatSearchResults(html, { accountName: "天府发布" });

  assert.equal(items.length, 1);
  assert.equal(items[0].authorName, "天府发布");
  assert.match(items[0].url, /weixin\.sogou\.com/);
});

test("wechat mp search parser prefers exact account matches", () => {
  const payload = {
    list: [
      {
        fakeid: "fake-other",
        nickname: "其他账号",
        alias: "other"
      },
      {
        fakeid: "fake-cctv",
        nickname: "央视新闻",
        alias: "cctvxinwen"
      }
    ]
  };
  const items = parseWechatMpSearchResponse(payload, {
    accountName: "央视新闻"
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].fakeId, "fake-cctv");
  assert.equal(items[0].nickname, "央视新闻");
});

test("wechat mp publish parser maps appmsgpublish payload", () => {
  const payload = {
    base_resp: { ret: 0 },
    publish_page: JSON.stringify({
      publish_list: [
        {
          publish_info: JSON.stringify({
            appmsgex: [
              {
                aid: "123_1",
                title: "最新文章",
                digest: "这里是摘要",
                link: "https://mp.weixin.qq.com/s/example",
                cover: "https://example.com/cover.jpg",
                create_time: 1773650000
              }
            ]
          })
        }
      ]
    })
  };
  const items = parseWechatMpPublishResponse(
    payload,
    {
      accountName: "央视新闻",
      label: "央视新闻"
    },
    {
      fakeId: "fake-cctv",
      nickname: "央视新闻",
      alias: "cctvxinwen"
    }
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].authorName, "央视新闻");
  assert.equal(items[0].title, "最新文章");
  assert.equal(items[0].media[0].url, "https://example.com/cover.jpg");
  assert.match(items[0].publishedAt, /^2026-/);
});

test("xiaohongshu parser extracts profile note titles from page text", () => {
  const bodyText = `
    科学探索飞船
    小红书号：8024963348
    关注
    笔记
    收藏
    如果同时引爆所有核武器，会发生什么？
    科学探索飞船
    421
    外星生命的形态，可能跟人类想的完全不一样
    科学探索飞船
    309
    活动
  `;
  const items = parseXiaohongshuProfileText(bodyText, {
    userId: "61accf75000000001000f0ea",
    profileUrl: "https://www.xiaohongshu.com/user/profile/61accf75000000001000f0ea"
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].title, "如果同时引爆所有核武器，会发生什么？");
  assert.equal(items[1].authorName, "科学探索飞船");
});

test("xiaohongshu api parser maps signed user_posted response", () => {
  const payload = {
    data: {
      notes: [
        {
          note_id: "67d123450000000012345678",
          xsec_token: "token-1",
          display_title: "如果同时引爆所有核武器，会发生什么？",
          user: {
            user_id: "61accf75000000001000f0ea",
            nickname: "科学探索飞船"
          },
          note_card: {
            desc: "如果同时引爆所有核武器，会发生什么？",
            time: 1773541727000,
            interact_info: {
              liked_count: "421"
            }
          }
        }
      ]
    }
  };
  const items = parseXiaohongshuPostedResponse(payload, {
    userId: "61accf75000000001000f0ea",
    label: "科学探索飞船"
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].authorName, "科学探索飞船");
  assert.match(items[0].url, /xsec_token=token-1/);
  assert.match(items[0].publishedAt, /^2026-/);
});

test("realtime hub sorts by发布时间倒序并支持平台与用户筛选分页", () => {
  const hub = new RealtimeHub({ maxRecent: 10 });

  hub.setCatalog([
    {
      platformId: "douyin",
      platformName: "抖音",
      targetId: "user-a",
      targetLabel: "用户A"
    },
    {
      platformId: "weibo",
      platformName: "微博",
      targetId: "user-b",
      targetLabel: "用户B"
    }
  ]);

  hub.publish({
    id: "old",
    platformId: "douyin",
    platformName: "抖音",
    target: { id: "user-a", label: "用户A" },
    author: { id: "author-a", name: "作者A" },
    message: {
      title: "旧消息",
      content: "旧消息",
      publishedAt: "2026-03-15T08:00:00.000Z"
    },
    detectedAt: "2026-03-15T08:00:01.000Z"
  });
  hub.publish({
    id: "new",
    platformId: "weibo",
    platformName: "微博",
    target: { id: "user-b", label: "用户B" },
    author: { id: "author-b", name: "作者B" },
    message: {
      title: "新消息",
      content: "新消息",
      publishedAt: "2026-03-15T09:00:00.000Z"
    },
    detectedAt: "2026-03-15T09:00:01.000Z"
  });

  const recent = hub.getRecent();
  const filtered = hub.queryRecent({
    platformId: "weibo",
    targetIds: ["user-b"],
    page: 1,
    pageSize: 1
  });
  const catalog = hub.getCatalog();

  assert.equal(recent[0].id, "new");
  assert.equal(recent[1].id, "old");
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].id, "new");
  assert.equal(filtered.total, 1);
  assert.equal(catalog.platforms.length, 2);
  assert.equal(catalog.platforms[1].targets[0].label, "用户B");
});

test("settings snapshot keeps custom targets and dynamic channels", () => {
  const mergedConfig = mergeConfigWithState(
    {
      platforms: {
        douyin: {
          targets: [{ label: "默认抖音号", secUserId: "builtin-sec-user" }]
        },
        weibo: { targets: [] },
        wechat: { targets: [] },
        xiaohongshu: { targets: [] }
      },
      channels: {
        console: { enabled: true }
      }
    },
    {
      customTargets: {
        douyin: [{ label: "自定义抖音号", secUserId: "custom-sec-user" }]
      },
      channels: [
        {
          id: "custom-webhook",
          pluginId: "webhook",
          label: "告警 Webhook",
          url: "https://example.com/hook",
          enabled: true
        }
      ]
    }
  );

  const snapshot = buildSettingsSnapshot(mergedConfig);
  const douyin = snapshot.platforms.find((platform) => platform.id === "douyin");

  assert.equal(douyin.targets.length, 2);
  assert.equal(douyin.requiresLogin, true);
  assert.equal(douyin.targets[0].isCustom, false);
  assert.equal(douyin.targets[1].isCustom, true);
  assert.equal(douyin.targets[1].id, "custom-sec-user");
  assert.ok(snapshot.channels.some((channel) => channel.id === "console" && channel.builtin));
  assert.ok(snapshot.channels.some((channel) => channel.id === "custom-webhook" && !channel.builtin));
});

test("wecom bot channel builds markdown payload from webhook key", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          errcode: 0,
          errmsg: "ok"
        };
      }
    };
  };

  try {
    const sender = await wecomBotChannel.createSender({
      channelConfig: {
        webhookKey: "abc123xyz789",
        messageType: "markdown"
      },
      logger: createSilentLogger()
    });

    await sender.send({
      platformName: "微博",
      target: { label: "人民日报" },
      author: { name: "人民日报" },
      message: {
        title: "最新消息标题",
        content: "这里是最新消息内容",
        url: "https://example.com/post/1",
        publishedAt: "2026-03-17T12:00:00.000Z"
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=abc123xyz789/);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.msgtype, "markdown");
  assert.equal(payload.markdown.content.includes("**\u6807\u9898**\uff1a\u6700\u65b0\u6d88\u606f\u6807\u9898"), true);
  assert.equal(payload.markdown.content.includes("**\u5185\u5bb9**\uff1a\u8fd9\u91cc\u662f\u6700\u65b0\u6d88\u606f\u5185\u5bb9"), true);
  assert.equal(payload.markdown.content.includes("**\u65f6\u95f4**\uff1a\u5317\u4eac\u65f6\u95f4 2026-03-17 20:00:00"), true);
  assert.equal(payload.markdown.content.includes("**\u53d1\u5e03\u6e20\u9053/\u53d1\u5e03\u8005**\uff1a\u5fae\u535a / \u4eba\u6c11\u65e5\u62a5"), true);
  assert.equal(payload.markdown.content.includes("**\u7f51\u5740**\uff1ahttps://example.com/post/1"), true);
});

test("wecom bot channel accepts a full webhook url pasted into the key field", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });

    return {
      ok: true,
      async json() {
        return {
          errcode: 0,
          errmsg: "ok"
        };
      }
    };
  };

  try {
    const sender = await wecomBotChannel.createSender({
      channelConfig: {
        webhookKey: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123xyz789",
        messageType: "text"
      },
      logger: createSilentLogger()
    });

    await sender.send({
      platformName: "微博",
      target: { label: "人民日报" },
      author: { name: "人民日报" },
      message: {
        title: "最新消息标题",
        content: "这里是最新消息内容",
        url: "https://example.com/post/1",
        publishedAt: "2026-03-17T12:00:00.000Z"
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123xyz789"
  );
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.msgtype, "text");
});

test("wecom smart bot channel sends proactive messages to multiple chats and closes cleanly", async () => {
  const originalWSClient = AiBot.WSClient;
  const instances = [];
  const sent = [];
  const discovered = [];

  class FakeWSClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.disconnectCalled = false;
      instances.push(this);
    }

    connect() {
      queueMicrotask(() => {
        this.emit("authenticated");
      });
      return this;
    }

    async sendMessage(chatId, body) {
      sent.push({ chatId, body });
      return {
        chatId,
        body
      };
    }

    disconnect() {
      this.disconnectCalled = true;
    }
  }

  Object.defineProperty(AiBot, "WSClient", {
    configurable: true,
    writable: true,
    value: FakeWSClient
  });

  try {
    const sender = await wecomSmartBotChannel.createSender({
      channelConfig: {
        botId: "bot-12345678",
        secret: "secret-abcdef",
        chatIds: "zhangsan, chat-group-1",
        messageType: "markdown",
        label: "企业微信智能机器人"
      },
      logger: createSilentLogger(),
      shared: {
        runtimeStateStore: {
          async upsertDiscoveredSession(session) {
            discovered.push(session);
          }
        }
      }
    });

    await sender.send({
      platformName: "微博",
      target: { label: "人民日报" },
      author: { name: "人民日报" },
      message: {
        title: "最新消息标题",
        content: "这里是最新消息内容",
        url: "https://example.com/post/1",
        publishedAt: "2026-03-18T09:30:00.000Z"
      }
    });

    instances[0].emit("message", {
      body: {
        msgtype: "text",
        chattype: "single",
        from: { userid: "lisi" },
        create_time: 1773826200
      }
    });
    instances[0].emit("event", {
      body: {
        msgtype: "event",
        chattype: "group",
        chatid: "chat-group-9",
        from: { userid: "wangwu" },
        create_time: 1773826260
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    await sender.close();
  } finally {
    Object.defineProperty(AiBot, "WSClient", {
      configurable: true,
      writable: true,
      value: originalWSClient
    });
  }

  assert.equal(instances.length, 1);
  assert.equal(instances[0].options.botId, "bot-12345678");
  assert.equal(instances[0].options.secret, "secret-abcdef");
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((entry) => entry.chatId),
    ["zhangsan", "chat-group-1"]
  );
  assert.equal(sent[0].body.msgtype, "markdown");
  assert.equal(sent[0].body.markdown.content.includes("**\u6807\u9898**\uff1a\u6700\u65b0\u6d88\u606f\u6807\u9898"), true);
  assert.equal(sent[0].body.markdown.content.includes("**\u5185\u5bb9**\uff1a\u8fd9\u91cc\u662f\u6700\u65b0\u6d88\u606f\u5185\u5bb9"), true);
  assert.equal(sent[0].body.markdown.content.includes("**\u65f6\u95f4**\uff1a\u5317\u4eac\u65f6\u95f4 2026-03-18 17:30:00"), true);
  assert.equal(sent[0].body.markdown.content.includes("**\u53d1\u5e03\u6e20\u9053/\u53d1\u5e03\u8005**\uff1a\u5fae\u535a / \u4eba\u6c11\u65e5\u62a5"), true);
  assert.equal(sent[0].body.markdown.content.includes("**\u7f51\u5740**\uff1ahttps://example.com/post/1"), true);
  assert.equal(discovered.length, 2);
  assert.equal(discovered[0].sessionType, "single");
  assert.equal(discovered[0].sessionId, "lisi");
  assert.equal(discovered[1].sessionType, "group");
  assert.equal(discovered[1].sessionId, "chat-group-9");
  assert.equal(instances[0].disconnectCalled, true);
});

test("realtime hub dashboard exposes management sections and dashboard script", () => {
  const hub = new RealtimeHub();
  const html = hub.renderDashboard("消息聚合控制台");

  assert.match(html, /id="sidebar-nav"/);
  assert.match(html, /id="nav-toggle"/);
  assert.match(html, /id="page-dashboard"/);
  assert.match(html, /id="page-feed"/);
  assert.match(html, /id="dashboard-alerts"/);
  assert.match(html, /id="dashboard-platform-chart"/);
  assert.match(html, /id="auth-grid"/);
  assert.match(html, /id="monitor-form"/);
  assert.match(html, /id="target-cancel"/);
  assert.match(html, /id="managed-targets"/);
  assert.match(html, /id="managed-channels"/);
  assert.match(html, /id="enable-browser-notification"/);
  assert.match(html, /src="\/dashboard\.js"/);
});

test("runtime state store derives custom target ids from semantic fields", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-runtime-state-"));

  try {
    const store = new RuntimeStateStore({ cwd });
    const saved = await store.upsertTarget("weibo", {
      label: "自定义微博",
      uid: "2803301701"
    });
    const updated = await store.upsertTarget(
      "weibo",
      {
        label: "更新后的微博",
        uid: "2803301702"
      },
      {
        previousTargetId: saved.targetId
      }
    );
    const state = await store.getState();

    assert.equal(saved.targetId, "2803301701");
    assert.equal(updated.targetId, "2803301702");
    assert.equal(state.customTargets.weibo.length, 1);
    assert.equal(state.customTargets.weibo[0].targetId, "2803301702");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("runtime state store keeps discovered smart bot sessions sorted by latest first", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-smart-bot-sessions-"));

  try {
    const store = new RuntimeStateStore({ cwd });
    await store.upsertDiscoveredSession({
      pluginId: "wecom-smart-bot",
      channelId: "channel-a",
      channelLabel: "机器人A",
      sessionType: "single",
      sessionId: "zhangsan",
      userId: "zhangsan",
      lastSeenAt: "2026-03-18T10:00:00.000Z"
    });
    await store.upsertDiscoveredSession({
      pluginId: "wecom-smart-bot",
      channelId: "channel-a",
      channelLabel: "机器人A",
      sessionType: "group",
      sessionId: "chat-1",
      chatId: "chat-1",
      lastSeenAt: "2026-03-18T10:05:00.000Z"
    });
    await store.upsertDiscoveredSession({
      pluginId: "wecom-smart-bot",
      channelId: "channel-a",
      channelLabel: "机器人A",
      sessionType: "single",
      sessionId: "zhangsan",
      userId: "zhangsan",
      lastSeenAt: "2026-03-18T10:10:00.000Z"
    });

    const sessions = await store.listDiscoveredSessions("wecom-smart-bot");

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, "zhangsan");
    assert.equal(sessions[0].lastSeenAt, "2026-03-18T10:10:00.000Z");
    assert.equal(sessions[1].sessionId, "chat-1");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("platform auth paths resolve to per-platform storage-state files", () => {
  const cwd = "D:/workspace/news";
  const config = {
    platforms: {
      douyin: {
        source: {
          storageStatePath: "data/browser/custom-douyin.json"
        }
      }
    }
  };

  assert.equal(
    resolvePlatformStorageStatePath("douyin", config, cwd),
    path.resolve(cwd, "data/browser/custom-douyin.json")
  );
  assert.equal(
    resolvePlatformStorageStatePath("weibo", {}, cwd),
    path.resolve(cwd, "data/browser/weibo.storage-state.json")
  );
});

test("auth manager marks fake douyin stored login state as invalid", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-auth-state-"));

  try {
    const douyinStatePath = path.join(cwd, "data/browser/douyin.storage-state.json");
    await fs.mkdir(path.dirname(douyinStatePath), { recursive: true });
    await fs.writeFile(
      douyinStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "sessionid",
            value: "session-token",
            domain: ".douyin.com",
            path: "/",
            expires: -1
          }
        ]
      })
    );

    const manager = new AuthManager({ cwd, logger: createSilentLogger() });
    const statuses = await manager.getStatuses({
      platforms: {
        douyin: {
          source: {
            storageStatePath: "data/browser/douyin.storage-state.json"
          }
        }
      }
    });
    const douyinStatus = statuses.find((entry) => entry.platformId === "douyin");
    const weiboStatus = statuses.find((entry) => entry.platformId === "weibo");

    assert.equal(douyinStatus.requiresLogin, true);
    assert.equal(douyinStatus.status, "\u767b\u5f55\u6001\u5df2\u5931\u6548");
    assert.match(douyinStatus.detail, /douyin\.storage-state\.json|重新登录|校验失败/);
    assert.equal(weiboStatus.requiresLogin, true);
    assert.equal(weiboStatus.status, "\u672a\u767b\u5f55");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("extractDouyinSecUserId reads sec user id from profile url", () => {
  assert.equal(
    extractDouyinSecUserId(
      "https://www.douyin.com/user/MS4wLjABAAAAgq8cb7cn9ByhZbmx-XQDdRTvFzmJeBBXOUO4QflP96M?from_tab_name=main"
    ),
    "MS4wLjABAAAAgq8cb7cn9ByhZbmx-XQDdRTvFzmJeBBXOUO4QflP96M"
  );
  assert.equal(extractDouyinSecUserId("https://www.douyin.com/"), undefined);
});

test("douyin browser driver fetches latest posts via direct api calls", async () => {
  const apiCalls = [];
  const page = {
    currentUrl: "https://www.douyin.com/",
    async goto(url) {
      this.currentUrl = url;
    },
    async waitForTimeout() {},
    url() {
      return this.currentUrl;
    },
    getByRole() {
      return {
        first() {
          return {
            async isVisible() {
              return false;
            }
          };
        }
      };
    },
    async evaluate(_fn, args) {
      if (!args || !args.apiPath) {
        return false;
      }

      apiCalls.push(args.apiPath);

      if (args.apiPath.startsWith("/aweme/v1/web/user/profile/other/")) {
        return {
          ok: true,
          status: 200,
          url: args.apiPath,
          textSnippet: "",
          json: {
            status_code: 0,
            user: {
              uid: "66598046050",
              nickname: "央视新闻"
            }
          }
        };
      }

      if (args.apiPath.startsWith("/aweme/v1/web/aweme/post/")) {
        return {
          ok: true,
          status: 200,
          url: args.apiPath,
          textSnippet: "",
          json: {
            status_code: 0,
            aweme_list: [
              {
                aweme_id: "7617799944119831817",
                desc: "最新抖音内容",
                create_time: 1773657272,
                author: {
                  uid: "66598046050",
                  nickname: "央视新闻"
                },
                video: {
                  dynamic_cover: {
                    url_list: ["https://example.com/cover.jpg"]
                  },
                  play_addr: {
                    url_list: ["https://example.com/video.mp4"]
                  }
                }
              }
            ]
          }
        };
      }

      throw new Error(`Unexpected api path: ${args.apiPath}`);
    }
  };
  const browserContext = {
    async cookies() {
      return [
        {
          name: "sessionid",
          value: "session-token"
        }
      ];
    }
  };
  const driver = createDouyinBrowserSourceDriver({
    driverConfig: {},
    context: {
      cwd: process.cwd(),
      shared: {
        browserSessionManager: {
          async withPage(_options, callback) {
            return callback({ page, context: browserContext });
          }
        }
      }
    }
  });

  const items = await driver.fetchItems({
    target: {
      label: "央视新闻",
      profileUrl:
        "https://www.douyin.com/user/MS4wLjABAAAAgq8cb7cn9ByhZbmx-XQDdRTvFzmJeBBXOUO4QflP96M?from_tab_name=main"
    }
  });

  assert.equal(apiCalls.length, 2);
  assert.match(apiCalls[0], /\/aweme\/v1\/web\/user\/profile\/other\//);
  assert.match(apiCalls[1], /\/aweme\/v1\/web\/aweme\/post\//);
  assert.equal(items.length, 1);
  assert.equal(items[0].authorName, "央视新闻");
  assert.equal(items[0].title, "最新抖音内容");
  assert.equal(items[0].media[0].thumbnailUrl, "https://example.com/cover.jpg");
});

test("auth manager marks expired stored login state as invalid", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-auth-expired-"));

  try {
    const weiboStatePath = path.join(cwd, "data/browser/weibo.storage-state.json");
    await fs.mkdir(path.dirname(weiboStatePath), { recursive: true });
    await fs.writeFile(
      weiboStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "SUB",
            value: "expired-token",
            domain: ".weibo.cn",
            path: "/",
            expires: 1
          }
        ]
      })
    );

    const manager = new AuthManager({ cwd, logger: createSilentLogger() });
    const statuses = await manager.getStatuses({
      platforms: {
        weibo: {
          source: {
            storageStatePath: "data/browser/weibo.storage-state.json"
          }
        }
      }
    });
    const weiboStatus = statuses.find((entry) => entry.platformId === "weibo");

    assert.equal(weiboStatus.requiresLogin, true);
    assert.equal(weiboStatus.status, "\u767b\u5f55\u6001\u5df2\u5931\u6548");
    assert.match(weiboStatus.detail, /weibo\.storage-state\.json/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("auth manager returns external login url after remote login removal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-auth-login-"));

  try {
    const manager = new AuthManager({ cwd, logger: createSilentLogger() });

    const result = await manager.startLogin("douyin", {
      platforms: {
        douyin: {
          source: {
            storageStatePath: "data/browser/douyin.storage-state.json"
          }
        }
      }
    });

    assert.equal(result.started, false);
    assert.equal(result.mode, "external");
    assert.equal(result.loginUrl, "https://creator.douyin.com/");
    assert.match(result.message, /远程登录工作台已移除/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("auth manager creates local agent login task when agent is online", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-auth-agent-"));

  try {
    const manager = new AuthManager({
      cwd,
      logger: createSilentLogger(),
      localAgentToken: "test-token"
    });

    await manager.heartbeatLocalAgent("test-token", {
      hostname: "desktop",
      version: "1.0.0",
      platform: "win32"
    });

    const result = await manager.startLogin("douyin", {
      platforms: {
        douyin: {
          source: {
            storageStatePath: "data/browser/douyin.storage-state.json"
          }
        }
      }
    });

    assert.equal(result.started, true);
    assert.equal(result.mode, "local-agent");
    assert.ok(result.taskId);

    const claim = await manager.claimLocalAgentTask("test-token", { hostname: "desktop" });

    assert.equal(claim.task.platformId, "douyin");
    assert.equal(claim.task.id, result.taskId);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("auth manager writes uploaded storage state from local auth agent", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-auth-agent-state-"));

  try {
    const manager = new AuthManager({
      cwd,
      logger: createSilentLogger(),
      localAgentToken: "test-token"
    });

    await manager.heartbeatLocalAgent("test-token", {
      hostname: "desktop",
      version: "1.0.0",
      platform: "win32"
    });

    const start = await manager.startLogin("weibo", {
      platforms: {
        weibo: {
          source: {
            storageStatePath: "data/browser/weibo.storage-state.json"
          }
        }
      }
    });

    const claim = await manager.claimLocalAgentTask("test-token", { hostname: "desktop" });

    assert.equal(claim.task.id, start.taskId);

    await manager.completeLocalAgentTask("test-token", start.taskId, {
      cookies: [{ name: "SUB", value: "value", domain: ".weibo.com", path: "/" }],
      origins: []
    });

    const filePath = resolvePlatformStorageStatePath(
      "weibo",
      {
        platforms: {
          weibo: {
            source: {
              storageStatePath: "data/browser/weibo.storage-state.json"
            }
          }
        }
      },
      cwd
    );
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));

    assert.equal(saved.cookies[0].name, "SUB");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("auth manager releases unclaimed local agent task and allows retry", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "news-hub-auth-agent-retry-"));

  try {
    const manager = new AuthManager({
      cwd,
      logger: createSilentLogger(),
      localAgentToken: "test-token",
      localAgentClaimTimeoutMs: 5
    });

    await manager.heartbeatLocalAgent("test-token", {
      hostname: "desktop",
      version: "1.0.0",
      platform: "win32"
    });

    const first = await manager.startLogin("xiaohongshu", {
      platforms: {
        xiaohongshu: {
          source: {
            storageStatePath: "data/browser/xiaohongshu.storage-state.json"
          }
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await manager.startLogin("xiaohongshu", {
      platforms: {
        xiaohongshu: {
          source: {
            storageStatePath: "data/browser/xiaohongshu.storage-state.json"
          }
        }
      }
    });

    assert.equal(first.started, true);
    assert.equal(second.started, true);
    assert.notEqual(first.taskId, second.taskId);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
