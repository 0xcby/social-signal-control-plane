function normalizeText(text) {
  return String(text ?? "").replaceAll("\r\n", "\n").trim();
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function resolveWebhookUrl(channelConfig = {}) {
  if (channelConfig.webhookUrl) {
    return String(channelConfig.webhookUrl).trim();
  }

  if (channelConfig.url) {
    return String(channelConfig.url).trim();
  }

  if (channelConfig.webhookKey) {
    return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(String(channelConfig.webhookKey).trim())}`;
  }

  return "";
}

function resolveMessageType(channelConfig = {}) {
  const type = String(channelConfig.messageType ?? "markdown").trim().toLowerCase();
  return type === "text" ? "text" : "markdown";
}

function formatMarkdownMessage(event) {
  const headline = normalizeText(event.message?.title || event.message?.content || "检测到新消息");
  const summary = normalizeText(
    event.message?.content && event.message?.content !== event.message?.title
      ? event.message.content
      : ""
  );
  const sections = [
    `## ${event.platformName} / ${event.target.label}`,
    `> 作者：${event.author.name}`,
    `> 发布时间：${event.message?.publishedAt ?? "-"}`,
    headline
  ];

  if (summary) {
    sections.push(summary);
  }

  if (event.message?.url) {
    sections.push(`[打开原文](${event.message.url})`);
  }

  return sections.join("\n");
}

function formatTextMessage(event) {
  const headline = normalizeText(event.message?.title || event.message?.content || "检测到新消息");
  const summary = normalizeText(
    event.message?.content && event.message?.content !== event.message?.title
      ? event.message.content
      : ""
  );

  return [
    `${event.platformName} / ${event.target.label}`,
    `作者：${event.author.name}`,
    `发布时间：${event.message?.publishedAt ?? "-"}`,
    headline,
    summary,
    event.message?.url ? `原文：${event.message.url}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPayload(event, channelConfig) {
  const messageType = resolveMessageType(channelConfig);

  if (messageType === "text") {
    return {
      msgtype: "text",
      text: {
        content: formatTextMessage(event),
        mentioned_list: normalizeList(channelConfig.mentionedList),
        mentioned_mobile_list: normalizeList(channelConfig.mentionedMobileList)
      }
    };
  }

  return {
    msgtype: "markdown",
    markdown: {
      content: formatMarkdownMessage(event)
    }
  };
}

export const wecomBotChannel = {
  type: "channel",
  id: "wecom-bot",
  displayName: "企业微信机器人",
  async createSender({ channelId = "wecom-bot", channelConfig, logger }) {
    const webhookUrl = resolveWebhookUrl(channelConfig);

    if (!webhookUrl) {
      logger.warn("企业微信机器人渠道未启用，缺少 webhookKey 或 webhookUrl");

      return {
        id: channelId,
        async send() {}
      };
    }

    return {
      id: channelId,
      async send(event) {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(buildPayload(event, channelConfig))
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(`企业微信机器人推送失败，状态码 ${response.status}`);
        }

        if (payload?.errcode !== undefined && payload.errcode !== 0) {
          throw new Error(`企业微信机器人推送失败：${payload.errmsg ?? payload.errcode}`);
        }
      }
    };
  }
};
