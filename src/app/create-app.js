import { builtinChannelPlugins } from "../channels/index.js";
import { builtinPlatformPlugins } from "../platforms/index.js";
import { BrowserSessionManager } from "../core/browser-session-manager.js";
import { buildSettingsSnapshot, mergeConfigWithState, PLATFORM_DEFINITIONS } from "../core/config-service.js";
import { createHttpServer } from "../core/http-server.js";
import { createLogger } from "../core/logger.js";
import { MonitorRuntime } from "../core/monitor-runtime.js";
import { PluginRegistry } from "../core/plugin-registry.js";
import { RealtimeHub } from "../core/realtime-hub.js";
import { RuntimeStateStore } from "../core/runtime-state-store.js";
import { AuthManager } from "../core/auth-manager.js";
import { createSourceDriverFactory } from "../platforms/source-drivers/index.js";

function sanitizePayload(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
  );
}

function extractWecomWebhookKey(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  try {
    return new URL(text).searchParams.get("key") ?? "";
  } catch {}

  const matched = text.match(/(?:^|[?&])key=([^&]+)/i);

  if (matched?.[1]) {
    try {
      return decodeURIComponent(matched[1]);
    } catch {
      return matched[1];
    }
  }

  return text;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  return String(value ?? "")
    .split(/[\r\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChannelPayload(channel = {}) {
  const normalized = { ...channel };

  if (normalized.pluginId === "wecom-bot") {
    const explicitUrl = String(normalized.webhookUrl ?? normalized.url ?? "").trim();
    const webhookKey = extractWecomWebhookKey(normalized.webhookKey);

    if (webhookKey) {
      normalized.webhookKey = webhookKey;
    }

    if (explicitUrl && !/^https?:\/\//i.test(explicitUrl)) {
      const keyFromUrlField = extractWecomWebhookKey(explicitUrl);

      if (keyFromUrlField) {
        normalized.webhookKey = normalized.webhookKey ?? keyFromUrlField;
        delete normalized.webhookUrl;
        delete normalized.url;
      }
    }

    if (normalized.messageType) {
      normalized.messageType = String(normalized.messageType).trim().toLowerCase();
    }
  }

  if (normalized.pluginId === "wecom-smart-bot") {
    const chatIds = normalizeList(normalized.chatIds ?? normalized.chatId);

    if (chatIds.length > 0) {
      normalized.chatIds = chatIds.join(",");
    }

    delete normalized.chatId;

    if (normalized.messageType) {
      normalized.messageType = String(normalized.messageType).trim().toLowerCase();
    }
  }

  return sanitizePayload(normalized);
}

function assertTargetPayload(platformId, target) {
  if (!platformId) {
    throw new Error("缺少平台标识。");
  }

  if (platformId === "douyin" && !target.profileUrl && !target.secUserId) {
    throw new Error("抖音监控用户至少需要填写主页链接或 secUserId。");
  }

  if (platformId === "weibo" && !target.profileUrl && !target.uid && !target.screenName) {
    throw new Error("微博监控用户至少需要填写主页链接、UID 或微博名。");
  }

  if (platformId === "wechat" && !target.accountName && !target.keyword) {
    throw new Error("微信公众号监控用户至少需要填写公众号名称或搜索关键词。");
  }

  if (platformId === "xiaohongshu" && !target.profileUrl && !target.userId) {
    throw new Error("小红书监控用户至少需要填写主页链接或用户 ID。");
  }
}

function assertChannelPayload(channel) {
  if (!channel.pluginId) {
    throw new Error("缺少通知渠道类型。");
  }

  if (channel.enabled === false) {
    return;
  }

  if (channel.pluginId === "telegram" && (!channel.botToken || !channel.chatId)) {
    throw new Error("Telegram 渠道需要 botToken 和 chatId。");
  }

  if (channel.pluginId === "webhook" && !channel.url) {
    throw new Error("Webhook 渠道需要 url。");
  }

  if (channel.pluginId === "wecom-bot" && !channel.webhookKey && !channel.webhookUrl && !channel.url) {
    throw new Error("企业微信机器人需要 Webhook Key 或完整 Webhook URL，不能只填机器人 ID、企业 ID 或 AgentId。");
  }

  if (
    channel.pluginId === "wecom-bot" &&
    channel.messageType &&
    !["markdown", "text"].includes(String(channel.messageType).trim().toLowerCase())
  ) {
    throw new Error("企业微信机器人消息类型只支持 markdown 或 text。");
  }

  if (
    channel.pluginId === "wecom-smart-bot" &&
    (!channel.botId || !channel.secret || normalizeList(channel.chatIds).length === 0)
  ) {
    throw new Error("企业微信智能机器人需要 botId、secret 和至少一个会话 ID。");
  }

  if (
    channel.pluginId === "wecom-smart-bot" &&
    channel.messageType &&
    !["markdown", "text"].includes(String(channel.messageType).trim().toLowerCase())
  ) {
    throw new Error("企业微信智能机器人消息类型只支持 markdown 或 text。");
  }
}

function createRegistry(logger) {
  const registry = new PluginRegistry({ logger });
  registry.registerMany([...builtinPlatformPlugins, ...builtinChannelPlugins]);
  return registry;
}

export async function createApp(baseConfig, { cwd = process.cwd() } = {}) {
  const logger = createLogger("news-hub");
  const stateStore = new RuntimeStateStore({ cwd });
  const shared = {
    cwd,
    realtimeHub: new RealtimeHub({ maxRecent: baseConfig.server?.maxRecent ?? 100 }),
    browserSessionManager: new BrowserSessionManager({
      logger: logger.child("browser"),
      browserConfig: baseConfig.runtime?.browser ?? {},
      cwd
    }),
    runtimeStateStore: stateStore
  };
  const authManager = new AuthManager({
    cwd,
    logger: logger.child("auth")
  });
  let runtime;
  let activeConfig;
  let serverStarted = false;
  let runtimeStarted = false;

  async function buildRuntime(nextConfig) {
    const registry = createRegistry(logger.child("plugins"));
    const sourceDriverFactory = createSourceDriverFactory(nextConfig.runtime?.sourceDrivers ?? {});
    const nextRuntime = new MonitorRuntime({
      config: nextConfig,
      registry,
      sourceDriverFactory,
      logger,
      shared
    });

    await nextRuntime.initialize();
    shared.realtimeHub.setCatalog(
      nextRuntime.watchers.map((watcher) => ({
        platformId: watcher.platformId,
        platformName: watcher.platformName ?? watcher.platformId,
        targetId: watcher.targetId ?? watcher.target?.targetId ?? watcher.id,
        targetLabel: watcher.targetLabel ?? watcher.target?.label ?? watcher.id
      }))
    );

    return nextRuntime;
  }

  async function reloadRuntime() {
    const state = await stateStore.getState();
    const nextConfig = mergeConfigWithState(baseConfig, state);
    const nextRuntime = await buildRuntime(nextConfig);

    if (runtime) {
      await runtime.stop();
    }

    runtime = nextRuntime;
    activeConfig = nextConfig;

    if (runtimeStarted) {
      runtime.start();
    }
  }

  await reloadRuntime();

  const appContext = {
    getConfig() {
      return activeConfig;
    },
    getSettingsSnapshot() {
      return buildSettingsSnapshot(activeConfig);
    },
    async getAuthStatuses() {
      return authManager.getStatuses(activeConfig);
    },
    getLocalAuthAgentStatus() {
      return authManager.getLocalAgentStatus();
    },
    async getDiscoveredSessions() {
      return stateStore.listDiscoveredSessions("wecom-smart-bot");
    },
    async addTarget(platformId, payload, { previousTargetId } = {}) {
      if (!PLATFORM_DEFINITIONS.some((platform) => platform.id === platformId)) {
        throw new Error(`不支持的平台：${platformId}`);
      }

      const sanitizedTarget = sanitizePayload(payload);
      assertTargetPayload(platformId, sanitizedTarget);
      await stateStore.upsertTarget(platformId, sanitizedTarget, { previousTargetId });
      await reloadRuntime();

      return this.getSettingsSnapshot();
    },
    async removeTarget(platformId, targetId) {
      await stateStore.removeTarget(platformId, targetId);
      await reloadRuntime();
      return this.getSettingsSnapshot();
    },
    async upsertChannel(payload) {
      const channel = normalizeChannelPayload(payload);
      assertChannelPayload(channel);
      await stateStore.upsertChannel(channel);
      await reloadRuntime();
      return this.getSettingsSnapshot();
    },
    async removeChannel(channelId) {
      await stateStore.removeChannel(channelId);
      await reloadRuntime();
      return this.getSettingsSnapshot();
    },
    async startPlatformLogin(platformId) {
      return authManager.startLogin(platformId, activeConfig);
    },
    async heartbeatLocalAuthAgent(token, payload) {
      return authManager.heartbeatLocalAgent(token, payload);
    },
    async claimLocalAuthAgentTask(token, payload) {
      return authManager.claimLocalAgentTask(token, payload);
    },
    async completeLocalAuthAgentTask(token, taskId, storageStatePayload) {
      return authManager.completeLocalAgentTask(token, taskId, storageStatePayload);
    },
    async failLocalAuthAgentTask(token, taskId, error) {
      return authManager.failLocalAgentTask(token, taskId, error);
    }
  };

  const server = createHttpServer({
    config: baseConfig.server,
    shared,
    logger: logger.child("http"),
    appContext
  });

  return {
    get runtime() {
      return runtime;
    },
    get config() {
      return activeConfig;
    },
    async start({ once = false } = {}) {
      if (!once) {
        if (!serverStarted) {
          await server.start();
          serverStarted = true;
        }

        runtimeStarted = true;
        runtime.start();
        logger.info("运行时已启动", {
          watcherCount: runtime.watchers.length,
          channelCount: runtime.channelManager.senders.length
        });
        return {
          watcherCount: runtime.watchers.length,
          channelCount: runtime.channelManager.senders.length
        };
      }

      const summary = await runtime.runOnce();
      logger.info("单次采集完成", summary);
      return summary;
    },
    async stop() {
      runtimeStarted = false;

      if (runtime) {
        await runtime.stop();
      }

      if (serverStarted) {
        await server.stop();
        serverStarted = false;
      }

      await shared.browserSessionManager.close();
    },
    ...appContext
  };
}
