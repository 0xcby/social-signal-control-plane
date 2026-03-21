import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright-core";

import { DEFAULT_USER_AGENT, resolveExecutablePath } from "../../src/core/browser-session-manager.js";
import {
  getPlatformAuthDescriptor,
  resolvePlatformStorageStatePath
} from "../../src/core/platform-auth.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeLogger(logger = console) {
  return {
    info: (...args) => logger.info?.(...args),
    warn: (...args) => logger.warn?.(...args),
    error: (...args) => logger.error?.(...args)
  };
}

export async function runPlatformLogin({
  platformId,
  outputPath,
  cwd = process.cwd(),
  timeoutMs = LOGIN_TIMEOUT_MS,
  logger = console
}) {
  const descriptor = getPlatformAuthDescriptor(platformId);

  if (!descriptor) {
    throw new Error(`不支持 ${platformId} 的登录流程。`);
  }

  const absoluteOutputPath =
    outputPath ??
    resolvePlatformStorageStatePath(
      platformId,
      {
        platforms: {
          [platformId]: {
            source: {}
          }
        }
      },
      cwd
    );

  const executablePath = await resolveExecutablePath(process.env.NEWS_BROWSER_EXECUTABLE_PATH);
  const browser = await chromium.launch({
    executablePath,
    headless: false
  });
  const context = await browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 1024 }
  });
  const page = await context.newPage();
  const log = normalizeLogger(logger);

  try {
    await page.goto(descriptor.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });

    if (descriptor.prepare) {
      await descriptor.prepare({ page, context, timeoutMs: 120_000 });
    }

    log.info(`浏览器已打开，请在页面中完成 ${platformId} 登录。`);

    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
      try {
        const loggedIn = await descriptor.isLoggedIn({ page, context });

        if (loggedIn) {
          await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
          await context.storageState({ path: absoluteOutputPath });
          log.info(`登录态已保存到：${absoluteOutputPath}`);
          return {
            platformId,
            outputPath: absoluteOutputPath
          };
        }
      } catch (error) {
        lastError = error;
      }

      await page.waitForTimeout(1_500);
    }

    throw new Error(lastError?.message ?? "在限定时间内未检测到有效登录态。");
  } finally {
    await context.close();
    await browser.close();
  }
}
