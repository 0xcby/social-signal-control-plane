function clone(value) {
  return structuredClone(value);
}

export const PLATFORM_DEFINITIONS = [
  {
    id: "douyin",
    name: "抖音",
    requiresLogin: true,
    fields: [
      { key: "label", label: "显示名称", placeholder: "例如：人民日报评论" },
      { key: "profileUrl", label: "主页链接", placeholder: "https://www.douyin.com/user/..." },
      { key: "secUserId", label: "secUserId", placeholder: "可选，已知时可直接填写" }
    ]
  },
  {
    id: "weibo",
    name: "微博",
    requiresLogin: true,
    fields: [
      { key: "label", label: "显示名称", placeholder: "例如：人民日报" },
      { key: "profileUrl", label: "主页链接", placeholder: "https://m.weibo.cn/u/..." },
      { key: "uid", label: "UID", placeholder: "例如：2803301701" },
      { key: "screenName", label: "微博名", placeholder: "例如：人民日报" }
    ]
  },
  {
    id: "wechat",
    name: "微信公众号",
    requiresLogin: true,
    fields: [
      { key: "label", label: "显示名称", placeholder: "例如：天府发布" },
      { key: "accountName", label: "公众号名称", placeholder: "例如：天府发布" },
      { key: "fakeId", label: "fakeId", placeholder: "可选，已知时可直接填写" },
      { key: "keyword", label: "搜索关键词", placeholder: "不填时默认使用公众号名称" }
    ]
  },
  {
    id: "xiaohongshu",
    name: "小红书",
    requiresLogin: true,
    fields: [
      { key: "label", label: "显示名称", placeholder: "例如：科学探索飞船" },
      { key: "profileUrl", label: "主页链接", placeholder: "https://www.xiaohongshu.com/user/profile/..." },
      { key: "userId", label: "用户 ID", placeholder: "例如：61accf75000000001000f0ea" }
    ]
  }
];

function resolveTargetId(target) {
  return (
    target.targetId ??
    target.userId ??
    target.uid ??
    target.secUserId ??
    target.fakeId ??
    target.accountName ??
    target.screenName ??
    target.profileUrl ??
    target.keyword
  );
}

function resolveTargetLabel(target) {
  return (
    target.label ??
    target.accountName ??
    target.screenName ??
    target.userId ??
    target.uid ??
    target.secUserId ??
    target.fakeId ??
    target.keyword ??
    target.profileUrl
  );
}

function normalizeTarget(target, isCustom = false) {
  return {
    ...target,
    targetId: resolveTargetId(target),
    label: resolveTargetLabel(target),
    isCustom
  };
}

export function normalizeChannelDefinitions(channelsConfig = {}) {
  if (Array.isArray(channelsConfig)) {
    return channelsConfig.map((channel) => ({
      ...channel,
      id: channel.id ?? channel.pluginId,
      pluginId: channel.pluginId ?? channel.id
    }));
  }

  return Object.entries(channelsConfig).map(([channelId, channelConfig]) => ({
    id: channelId,
    pluginId: channelConfig?.pluginId ?? channelId,
    ...channelConfig
  }));
}

function mergeChannelDefinitions(baseChannels, stateChannels = []) {
  const merged = new Map(
    baseChannels.map((channel) => [
      channel.id,
      {
        ...channel,
        builtin: true
      }
    ])
  );

  for (const channel of stateChannels) {
    const existing = merged.get(channel.id);

    merged.set(channel.id, {
      ...(existing ?? {}),
      ...channel,
      builtin: existing?.builtin ?? false,
      pluginId: channel.pluginId ?? existing?.pluginId ?? channel.id
    });
  }

  return [...merged.values()];
}

function maskSecret(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  if (text.length <= 8) {
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
  }

  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function extractWecomWebhookKey(channel) {
  const directKey = String(channel.webhookKey ?? "").trim();

  if (directKey) {
    return directKey;
  }

  const webhookUrl = String(channel.webhookUrl ?? channel.url ?? "").trim();

  if (!webhookUrl) {
    return "";
  }

  try {
    return new URL(webhookUrl).searchParams.get("key") ?? "";
  } catch {
    return "";
  }
}

export function mergeConfigWithState(baseConfig, state) {
  const mergedConfig = clone(baseConfig);

  for (const [platformId, platformConfig] of Object.entries(mergedConfig.platforms ?? {})) {
    const builtinTargets = (platformConfig.targets ?? []).map((target) => normalizeTarget(target, false));
    const customTargets = (state.customTargets?.[platformId] ?? []).map((target) =>
      normalizeTarget(target, true)
    );

    mergedConfig.platforms[platformId] = {
      ...platformConfig,
      targets: [...builtinTargets, ...customTargets]
    };
  }

  mergedConfig.channels = mergeChannelDefinitions(
    normalizeChannelDefinitions(baseConfig.channels ?? {}),
    state.channels ?? []
  );

  return mergedConfig;
}

function summarizeChannel(channel) {
  if (channel.pluginId === "telegram") {
    return channel.chatId ? `Chat ID：${channel.chatId}` : "待填写 Bot Token / Chat ID";
  }

  if (channel.pluginId === "wecom-bot") {
    const webhookKey = extractWecomWebhookKey(channel);
    return webhookKey ? `企业微信机器人：Key ${maskSecret(webhookKey)}` : "待填写机器人 Key / Webhook URL";
  }

  if (channel.pluginId === "webhook") {
    return channel.url ? `Webhook：${channel.url}` : "待填写 Webhook 地址";
  }

  if (channel.pluginId === "browser-sse") {
    return "浏览器页面实时接收";
  }

  if (channel.pluginId === "console") {
    return "服务端控制台输出";
  }

  return channel.label ?? channel.id;
}

export function buildSettingsSnapshot(config) {
  const platforms = PLATFORM_DEFINITIONS.map((definition) => {
    const platformConfig = config.platforms?.[definition.id] ?? {};

    return {
      id: definition.id,
      name: definition.name,
      requiresLogin: definition.requiresLogin,
      fields: definition.fields,
      targets: (platformConfig.targets ?? []).map((target) => ({
        id: target.targetId ?? resolveTargetId(target),
        label: target.label ?? resolveTargetLabel(target),
        isCustom: Boolean(target.isCustom),
        raw: target
      }))
    };
  });

  const channels = normalizeChannelDefinitions(config.channels ?? []).map((channel) => ({
    id: channel.id,
    pluginId: channel.pluginId,
    label: channel.label ?? channel.id,
    enabled: channel.enabled !== false,
    builtin: Boolean(channel.builtin),
    summary: summarizeChannel(channel),
    config: channel
  }));

  return {
    platforms,
    channels
  };
}
