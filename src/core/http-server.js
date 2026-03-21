import fs from "node:fs/promises";
import http from "node:http";

const DASHBOARD_CLIENT_PATH = new URL("./dashboard-client.js", import.meta.url);

function parsePositiveInteger(input, fallback) {
  const parsed = Number.parseInt(input ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseTargetIds(searchParams) {
  const targetIds = searchParams
    .get("targetIds")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return targetIds?.length ? targetIds : undefined;
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload, contentType, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(payload);
}

export function createHttpServer({ config, shared, logger, appContext }) {
  const serverConfig = {
    enabled: true,
    host: "127.0.0.1",
    port: 3030,
    title: "消息聚合控制台",
    ...config
  };

  if (!serverConfig.enabled) {
    return {
      async start() {},
      async stop() {}
    };
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const dashboardRoutes = new Set([
      "/",
      "/dashboard",
      "/feed",
      "/targets",
      "/auth",
      "/channels",
      "/notifications"
    ]);

    try {
      if (url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          clients: shared.realtimeHub.clients.size,
          recentMessages: shared.realtimeHub.getRecent().length
        });
        return;
      }

      if (url.pathname === "/messages") {
        sendJson(
          response,
          200,
          shared.realtimeHub.queryRecent({
            platformId: url.searchParams.get("platformId") ?? undefined,
            targetIds: parseTargetIds(url.searchParams),
            page: parsePositiveInteger(url.searchParams.get("page"), 1),
            pageSize: parsePositiveInteger(url.searchParams.get("pageSize"), serverConfig.maxRecent)
          })
        );
        return;
      }

      if (url.pathname === "/catalog") {
        sendJson(response, 200, shared.realtimeHub.getCatalog());
        return;
      }

      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/settings") {
        sendJson(response, 200, {
          ...appContext.getSettingsSnapshot(),
          authStatuses: await appContext.getAuthStatuses(),
          localAuthAgent: appContext.getLocalAuthAgentStatus(),
          discoveredSessions: await appContext.getDiscoveredSessions()
        });
        return;
      }

      if (url.pathname === "/api/wecom-smart-bot/sessions") {
        sendJson(response, 200, {
          items: await appContext.getDiscoveredSessions()
        });
        return;
      }

      if (url.pathname === "/auth/status") {
        sendJson(response, 200, {
          authStatuses: await appContext.getAuthStatuses(),
          localAuthAgent: appContext.getLocalAuthAgentStatus()
        });
        return;
      }

      if (url.pathname === "/auth/login" && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(response, 200, await appContext.startPlatformLogin(payload.platformId));
        return;
      }

      if (url.pathname === "/api/local-auth-agent/heartbeat" && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(
          response,
          200,
          await appContext.heartbeatLocalAuthAgent(payload.token, payload.agent ?? {})
        );
        return;
      }

      if (url.pathname === "/api/local-auth-agent/claim" && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(
          response,
          200,
          await appContext.claimLocalAuthAgentTask(payload.token, payload.agent ?? {})
        );
        return;
      }

      const localAuthTaskCompleteMatch = url.pathname.match(/^\/api\/local-auth-agent\/tasks\/([^/]+)\/complete$/);
      if (localAuthTaskCompleteMatch && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(
          response,
          200,
          await appContext.completeLocalAuthAgentTask(
            payload.token,
            localAuthTaskCompleteMatch[1],
            payload.storageState
          )
        );
        return;
      }

      const localAuthTaskFailMatch = url.pathname.match(/^\/api\/local-auth-agent\/tasks\/([^/]+)\/fail$/);
      if (localAuthTaskFailMatch && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(
          response,
          200,
          await appContext.failLocalAuthAgentTask(
            payload.token,
            localAuthTaskFailMatch[1],
            payload.error
          )
        );
        return;
      }

      if (url.pathname === "/api/targets" && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(response, 200, {
          ok: true,
          settings: await appContext.addTarget(payload.platformId, payload.target ?? {}, {
            previousTargetId: payload.previousTargetId
          })
        });
        return;
      }

      if (url.pathname === "/api/targets" && request.method === "DELETE") {
        sendJson(response, 200, {
          ok: true,
          settings: await appContext.removeTarget(
            url.searchParams.get("platformId"),
            url.searchParams.get("targetId")
          )
        });
        return;
      }

      if (url.pathname === "/api/channels" && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(response, 200, {
          ok: true,
          settings: await appContext.upsertChannel(payload.channel ?? {})
        });
        return;
      }

      if (url.pathname === "/api/channels" && request.method === "DELETE") {
        sendJson(response, 200, {
          ok: true,
          settings: await appContext.removeChannel(url.searchParams.get("channelId"))
        });
        return;
      }

      if (url.pathname === "/dashboard.js") {
        const source = await fs.readFile(DASHBOARD_CLIENT_PATH, "utf8");
        sendText(response, 200, source, "application/javascript");
        return;
      }

      if (url.pathname === "/events") {
        shared.realtimeHub.attachServerSentEvents(request, response);
        return;
      }

      if (dashboardRoutes.has(url.pathname)) {
        sendText(response, 200, shared.realtimeHub.renderDashboard(serverConfig.title), "text/html");
        return;
      }

      sendJson(response, 404, { ok: false, message: "未找到资源" });
    } catch (error) {
      logger.error("HTTP 请求处理失败", {
        path: url.pathname,
        method: request.method,
        error: error?.message ?? String(error)
      });
      sendJson(response, 400, {
        ok: false,
        message: error?.message ?? String(error)
      });
    }
  });

  return {
    async start() {
      await new Promise((resolve) => {
        server.listen(serverConfig.port, serverConfig.host, resolve);
      });

      logger.info("控制台服务已启动", { host: serverConfig.host, port: serverConfig.port });
    },
    async stop() {
      if (!server.listening) {
        return;
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}
