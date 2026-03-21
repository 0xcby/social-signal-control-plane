import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runPlatformLogin } from "./lib/run-platform-login.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const AGENT_VERSION = "1.0.0";

function parseCliArgs(argv) {
  const parsed = {
    server: process.env.NEWS_LOCAL_AUTH_SERVER ?? "",
    token: process.env.NEWS_LOCAL_AUTH_TOKEN ?? "",
    pollIntervalMs: Number.parseInt(
      process.env.NEWS_LOCAL_AUTH_POLL_INTERVAL_MS ?? `${DEFAULT_POLL_INTERVAL_MS}`,
      10
    )
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--server") {
      parsed.server = argv[index + 1] ?? parsed.server;
      index += 1;
      continue;
    }

    if (arg === "--token") {
      parsed.token = argv[index + 1] ?? parsed.token;
      index += 1;
      continue;
    }

    if (arg === "--poll-interval") {
      parsed.pollIntervalMs = Number.parseInt(argv[index + 1] ?? `${parsed.pollIntervalMs}`, 10);
      index += 1;
    }
  }

  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, pathname, payload) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result?.ok === false) {
    throw new Error(result?.message || `请求失败：${response.status}`);
  }

  return result;
}

const { server, token, pollIntervalMs } = parseCliArgs(process.argv.slice(2));

if (!server) {
  throw new Error("缺少服务器地址。请使用 --server 或 NEWS_LOCAL_AUTH_SERVER。");
}

if (!token) {
  throw new Error("缺少本地登录代理 token。请使用 --token 或 NEWS_LOCAL_AUTH_TOKEN。");
}

const agentInfo = {
  hostname: os.hostname(),
  version: AGENT_VERSION,
  platform: process.platform
};

console.log(`local auth agent 已启动，目标服务器：${server}`);

while (true) {
  try {
    await requestJson(server, "/api/local-auth-agent/heartbeat", {
      token,
      agent: agentInfo
    });

    const claim = await requestJson(server, "/api/local-auth-agent/claim", {
      token,
      agent: agentInfo
    });

    if (!claim.task) {
      await sleep(pollIntervalMs);
      continue;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "news-auth-agent-"));
    const outputPath = path.join(tempDir, `${claim.task.platformId}.storage-state.json`);

    try {
      console.log(`接收到登录任务：${claim.task.platformId}`);
      await runPlatformLogin({
        platformId: claim.task.platformId,
        outputPath,
        cwd: process.cwd(),
        logger: console
      });

      const storageState = JSON.parse(await fs.readFile(outputPath, "utf8"));

      await requestJson(server, `/api/local-auth-agent/tasks/${claim.task.id}/complete`, {
        token,
        storageState
      });

      console.log(`登录任务完成：${claim.task.platformId}`);
    } catch (error) {
      await requestJson(server, `/api/local-auth-agent/tasks/${claim.task.id}/fail`, {
        token,
        error: error?.message ?? String(error)
      }).catch(() => {});
      console.error(`登录任务失败：${claim.task.platformId}`, error?.message ?? String(error));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`local auth agent 轮询失败：${error?.message ?? String(error)}`);
    await sleep(pollIntervalMs);
  }
}
