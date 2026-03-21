import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright-core";

import { DEFAULT_USER_AGENT, resolveExecutablePath } from "./browser-session-manager.js";
import { PLATFORM_DEFINITIONS } from "./config-service.js";
import {
  fileExists,
  getPlatformAuthDescriptor,
  inspectStoredLoginState,
  resolvePlatformStorageStatePath
} from "./platform-auth.js";

const LOGIN_VALIDATION_TTL_MS = 2 * 60 * 1000;
const VALIDATION_TIMEOUT_MS = 60 * 1000;
const VALIDATION_VIEWPORT = { width: 1440, height: 1024 };
const LOCAL_AGENT_HEARTBEAT_TTL_MS = 30 * 1000;
const LOCAL_AGENT_CLAIM_TIMEOUT_MS = 20 * 1000;
const LOCAL_AGENT_TASK_TIMEOUT_MS = 15 * 60 * 1000;

function defaultBrowserArgs() {
  const args = ["--disable-blink-features=AutomationControlled"];

  if (process.platform !== "win32") {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  return args;
}

function safeJsonParse(input, fallback) {
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

function normalizeStorageStatePayload(payload) {
  if (typeof payload === "string") {
    return safeJsonParse(payload, undefined);
  }

  if (payload && typeof payload === "object") {
    return payload;
  }

  return undefined;
}

function createPlatformStatus(platform, descriptor, storageStatePath, validation, localAgentStatus) {
  const baseDetail = localAgentStatus.enabled
    ? localAgentStatus.online
      ? "本地登录代理在线，点击“开始登录”后会在本机自动打开浏览器。"
      : "本地登录代理未在线，登录任务暂时不会被执行。"
    : "服务器远程登录工作台已移除，请改用本地登录代理或手动同步登录态。";

  if (validation?.status === "invalid") {
    return {
      platformId: platform.id,
      requiresLogin: true,
      status: "登录态已失效",
      loginUrl: descriptor.loginUrl,
      detail: `${validation.detail} ${baseDetail}`.trim()
    };
  }

  if (validation?.status === "checking") {
    return {
      platformId: platform.id,
      requiresLogin: true,
      status: "登录态校验中",
      loginUrl: descriptor.loginUrl,
      detail: validation.detail
    };
  }

  if (validation?.status === "valid") {
    return {
      platformId: platform.id,
      requiresLogin: true,
      status: "已保存登录态",
      loginUrl: descriptor.loginUrl,
      detail: validation.detail ?? `登录态文件：${storageStatePath}`
    };
  }

  return {
    platformId: platform.id,
    requiresLogin: true,
    status: "未登录",
    loginUrl: descriptor.loginUrl,
    detail: `${platform.name} 当前未保存登录态。${baseDetail}`.trim()
  };
}

function describeInvalidStorageState(storageStatePath, inspection) {
  if (inspection.reason === "parse-error") {
    return `登录态文件无法解析：${storageStatePath}。请重新登录。`;
  }

  const reasons = [];

  if (inspection.missingNames?.length) {
    reasons.push(`缺少关键 Cookie：${inspection.missingNames.join(", ")}`);
  }

  if (inspection.expiredNames?.length) {
    reasons.push(`Cookie 已过期：${inspection.expiredNames.join(", ")}`);
  }

  if (reasons.length === 0) {
    reasons.push("关键 Cookie 不可用");
  }

  return `登录态文件已失效：${storageStatePath}。${reasons.join("；")}。请重新登录。`;
}

function isTaskTerminal(task) {
  return task.status === "completed" || task.status === "failed";
}

export class AuthManager {
  constructor({
    cwd = process.cwd(),
    logger,
    validationTtlMs = LOGIN_VALIDATION_TTL_MS,
    localAgentToken = process.env.NEWS_LOCAL_AUTH_TOKEN ?? "",
    localAgentHeartbeatTtlMs = LOCAL_AGENT_HEARTBEAT_TTL_MS,
    localAgentClaimTimeoutMs = LOCAL_AGENT_CLAIM_TIMEOUT_MS,
    localAgentTaskTimeoutMs = LOCAL_AGENT_TASK_TIMEOUT_MS
  }) {
    this.cwd = cwd;
    this.logger = logger;
    this.validationTtlMs = validationTtlMs;
    this.validationCache = new Map();
    this.validationPromises = new Map();
    this.localAgentToken = String(localAgentToken ?? "").trim();
    this.localAgentHeartbeatTtlMs = localAgentHeartbeatTtlMs;
    this.localAgentClaimTimeoutMs = localAgentClaimTimeoutMs;
    this.localAgentTaskTimeoutMs = localAgentTaskTimeoutMs;
    this.localAgentState = {
      connectedAt: undefined,
      lastSeenAt: undefined,
      hostname: undefined,
      version: undefined,
      platform: undefined
    };
    this.localAgentTasks = new Map();
  }

  _getCacheKey(platformId, storageStatePath) {
    return `${platformId}:${storageStatePath}`;
  }

  _setValidation(platformId, storageStatePath, validation) {
    this.validationCache.set(this._getCacheKey(platformId, storageStatePath), validation);
    return validation;
  }

  _clearValidation(platformId, storageStatePath) {
    const cacheKey = this._getCacheKey(platformId, storageStatePath);
    this.validationCache.delete(cacheKey);
    this.validationPromises.delete(cacheKey);
  }

  _assertAgentToken(token) {
    if (!this.localAgentToken) {
      throw new Error("本地登录代理未启用。请先在服务器环境变量中配置 NEWS_LOCAL_AUTH_TOKEN。");
    }

    if (String(token ?? "").trim() !== this.localAgentToken) {
      throw new Error("本地登录代理鉴权失败。");
    }
  }

  _isLocalAgentOnline() {
    if (!this.localAgentToken) {
      return false;
    }

    const lastSeenAt = this.localAgentState.lastSeenAt
      ? Date.parse(this.localAgentState.lastSeenAt)
      : Number.NaN;

    return Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt <= this.localAgentHeartbeatTtlMs;
  }

  getLocalAgentStatus() {
    return {
      enabled: Boolean(this.localAgentToken),
      online: this._isLocalAgentOnline(),
      connectedAt: this.localAgentState.connectedAt,
      lastSeenAt: this.localAgentState.lastSeenAt,
      hostname: this.localAgentState.hostname,
      version: this.localAgentState.version,
      platform: this.localAgentState.platform,
      pendingTasks: [...this.localAgentTasks.values()].filter((task) => !isTaskTerminal(task)).length
    };
  }

  _expireStaleTasks() {
    const now = Date.now();

    for (const task of this.localAgentTasks.values()) {
      if (isTaskTerminal(task)) {
        continue;
      }

      const updatedAt = Date.parse(task.updatedAt ?? task.createdAt ?? "");

      if (task.status === "pending" && Number.isFinite(updatedAt) && now - updatedAt > this.localAgentClaimTimeoutMs) {
        task.status = "failed";
        task.updatedAt = new Date().toISOString();
        task.error = "本地登录代理未及时领取任务，任务已自动释放。";
        continue;
      }

      if (Number.isFinite(updatedAt) && now - updatedAt > this.localAgentTaskTimeoutMs) {
        task.status = "failed";
        task.updatedAt = new Date().toISOString();
        task.error = "本地登录代理任务超时。";
      }
    }
  }

  _findActiveTaskByPlatform(platformId) {
    for (const task of this.localAgentTasks.values()) {
      if (task.platformId === platformId && !isTaskTerminal(task)) {
        return task;
      }
    }

    return undefined;
  }

  async _validateStoredLogin(platformId, descriptor, storageStatePath) {
    const executablePath = await resolveExecutablePath(process.env.NEWS_BROWSER_EXECUTABLE_PATH);
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: defaultBrowserArgs()
    });
    const context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      userAgent: DEFAULT_USER_AGENT,
      viewport: VALIDATION_VIEWPORT,
      storageState: storageStatePath
    });
    const page = await context.newPage();

    try {
      await page.goto(descriptor.loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: VALIDATION_TIMEOUT_MS
      });

      if (descriptor.prepare) {
        await descriptor.prepare({ page, context, timeoutMs: VALIDATION_TIMEOUT_MS });
      }

      const loggedIn = await descriptor.isLoggedIn({ page, context });

      if (!loggedIn) {
        return this._setValidation(platformId, storageStatePath, {
          status: "invalid",
          checkedAt: Date.now(),
          detail: `登录态文件已失效：${storageStatePath}。请重新登录。`
        });
      }

      return this._setValidation(platformId, storageStatePath, {
        status: "valid",
        checkedAt: Date.now(),
        detail: `登录态文件：${storageStatePath}`
      });
    } catch (error) {
      this.logger.warn("登录态校验失败", {
        platformId,
        error: error?.message ?? String(error)
      });

      return this._setValidation(platformId, storageStatePath, {
        status: "invalid",
        checkedAt: Date.now(),
        detail: `登录态校验失败：${error?.message ?? String(error)}`
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }

  async _getStoredLoginValidation(platformId, descriptor, storageStatePath) {
    const inspection = await inspectStoredLoginState(
      storageStatePath,
      descriptor.cookieNamesForStoredState ?? []
    );

    if (!inspection.exists) {
      this._clearValidation(platformId, storageStatePath);
      return undefined;
    }

    if (!inspection.valid) {
      return this._setValidation(platformId, storageStatePath, {
        status: "invalid",
        checkedAt: Date.now(),
        detail: describeInvalidStorageState(storageStatePath, inspection)
      });
    }

    if (!descriptor.activeValidation) {
      return this._setValidation(platformId, storageStatePath, {
        status: "valid",
        checkedAt: Date.now(),
        detail: `登录态文件：${storageStatePath}`
      });
    }

    const cacheKey = this._getCacheKey(platformId, storageStatePath);
    const cached = this.validationCache.get(cacheKey);
    const cacheAge = cached ? Date.now() - cached.checkedAt : Infinity;

    if (!this.validationPromises.has(cacheKey) && cacheAge > this.validationTtlMs) {
      const validationPromise = this._validateStoredLogin(platformId, descriptor, storageStatePath)
        .catch((error) => {
          this.logger.warn("后台登录态校验失败", {
            platformId,
            error: error?.message ?? String(error)
          });

          return this._setValidation(platformId, storageStatePath, {
            status: "invalid",
            checkedAt: Date.now(),
            detail: `登录态校验失败：${error?.message ?? String(error)}`
          });
        })
        .finally(() => {
          this.validationPromises.delete(cacheKey);
        });

      this.validationPromises.set(cacheKey, validationPromise);
    }

    if (cached) {
      return cached;
    }

    if (descriptor.eagerValidation) {
      return this.validationPromises.get(cacheKey);
    }

    return {
      status: "checking",
      checkedAt: Date.now(),
      detail: `已发现登录态文件：${storageStatePath}，正在后台校验可用性。`
    };
  }

  async getStatuses(config) {
    this._expireStaleTasks();
    const localAgentStatus = this.getLocalAgentStatus();
    const statuses = [];

    for (const platform of PLATFORM_DEFINITIONS) {
      const descriptor = getPlatformAuthDescriptor(platform.id);

      if (!platform.requiresLogin || !descriptor) {
        statuses.push({
          platformId: platform.id,
          requiresLogin: false,
          status: "无需登录",
          loginUrl: undefined,
          detail: `${platform.name} 当前无需额外登录态。`
        });
        continue;
      }

      const storageStatePath = resolvePlatformStorageStatePath(platform.id, config, this.cwd);
      const exists = await fileExists(storageStatePath);
      const validation = exists
        ? await this._getStoredLoginValidation(platform.id, descriptor, storageStatePath)
        : undefined;

      statuses.push(
        createPlatformStatus(
          platform,
          descriptor,
          storageStatePath,
          validation,
          localAgentStatus
        )
      );
    }

    return statuses;
  }

  async startLogin(platformId, config) {
    const descriptor = getPlatformAuthDescriptor(platformId);

    if (!descriptor) {
      throw new Error(`暂不支持 ${platformId} 的登录入口。`);
    }

    if (!this.localAgentToken) {
      return {
        started: false,
        mode: "external",
        loginUrl: descriptor.loginUrl,
        message: "服务器远程登录工作台已移除。请在本地浏览器完成登录，再同步登录态到服务器。"
      };
    }

    if (!this._isLocalAgentOnline()) {
      return {
        started: false,
        mode: "local-agent",
        loginUrl: descriptor.loginUrl,
        message: "本地登录代理未在线。请先在本机启动 local auth agent，再重新发起登录。"
      };
    }

    this._expireStaleTasks();
    const existingTask = this._findActiveTaskByPlatform(platformId);

    if (existingTask) {
      return {
        started: false,
        mode: "local-agent",
        taskId: existingTask.id,
        message:
          existingTask.status === "pending"
            ? `${platformId} 已有待领取的本地登录任务。请确认本地登录代理正在运行；如果 20 秒内仍未弹出浏览器，可再次点击重新创建任务。`
            : `${platformId} 已有进行中的本地登录任务，请先完成当前任务。`
      };
    }

    const storageStatePath = resolvePlatformStorageStatePath(platformId, config, this.cwd);
    const task = {
      id: randomUUID(),
      platformId,
      loginUrl: descriptor.loginUrl,
      storageStatePath,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.localAgentTasks.set(task.id, task);
    this._clearValidation(platformId, storageStatePath);

    return {
      started: true,
      mode: "local-agent",
      taskId: task.id,
      message: "已创建本地登录任务。本地登录代理会在你的电脑上自动打开浏览器。"
    };
  }

  async heartbeatLocalAgent(token, payload = {}) {
    this._assertAgentToken(token);
    const now = new Date().toISOString();

    if (!this.localAgentState.connectedAt) {
      this.localAgentState.connectedAt = now;
    }

    this.localAgentState.lastSeenAt = now;
    this.localAgentState.hostname = String(payload.hostname ?? "").trim() || this.localAgentState.hostname;
    this.localAgentState.version = String(payload.version ?? "").trim() || this.localAgentState.version;
    this.localAgentState.platform = String(payload.platform ?? "").trim() || this.localAgentState.platform;

    return this.getLocalAgentStatus();
  }

  async claimLocalAgentTask(token, payload = {}) {
    this._assertAgentToken(token);
    await this.heartbeatLocalAgent(token, payload);
    this._expireStaleTasks();

    const nextTask = [...this.localAgentTasks.values()]
      .filter((task) => task.status === "pending")
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];

    if (!nextTask) {
      return { task: null };
    }

    nextTask.status = "running";
    nextTask.updatedAt = new Date().toISOString();
    nextTask.agent = {
      hostname: this.localAgentState.hostname,
      version: this.localAgentState.version,
      platform: this.localAgentState.platform
    };

    return {
      task: {
        id: nextTask.id,
        platformId: nextTask.platformId,
        loginUrl: nextTask.loginUrl
      }
    };
  }

  async completeLocalAgentTask(token, taskId, storageStatePayload) {
    this._assertAgentToken(token);
    const task = this.localAgentTasks.get(taskId);

    if (!task) {
      throw new Error("本地登录任务不存在。");
    }

    const storageState = normalizeStorageStatePayload(storageStatePayload);

    if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) {
      throw new Error("上传的登录态格式无效。");
    }

    await fs.mkdir(path.dirname(task.storageStatePath), { recursive: true });
    await fs.writeFile(task.storageStatePath, JSON.stringify(storageState, null, 2), "utf8");

    task.status = "completed";
    task.updatedAt = new Date().toISOString();
    delete task.error;

    this._clearValidation(task.platformId, task.storageStatePath);

    return {
      ok: true,
      taskId,
      platformId: task.platformId,
      storageStatePath: task.storageStatePath
    };
  }

  async failLocalAgentTask(token, taskId, error) {
    this._assertAgentToken(token);
    const task = this.localAgentTasks.get(taskId);

    if (!task) {
      throw new Error("本地登录任务不存在。");
    }

    task.status = "failed";
    task.updatedAt = new Date().toISOString();
    task.error = String(error ?? "").trim() || "本地登录代理执行失败。";

    return {
      ok: true,
      taskId,
      platformId: task.platformId
    };
  }
}
