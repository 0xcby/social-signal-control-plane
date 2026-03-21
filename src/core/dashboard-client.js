const PAGE_DEFINITIONS = [
  { id: "dashboard", path: "/dashboard", icon: "总", label: "情报总览", note: "图表与告警" },
  { id: "feed", path: "/feed", icon: "流", label: "实时消息", note: "分页与消息流" },
  { id: "targets", path: "/targets", icon: "监", label: "监控用户", note: "新增编辑删除" },
  { id: "auth", path: "/auth", icon: "登", label: "平台登录", note: "状态与登录" },
  { id: "channels", path: "/channels", icon: "渠", label: "通知渠道", note: "Webhook / Telegram / 企业微信" },
  { id: "notifications", path: "/notifications", icon: "铃", label: "浏览器通知", note: "系统通知" }
];

const PAGE_META = {
  dashboard: { title: "情报总览", description: "以图表、表格、告警和时间线查看监控系统的整体状态。" },
  feed: { title: "实时消息", description: "按平台分页、监控用户筛选和分页查看实时消息流。" },
  targets: { title: "监控用户", description: "维护每个平台的监控目标，支持新增、编辑和删除。" },
  auth: { title: "平台登录", description: "查看平台登录状态，必要时直接发起登录流程。" },
  channels: { title: "通知渠道", description: "管理 Webhook、Telegram、企业微信机器人等通知渠道。" },
  notifications: { title: "浏览器通知", description: "控制浏览器端系统通知，发现消息后直接弹出提醒。" }
};

const state = {
  currentPage: "dashboard",
  sidebarCollapsed: window.localStorage.getItem("news:sidebarCollapsed") === "true",
  platformId: "all",
  targetIds: [],
  page: 1,
  pageSize: 12,
  messages: [],
  settings: { platforms: [], channels: [] },
  authStatuses: [],
  localAuthAgent: { enabled: false, online: false, pendingTasks: 0 },
  discoveredSessions: [],
  notificationEnabled: window.localStorage.getItem("news:browserNotificationEnabled") === "true",
  editingTarget: undefined,
  editingChannelId: undefined
};

let authStatusPollTimerId;

const elements = {
  appShell: document.getElementById("app-shell"),
  navToggle: document.getElementById("nav-toggle"),
  sidebarNav: document.getElementById("sidebar-nav"),
  pageTitle: document.getElementById("page-title"),
  pageDescription: document.getElementById("page-description"),
  pageSections: Object.fromEntries(PAGE_DEFINITIONS.map((page) => [page.id, document.getElementById(`page-${page.id}`)])),
  platformTabs: document.getElementById("platform-tabs"),
  targetFilters: document.getElementById("target-filters"),
  filterHelp: document.getElementById("filter-help"),
  stream: document.getElementById("stream"),
  pagination: document.getElementById("pagination"),
  resultSummary: document.getElementById("result-summary"),
  clearFilters: document.getElementById("clear-filters"),
  pageSize: document.getElementById("page-size"),
  statPlatforms: document.getElementById("stat-platforms"),
  statTargets: document.getElementById("stat-targets"),
  statMessages: document.getElementById("stat-messages"),
  statResults: document.getElementById("stat-results"),
  dashboardAlerts: document.getElementById("dashboard-alerts"),
  dashboardPlatformChart: document.getElementById("dashboard-platform-chart"),
  dashboardTargetTableBody: document.getElementById("dashboard-target-table-body"),
  dashboardTimeline: document.getElementById("dashboard-timeline"),
  authGrid: document.getElementById("auth-grid"),
  notificationStatus: document.getElementById("browser-notification-status"),
  notificationButton: document.getElementById("enable-browser-notification"),
  monitorPlatform: document.getElementById("monitor-platform"),
  monitorFields: document.getElementById("monitor-fields"),
  monitorForm: document.getElementById("monitor-form"),
  targetSubmitText: document.getElementById("target-submit-text"),
  targetCancel: document.getElementById("target-cancel"),
  managedTargets: document.getElementById("managed-targets"),
  channelType: document.getElementById("channel-type"),
  channelFields: document.getElementById("channel-fields"),
  channelForm: document.getElementById("channel-form"),
  channelSubmitText: document.getElementById("channel-submit-text"),
  channelCancel: document.getElementById("channel-cancel"),
  managedChannels: document.getElementById("managed-channels"),
  discoveredSessions: document.getElementById("discovered-sessions"),
  refreshDiscoveredSessions: document.getElementById("refresh-discovered-sessions"),
  toast: document.getElementById("toast")
};

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareEventsByPublishedAtDesc(left, right) {
  const publishedDelta = toTimestamp(right?.message?.publishedAt) - toTimestamp(left?.message?.publishedAt);
  return publishedDelta !== 0 ? publishedDelta : toTimestamp(right?.detectedAt) - toTimestamp(left?.detectedAt);
}

function formatTime(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) {
    return value || "-";
  }
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(timestamp));
}

function showToast(message, type = "info") {
  elements.toast.textContent = message;
  elements.toast.dataset.type = type;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

function requestJson(url, options = {}) {
  return fetch(url, {
    cache: options.cache ?? "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.message || `请求失败：${response.status}`);
    }
    return payload;
  });
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

function normalizeDelimitedList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .join(",");
  }

  return String(value ?? "")
    .split(/[\r\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(",");
}

function normalizeChannelPayload(payload) {
  const normalized = { ...payload };

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

    if (!normalized.webhookKey && !explicitUrl) {
      throw new Error("企业微信机器人需要 Webhook Key 或完整 Webhook URL，不能只填机器人 ID。");
    }

    if (explicitUrl && !/^https?:\/\//i.test(explicitUrl) && !normalized.webhookKey) {
      throw new Error("Webhook URL 需要填写完整地址；如果你拿到的是 key，请填到“机器人 Webhook Key”。");
    }
  }

  if (normalized.pluginId === "wecom-smart-bot") {
    normalized.chatIds = normalizeDelimitedList(normalized.chatIds ?? normalized.chatId);
    delete normalized.chatId;

    if (!normalized.botId || !normalized.secret || !normalized.chatIds) {
      throw new Error("企业微信智能机器人需要 botId、secret 和至少一个会话 ID。");
    }

    if (normalized.messageType) {
      normalized.messageType = String(normalized.messageType).trim().toLowerCase();
    }
  }

  return normalized;
}

function getPlatformDefinition(platformId) {
  return state.settings.platforms.find((platform) => platform.id === platformId);
}

function getPlatformTarget(platformId, targetId) {
  return getPlatformDefinition(platformId)?.targets.find((target) => target.id === targetId);
}

function getChannelDefinition(channelId) {
  return state.settings.channels.find((channel) => channel.id === channelId);
}

function resolvePageFromPath(pathname) {
  const normalized = pathname === "/" ? "/dashboard" : pathname.replace(/\/+$/, "") || "/dashboard";
  return PAGE_DEFINITIONS.find((page) => page.path === normalized)?.id ?? "dashboard";
}

function getPagePath(pageId) {
  return PAGE_DEFINITIONS.find((page) => page.id === pageId)?.path ?? "/dashboard";
}

function writeUrlState({ push = false } = {}) {
  const params = new URLSearchParams();
  if (state.platformId !== "all") {
    params.set("platform", state.platformId);
  }
  if (state.targetIds.length > 0) {
    params.set("targets", state.targetIds.join(","));
  }
  if (state.page > 1) {
    params.set("page", String(state.page));
  }
  if (state.pageSize !== 12) {
    params.set("pageSize", String(state.pageSize));
  }
  const path = getPagePath(state.currentPage);
  const url = params.toString() ? `${path}?${params}` : path;
  window.history[push ? "pushState" : "replaceState"](null, "", url);
}

function hydrateStateFromUrl() {
  const url = new URL(window.location.href);
  const page = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("pageSize") || "12", 10);
  state.currentPage = resolvePageFromPath(url.pathname);
  state.platformId = url.searchParams.get("platform") || "all";
  state.targetIds = (url.searchParams.get("targets") || "").split(",").map((value) => value.trim()).filter(Boolean);
  state.page = Number.isFinite(page) && page > 0 ? page : 1;
  state.pageSize = [6, 12, 24].includes(pageSize) ? pageSize : 12;
}

function getAvailableTargets() {
  if (state.platformId === "all") {
    return state.settings.platforms.flatMap((platform) =>
      platform.targets.map((target) => ({ ...target, platformId: platform.id, platformName: platform.name }))
    );
  }
  return (getPlatformDefinition(state.platformId)?.targets || []).map((target) => ({
    ...target,
    platformId: state.platformId,
    platformName: getPlatformDefinition(state.platformId)?.name || state.platformId
  }));
}

function syncTargetSelection() {
  const allowed = new Set(getAvailableTargets().map((target) => target.id));
  state.targetIds = state.targetIds.filter((targetId) => allowed.has(targetId));
  if (!getPlatformDefinition(state.platformId) && state.platformId !== "all") {
    state.platformId = "all";
  }
}

function getFilteredMessages() {
  const selectedTargets = new Set(state.targetIds);
  return state.messages.filter((event) => {
    const matchPlatform = state.platformId === "all" || event.platformId === state.platformId;
    const matchTarget = selectedTargets.size === 0 || selectedTargets.has(event.target?.id);
    return matchPlatform && matchTarget;
  });
}

function renderNavigation() {
  elements.appShell.classList.toggle("collapsed", state.sidebarCollapsed);
  elements.sidebarNav.innerHTML = PAGE_DEFINITIONS.map((page) => `
    <a href="${page.path}" class="${state.currentPage === page.id ? "active" : ""}" data-page-link="${page.id}" title="${escapeHtml(page.label)}">
      <span class="nav-icon">${page.icon}</span>
      <span class="nav-copy"><span class="nav-title">${escapeHtml(page.label)}</span><span class="nav-note muted">${escapeHtml(page.note)}</span></span>
    </a>
  `).join("");
  elements.navToggle.textContent = state.sidebarCollapsed ? "展" : "收";
  elements.navToggle.setAttribute("aria-label", state.sidebarCollapsed ? "展开菜单" : "收起菜单");
  elements.navToggle.setAttribute("title", state.sidebarCollapsed ? "展开菜单" : "收起菜单");
}

function setPage(pageId, { push = true } = {}) {
  state.currentPage = pageId;
  writeUrlState({ push });
  render();
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  window.localStorage.setItem("news:sidebarCollapsed", String(state.sidebarCollapsed));
  renderNavigation();
}

function setPlatform(platformId) {
  state.platformId = platformId;
  state.page = 1;
  syncTargetSelection();
  writeUrlState();
  render();
}

function toggleTarget(targetId) {
  state.targetIds = state.targetIds.includes(targetId)
    ? state.targetIds.filter((value) => value !== targetId)
    : [...state.targetIds, targetId];
  state.page = 1;
  writeUrlState();
  render();
}

function clearTargetFilters() {
  state.targetIds = [];
  state.page = 1;
  writeUrlState();
  render();
}

function setPageNumber(page) {
  state.page = page;
  writeUrlState();
  render();
}

function channelTypes() {
  return [
    {
      pluginId: "webhook",
      fields: [
        { key: "label", label: "渠道名称", placeholder: "例如：企业 Webhook" },
        { key: "url", label: "Webhook URL", placeholder: "https://example.com/hook" }
      ]
    },
    {
      pluginId: "telegram",
      fields: [
        { key: "label", label: "渠道名称", placeholder: "例如：Telegram 群通知" },
        { key: "botToken", label: "Bot Token", placeholder: "123456:ABC..." },
        { key: "chatId", label: "Chat ID", placeholder: "例如：-1001234567890" },
        { key: "parseMode", label: "Parse Mode", placeholder: "HTML" }
      ]
    },
    {
      pluginId: "wecom-bot",
      fields: [
        { key: "label", label: "渠道名称", placeholder: "例如：企业微信机器人" },
        { key: "webhookKey", label: "机器人 Webhook Key", placeholder: "只填 key= 后面的字符串，不是机器人 ID" },
        { key: "webhookUrl", label: "Webhook URL", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." },
        { key: "messageType", label: "消息类型", placeholder: "markdown 或 text，默认 markdown" },
        { key: "mentionedMobileList", label: "提醒手机号", placeholder: "可选，逗号分隔，text 模式支持 @all" },
        { key: "mentionedList", label: "提醒成员 UserId", placeholder: "可选，逗号分隔，仅 text 模式生效" }
      ]
    },
    {
      pluginId: "wecom-smart-bot",
      fields: [
        { key: "label", label: "渠道名称", placeholder: "例如：企业微信智能机器人" },
        { key: "botId", label: "BotID", placeholder: "企业微信后台生成的 bot id" },
        { key: "secret", label: "Secret", placeholder: "企业微信后台生成的 secret" },
        { key: "chatIds", label: "会话 ID", placeholder: "单聊填 userid，群聊填 chatid，多个用逗号分隔" },
        { key: "messageType", label: "消息类型", placeholder: "markdown 或 text，默认 markdown" }
      ]
    }
  ];
}

function getChannelTypeLabel(pluginId) {
  if (pluginId === "wecom-bot") {
    return "企业微信群机器人";
  }

  if (pluginId === "wecom-smart-bot") {
    return "企业微信智能机器人";
  }

  if (pluginId === "webhook") {
    return "Webhook";
  }

  if (pluginId === "telegram") {
    return "Telegram";
  }

  return pluginId;
}

function renderChannelTypeOptions() {
  const previousValue = elements.channelType.value;
  const options = channelTypes();

  elements.channelType.innerHTML = options
    .map((channel) => `<option value="${escapeHtml(channel.pluginId)}">${escapeHtml(getChannelTypeLabel(channel.pluginId))}</option>`)
    .join("");

  if (options.some((channel) => channel.pluginId === previousValue)) {
    elements.channelType.value = previousValue;
    return;
  }

  elements.channelType.value = options[0]?.pluginId || "webhook";
}

function getTargetFormValues() {
  const values = {};
  for (const input of elements.monitorFields.querySelectorAll("[data-field-key]")) {
    const value = input.value.trim();
    if (value) {
      values[input.getAttribute("data-field-key")] = value;
    }
  }
  return values;
}

function resetTargetEditor({ preservePlatform = true } = {}) {
  const nextPlatformId = preservePlatform ? elements.monitorPlatform.value || state.editingTarget?.platformId : undefined;
  state.editingTarget = undefined;
  elements.monitorForm.reset();
  if (nextPlatformId) {
    elements.monitorPlatform.value = nextPlatformId;
  }
}

function resetChannelEditor({ preserveType = true } = {}) {
  const nextType = preserveType ? elements.channelType.value || "webhook" : "webhook";
  state.editingChannelId = undefined;
  elements.channelForm.reset();
  elements.channelType.disabled = false;
  elements.channelType.value = nextType;
}

function renderPageChrome(filteredMessages) {
  const meta = PAGE_META[state.currentPage];
  elements.pageTitle.textContent = meta.title;
  elements.pageDescription.textContent = meta.description;
  for (const [pageId, section] of Object.entries(elements.pageSections)) {
    section.hidden = pageId !== state.currentPage;
  }
  const targetCount = state.settings.platforms.reduce((sum, platform) => sum + platform.targets.length, 0);
  elements.statPlatforms.textContent = String(state.settings.platforms.length);
  elements.statTargets.textContent = String(targetCount);
  elements.statMessages.textContent = String(state.messages.length);
  elements.statResults.textContent = String(filteredMessages.length);
}

function buildPagerPages(page, totalPages) {
  const pages = [];
  for (let index = Math.max(1, page - 2); index <= Math.min(totalPages, page + 2); index += 1) {
    pages.push(index);
  }
  return pages;
}

function renderPlatformTabs() {
  const fragment = document.createDocumentFragment();
  const appendTab = (label, count, active, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab${active ? " active" : ""}`;
    button.innerHTML = `${escapeHtml(label)}<small>${count}</small>`;
    button.addEventListener("click", onClick);
    fragment.appendChild(button);
  };
  appendTab("全部平台", state.messages.length, state.platformId === "all", () => setPlatform("all"));
  for (const platform of state.settings.platforms) {
    const count = state.messages.filter((event) => event.platformId === platform.id).length;
    appendTab(platform.name, count, state.platformId === platform.id, () => setPlatform(platform.id));
  }
  elements.platformTabs.innerHTML = "";
  elements.platformTabs.classList.remove("loading");
  elements.platformTabs.appendChild(fragment);
}

function renderTargetFilters() {
  const targets = getAvailableTargets();
  const platformName = state.platformId === "all" ? "全部平台" : getPlatformDefinition(state.platformId)?.name || state.platformId;
  elements.filterHelp.textContent = state.platformId === "all" ? "可在这里多选监控用户，组合筛选消息流。" : `当前平台：${platformName}。仅显示这个平台下的监控用户。`;
  if (targets.length === 0) {
    elements.targetFilters.innerHTML = '<div class="empty">当前没有可筛选的监控用户。</div>';
    return;
  }
  elements.targetFilters.innerHTML = "";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = `chip${state.targetIds.length === 0 ? " active" : ""}`;
  allButton.textContent = "全部用户";
  allButton.addEventListener("click", clearTargetFilters);
  elements.targetFilters.appendChild(allButton);
  for (const target of targets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip${state.targetIds.includes(target.id) ? " active" : ""}`;
    button.textContent = state.platformId === "all" ? `${target.platformName} / ${target.label}` : target.label;
    button.addEventListener("click", () => toggleTarget(target.id));
    elements.targetFilters.appendChild(button);
  }
}

function renderMediaPreview(event) {
  const mediaItems = Array.isArray(event.message?.media) ? event.message.media : [];
  if (mediaItems.length === 0) {
    return "";
  }
  const preview = mediaItems[0];
  const badge = `${preview.type === "video" ? "视频" : "图片"}${mediaItems.length > 1 ? ` · ${mediaItems.length}` : ""}`;

  return `<div class="thumbs">
    <div class="thumb" aria-hidden="true">
      <img src="${escapeHtml(preview.thumbnailUrl || preview.url || "")}" alt="${escapeHtml(event.message?.title || "媒体预览")}" loading="lazy" />
      <span class="thumb-badge">${badge}</span>
    </div>
  </div>`;
}

function renderFeedCards(items) {
  if (items.length === 0) {
    elements.stream.innerHTML = '<div class="empty">当前筛选条件下暂无消息。你可以切换平台分页或取消用户筛选后重试。</div>';
    return;
  }
  elements.stream.innerHTML = items.map((event) => {
    const title = event.message?.title || event.message?.content || "未命名消息";
    const summary = event.message?.content || title;
    const media = renderMediaPreview(event);
    const link = event.message?.url;
    const shellClass = `panel signal${link ? " signal-link" : ""}${media ? "" : " signal-no-media"}`;
    const shellStart = link
      ? `<a class="${shellClass}" href="${escapeHtml(link)}" target="_blank" rel="noreferrer noopener">`
      : `<article class="${shellClass}">`;
    const shellEnd = link ? "</a>" : "</article>";
    const footer = link ? "点击卡片打开原文" : "当前无原文链接";

    return `${shellStart}<div class="signal-head"><h3 class="signal-title">${escapeHtml(title)}</h3><span class="badge">发布时间：${escapeHtml(formatTime(event.message?.publishedAt))}</span></div><div class="signal-body"><div class="signal-main"><div class="meta"><span>${escapeHtml(event.platformName || event.platformId || "-")}</span><span>监控用户：${escapeHtml(event.target?.label || event.target?.id || "-")}</span><span>作者：${escapeHtml(event.author?.name || event.author?.id || "-")}</span></div><p class="signal-summary">${escapeHtml(summary)}</p></div>${media}</div><div class="signal-foot"><span>${footer}</span></div>${shellEnd}`;
  }).join("");
}

function renderPagination(total, page, totalPages) {
  if (total <= state.pageSize) {
    elements.pagination.innerHTML = "";
    return;
  }
  elements.pagination.innerHTML = `<div class="pager-summary">第 ${page} / ${totalPages} 页，共 ${total} 条消息</div><div class="pager-group">${[`<button type="button" class="pager" data-page="${Math.max(page - 1, 1)}" ${page === 1 ? "disabled" : ""}>上一页</button>`, ...buildPagerPages(page, totalPages).map((value) => `<button type="button" class="pager${value === page ? " active" : ""}" data-page="${value}">${value}</button>`), `<button type="button" class="pager" data-page="${Math.min(page + 1, totalPages)}" ${page === totalPages ? "disabled" : ""}>下一页</button>`].join("")}</div>`;
  for (const button of elements.pagination.querySelectorAll("[data-page]")) {
    button.addEventListener("click", () => {
      if (!button.disabled) {
        setPageNumber(Number.parseInt(button.getAttribute("data-page") || "1", 10));
      }
    });
  }
}

function renderDashboardAlerts() {
  const alerts = [];
  const invalidAuth = state.authStatuses.filter((item) => item.requiresLogin && /失效|未登录|失败/.test(item.status));
  if (invalidAuth.length > 0) {
    alerts.push({ tone: "danger", title: "登录态需要处理", status: `${invalidAuth.length} 项`, detail: invalidAuth.map((item) => `${getPlatformDefinition(item.platformId)?.name || item.platformId}：${item.status}`).join("；") });
  }
  if (!state.localAuthAgent.enabled) {
    alerts.push({ tone: "info", title: "本地登录代理未启用", status: "手动模式", detail: "当前服务器未配置本地登录代理令牌，登录需要手动同步 storage-state 文件。" });
  } else if (!state.localAuthAgent.online) {
    alerts.push({ tone: "danger", title: "本地登录代理离线", status: "等待连接", detail: "页面无法直接调用你电脑上的脚本。请先在本机启动 local auth agent，再点击“开始登录”。" });
  } else if (state.localAuthAgent.pendingTasks > 0) {
    alerts.push({ tone: "info", title: "本地登录代理在线", status: `${state.localAuthAgent.pendingTasks} 个任务`, detail: "本机 agent 已连接；点击“开始登录”后会由 agent 自动领取并打开本地浏览器。" });
  }
  const targetCount = state.settings.platforms.reduce((sum, platform) => sum + platform.targets.length, 0);
  if (targetCount === 0) {
    alerts.push({ tone: "danger", title: "暂无监控目标", status: "空配置", detail: "请先到“监控用户”页面添加需要监控的用户。" });
  }
  if (alerts.length === 0) {
    alerts.push({ tone: "info", title: "系统运行正常", status: "稳定", detail: "当前没有高优先级告警，页面会持续接收实时消息。" });
  }
  elements.dashboardAlerts.innerHTML = alerts.map((alert) => `<article class="alert ${alert.tone}"><div class="alert-title"><span>${escapeHtml(alert.title)}</span><span class="status${alert.tone === "danger" ? " danger" : ""}">${escapeHtml(alert.status)}</span></div><p class="muted">${escapeHtml(alert.detail)}</p></article>`).join("");
}

function renderDashboardChart() {
  const counts = state.settings.platforms.map((platform) => ({ name: platform.name, count: state.messages.filter((event) => event.platformId === platform.id).length }));
  const maxCount = Math.max(1, ...counts.map((item) => item.count));
  elements.dashboardPlatformChart.innerHTML = counts.map((item) => `<div class="chart-row"><div>${escapeHtml(item.name)}</div><div class="chart-track"><span class="chart-bar" style="width:${(item.count / maxCount) * 100}%"></span></div><div class="muted" style="text-align:right">${item.count}</div></div>`).join("") || '<div class="empty">暂无图表数据</div>';
}

function renderDashboardTableAndTimeline() {
  const byTarget = new Map();
  for (const platform of state.settings.platforms) {
    for (const target of platform.targets) {
      byTarget.set(`${platform.id}:${target.id}`, { label: target.label, platformName: platform.name, count: 0, latestPublishedAt: "", status: "空闲" });
    }
  }
  for (const event of state.messages) {
    const key = `${event.platformId}:${event.target?.id}`;
    const row = byTarget.get(key);
    if (!row) {
      continue;
    }
    row.count += 1;
    if (!row.latestPublishedAt || toTimestamp(event.message?.publishedAt) > toTimestamp(row.latestPublishedAt)) {
      row.latestPublishedAt = event.message?.publishedAt || "";
    }
    row.status = row.count > 0 ? "活跃" : "空闲";
  }
  const rows = [...byTarget.values()].sort((left, right) => right.count - left.count || toTimestamp(right.latestPublishedAt) - toTimestamp(left.latestPublishedAt));
  elements.dashboardTargetTableBody.innerHTML = rows.length > 0 ? rows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.platformName)}</td><td>${row.count}</td><td>${escapeHtml(formatTime(row.latestPublishedAt))}</td><td>${escapeHtml(row.status)}</td></tr>`).join("") : '<tr><td colspan="5" class="empty">暂无监控目标数据</td></tr>';
  elements.dashboardTimeline.innerHTML = state.messages.slice(0, 8).map((event) => `<div class="timeline-item"><div class="timeline-title">${escapeHtml(event.message?.title || event.message?.content || "未命名消息")}</div><div class="timeline-meta">${escapeHtml(event.platformName || event.platformId || "-")} / ${escapeHtml(event.target?.label || "-")} / ${escapeHtml(formatTime(event.message?.publishedAt))}</div></div>`).join("") || '<div class="empty">暂无时间线数据</div>';
}

function renderFeedPanels() {
  const filteredMessages = getFilteredMessages();
  renderPlatformTabs();
  renderTargetFilters();
  const totalPages = Math.max(1, Math.ceil(filteredMessages.length / state.pageSize));
  state.page = Math.min(Math.max(state.page, 1), totalPages);
  const pageItems = filteredMessages.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  renderFeedCards(pageItems);
  renderPagination(filteredMessages.length, state.page, totalPages);
  elements.resultSummary.textContent = `按发布时间倒序显示。当前显示第 ${state.page} 页，每页 ${state.pageSize} 条；筛选后共 ${filteredMessages.length} 条消息。`;
  elements.pageSize.value = String(state.pageSize);
  elements.clearFilters.disabled = state.targetIds.length === 0;
  return filteredMessages;
}

function renderDashboardPanels() {
  renderDashboardAlerts();
  renderDashboardChart();
  renderDashboardTableAndTimeline();
}

function renderAuthPanels() {
  renderDashboardAlerts();
  renderAuthStatuses();
}

function renderTargetFormFields() {
  const platform = getPlatformDefinition(elements.monitorPlatform.value);
  const seed = state.editingTarget?.platformId === elements.monitorPlatform.value ? state.editingTarget.raw || {} : {};
  elements.monitorFields.innerHTML = (platform?.fields || []).map((field) => `<label class="field"><span>${escapeHtml(field.label)}</span><input type="text" data-field-key="${escapeHtml(field.key)}" value="${escapeHtml(seed[field.key] || "")}" placeholder="${escapeHtml(field.placeholder || "")}" /></label>`).join("");
  elements.monitorPlatform.disabled = Boolean(state.editingTarget);
  elements.targetSubmitText.textContent = state.editingTarget ? "保存监控用户" : "添加监控用户";
  elements.targetCancel.hidden = !state.editingTarget;
}

function renderManagedTargets() {
  elements.managedTargets.innerHTML = state.settings.platforms.map((platform) => `<article class="mini"><div class="mini-head"><strong>${escapeHtml(platform.name)}</strong><span class="status">${platform.targets.length} 项</span></div><ul class="item-list">${platform.targets.length > 0 ? platform.targets.map((target) => `<li class="list-item"><div><strong>${escapeHtml(target.label)}</strong><div class="muted">${escapeHtml(target.id)}</div></div>${target.isCustom ? `<div class="mini-actions"><button type="button" class="btn edit-target" data-platform-id="${escapeHtml(platform.id)}" data-target-id="${escapeHtml(target.id)}">编辑</button><button type="button" class="btn remove-target" data-platform-id="${escapeHtml(platform.id)}" data-target-id="${escapeHtml(target.id)}">删除</button></div>` : '<span class="muted">内置关闭</span>'}</li>`).join("") : '<li class="empty">暂无监控用户</li>'}</ul></article>`).join("");
  for (const button of elements.managedTargets.querySelectorAll(".edit-target")) {
    button.addEventListener("click", () => {
      const platformId = button.getAttribute("data-platform-id");
      const targetId = button.getAttribute("data-target-id");
      const target = getPlatformTarget(platformId, targetId);
      if (!target) {
        return;
      }
      state.editingTarget = { platformId, targetId, raw: { ...(target.raw || {}) } };
      elements.monitorPlatform.value = platformId;
      setPage("targets", { push: false });
      render();
    });
  }
  for (const button of elements.managedTargets.querySelectorAll(".remove-target")) {
    button.addEventListener("click", async () => {
      try {
        await requestJson(`/api/targets?platformId=${encodeURIComponent(button.getAttribute("data-platform-id"))}&targetId=${encodeURIComponent(button.getAttribute("data-target-id"))}`, { method: "DELETE" });
        if (state.editingTarget?.targetId === button.getAttribute("data-target-id")) {
          resetTargetEditor();
        }
        showToast("已删除监控用户。");
        await refreshDashboardData();
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  }
}

function renderAuthStatuses() {
  const nonDangerStates = new Set([
    "已保存登录态",
    "登录态校验中",
    "无需登录"
  ]);

  elements.authGrid.innerHTML =
    state.authStatuses
      .map((entry) => {
        const danger = !nonDangerStates.has(entry.status);
        const actions = entry.requiresLogin
          ? `<button type="button" class="btn auth-login" data-platform-id="${escapeHtml(entry.platformId)}">开始登录</button>${entry.loginUrl ? `<a class="btn link" href="${escapeHtml(entry.loginUrl)}" target="_blank" rel="noreferrer">打开平台登录页</a>` : ""}`
          : '<span class="muted">当前无需额外登录</span>';

        return `<article class="alert ${danger ? "danger" : ""}"><div class="alert-title"><span>${escapeHtml(getPlatformDefinition(entry.platformId)?.name || entry.platformId)}</span><span class="status${danger ? " danger" : ""}">${escapeHtml(entry.status)}</span></div><p class="muted">${escapeHtml(entry.detail || "")}</p><div class="mini-actions">${actions}</div></article>`;
      })
      .join("") || '<div class="empty">暂无登录状态数据。</div>';

  for (const button of elements.authGrid.querySelectorAll(".auth-login")) {
    button.addEventListener("click", async () => {
      try {
        const result = await requestJson("/auth/login", {
          method: "POST",
          body: JSON.stringify({ platformId: button.getAttribute("data-platform-id") })
        });
        if (result.mode === "external" && result.loginUrl) {
          window.open(result.loginUrl, "_blank", "noopener,noreferrer");
        }
        showToast(result.message || "已打开平台登录页。");
        await refreshAuthStatuses();
        renderAuthPanels();
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  }
}

function renderChannelFormFields() {
  renderChannelTypeOptions();
  const type = channelTypes().find((entry) => entry.pluginId === elements.channelType.value);
  const existing = state.editingChannelId ? getChannelDefinition(state.editingChannelId) : undefined;
  const config = existing?.config || {};
  const wecomHint = type?.pluginId === "wecom-bot"
    ? `<article class="mini"><div class="mini-head"><strong>填写说明</strong><span class="status">WECOM</span></div><p class="muted">企业微信群机器人这里需要填写 <strong>Webhook Key</strong> 或完整 <strong>Webhook URL</strong>。机器人 ID、企业 ID、AgentId 都不能直接用于推送。</p></article>`
    : type?.pluginId === "wecom-smart-bot"
      ? `<article class="mini"><div class="mini-head"><strong>填写说明</strong><span class="status">SMART BOT</span></div><p class="muted">企业微信智能机器人使用 <strong>BotID + Secret</strong> 建立长连接，再向指定会话主动发消息。单聊请填写用户的 <strong>userid</strong>，群聊请填写对应的 <strong>chatid</strong>，多个会话可用逗号分隔。</p></article>`
      : "";
  elements.channelFields.innerHTML = `<label class="field field-checkbox"><input type="checkbox" id="channel-enabled" ${config.enabled === false ? "" : "checked"} /><span>启用该通知渠道</span></label>${wecomHint}${(type?.fields || []).map((field) => `<label class="field"><span>${escapeHtml(field.label)}</span><input type="text" data-channel-key="${escapeHtml(field.key)}" value="${escapeHtml(field.key === "chatIds" ? normalizeDelimitedList(config[field.key] || config.chatId || "") : config[field.key] || "")}" placeholder="${escapeHtml(field.placeholder || "")}" /></label>`).join("")}`;
  elements.channelSubmitText.textContent = state.editingChannelId ? "更新通知渠道" : "接入通知渠道";
  elements.channelType.disabled = Boolean(state.editingChannelId);
  elements.channelCancel.hidden = !state.editingChannelId;
}

function renderManagedChannels() {
  elements.managedChannels.innerHTML = state.settings.channels.map((channel) => `<article class="mini"><div class="mini-head"><strong>${escapeHtml(channel.label || channel.id)}</strong><span class="status">${channel.enabled ? "已启用" : "已停用"}</span></div><p class="muted">${escapeHtml(channel.pluginId)} / ${escapeHtml(channel.summary || "")}</p><div class="mini-actions">${channel.pluginId === "webhook" || channel.pluginId === "telegram" || channel.pluginId === "wecom-bot" || channel.pluginId === "wecom-smart-bot" ? `<button type="button" class="btn edit-channel" data-channel-id="${escapeHtml(channel.id)}">编辑</button>` : ""}${!channel.builtin ? `<button type="button" class="btn remove-channel" data-channel-id="${escapeHtml(channel.id)}">删除</button>` : '<span class="muted">内置渠道</span>'}</div></article>`).join("") || '<div class="empty">暂无通知渠道。</div>';
  for (const button of elements.managedChannels.querySelectorAll(".edit-channel")) {
    button.addEventListener("click", () => {
      state.editingChannelId = button.getAttribute("data-channel-id");
      const channel = getChannelDefinition(state.editingChannelId);
      if (!channel) {
        return;
      }
      elements.channelType.value = channel.pluginId;
      setPage("channels", { push: false });
      render();
    });
  }
  for (const button of elements.managedChannels.querySelectorAll(".remove-channel")) {
    button.addEventListener("click", async () => {
      try {
        const channelId = button.getAttribute("data-channel-id");
        await requestJson(`/api/channels?channelId=${encodeURIComponent(channelId)}`, { method: "DELETE" });
        if (state.editingChannelId === channelId) {
          resetChannelEditor();
        }
        showToast("通知渠道已删除。");
        await refreshSettings();
        render();
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  }
}

async function writeClipboard(text) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("当前浏览器不支持剪贴板写入");
  }

  await navigator.clipboard.writeText(text);
}

function appendDiscoveredSessionToForm(sessionId) {
  if (elements.channelType.value !== "wecom-smart-bot") {
    elements.channelType.value = "wecom-smart-bot";
    if (!state.editingChannelId) {
      renderChannelFormFields();
    }
  }

  const input = elements.channelFields.querySelector('[data-channel-key="chatIds"]');

  if (!input) {
    throw new Error("当前未打开企业微信智能机器人表单");
  }

  const current = normalizeDelimitedList(input.value);
  const next = normalizeDelimitedList(current ? `${current},${sessionId}` : sessionId);
  input.value = next;
}

function renderDiscoveredSessions() {
  if (!elements.discoveredSessions) {
    return;
  }

  if (state.discoveredSessions.length === 0) {
    elements.discoveredSessions.innerHTML = '<div class="empty">暂未发现企业微信智能机器人会话。先让目标用户或目标群与机器人交互一次，再点击刷新。</div>';
    return;
  }

  elements.discoveredSessions.innerHTML = state.discoveredSessions.map((session) => {
    const sessionKind = session.sessionType === "group" ? "群聊 chatid" : "单聊 userid";
    const sessionValue = session.sessionType === "group" ? session.chatId || session.sessionId : session.userId || session.sessionId;
    return `<article class="mini"><div class="mini-head"><strong>${escapeHtml(session.channelLabel || session.channelId || "企业微信智能机器人")}</strong><span class="status">${escapeHtml(sessionKind)}</span></div><p class="muted">会话 ID：${escapeHtml(sessionValue || "-")}</p><p class="muted">来源：${escapeHtml(session.sourceType || "-")} / 最近发现：${escapeHtml(formatTime(session.lastSeenAt))}</p><div class="mini-actions"><button type="button" class="btn fill-session" data-session-id="${escapeHtml(sessionValue || "")}">填入会话 ID</button><button type="button" class="btn copy-session" data-session-id="${escapeHtml(sessionValue || "")}">复制</button></div></article>`;
  }).join("");

  for (const button of elements.discoveredSessions.querySelectorAll(".copy-session")) {
    button.addEventListener("click", async () => {
      try {
        await writeClipboard(button.getAttribute("data-session-id"));
        showToast("会话 ID 已复制。");
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  }

  for (const button of elements.discoveredSessions.querySelectorAll(".fill-session")) {
    button.addEventListener("click", () => {
      try {
        appendDiscoveredSessionToForm(button.getAttribute("data-session-id"));
        showToast("会话 ID 已填入企业微信智能机器人表单。");
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  }
}

function renderNotificationStatus() {
  const permission = window.Notification ? Notification.permission : "unsupported";
  if (permission === "unsupported") {
    elements.notificationStatus.textContent = "当前浏览器不支持系统通知。";
    elements.notificationButton.textContent = "当前浏览器不支持";
    elements.notificationButton.disabled = true;
    return;
  }
  if (permission === "granted" && state.notificationEnabled) {
    elements.notificationStatus.textContent = "浏览器通知已启用，发现新消息时会立即弹出系统通知。";
    elements.notificationButton.textContent = "通知已启用";
    elements.notificationButton.disabled = true;
    return;
  }
  if (permission === "denied") {
    elements.notificationStatus.textContent = "浏览器通知已被拒绝，请在浏览器设置中重新允许。";
    elements.notificationButton.textContent = "通知已被阻止";
    elements.notificationButton.disabled = true;
    return;
  }
  elements.notificationStatus.textContent = state.notificationEnabled ? "通知开关已打开，等待浏览器完成权限授权。" : "点击按钮后，浏览器会请求通知权限。";
  elements.notificationButton.textContent = "启用浏览器通知";
  elements.notificationButton.disabled = false;
}

function render() {
  syncTargetSelection();
  renderNavigation();
  const filteredMessages = getFilteredMessages();
  renderPageChrome(filteredMessages);
  renderFeedPanels();
  renderDashboardPanels();
  renderTargetFormFields();
  renderManagedTargets();
  renderAuthStatuses();
  renderChannelFormFields();
  renderManagedChannels();
  renderDiscoveredSessions();
  renderNotificationStatus();
}

function upsertMessage(event) {
  const existingIndex = state.messages.findIndex((item) => item.id === event.id);
  if (existingIndex >= 0) {
    state.messages.splice(existingIndex, 1);
  }
  state.messages.push(event);
  state.messages.sort(compareEventsByPublishedAtDesc);
  syncTargetSelection();
  const filteredMessages = getFilteredMessages();
  renderPageChrome(filteredMessages);
  if (state.currentPage === "dashboard") {
    renderDashboardPanels();
    return;
  }
  if (state.currentPage === "feed") {
    renderFeedPanels();
  }
}

async function refreshSettings() {
  const payload = await requestJson("/settings");
  const previousPlatformValue = elements.monitorPlatform.value;
  const previousChannelType = elements.channelType.value;
  state.settings = { platforms: payload.platforms || [], channels: payload.channels || [] };
  state.authStatuses = payload.authStatuses || [];
  state.localAuthAgent = payload.localAuthAgent || { enabled: false, online: false, pendingTasks: 0 };
  state.discoveredSessions = payload.discoveredSessions || [];
  renderChannelTypeOptions();
  elements.monitorPlatform.innerHTML = state.settings.platforms.map((platform) => `<option value="${escapeHtml(platform.id)}">${escapeHtml(platform.name)}</option>`).join("");
  if (state.editingTarget && !getPlatformTarget(state.editingTarget.platformId, state.editingTarget.targetId)) {
    state.editingTarget = undefined;
  }
  if (state.editingChannelId && !getChannelDefinition(state.editingChannelId)) {
    state.editingChannelId = undefined;
  }
  const nextPlatformValue = state.editingTarget?.platformId ?? previousPlatformValue ?? state.settings.platforms[0]?.id;
  if (nextPlatformValue && state.settings.platforms.some((platform) => platform.id === nextPlatformValue)) {
    elements.monitorPlatform.value = nextPlatformValue;
  }
  if (previousChannelType && channelTypes().some((channel) => channel.pluginId === previousChannelType)) {
    elements.channelType.value = previousChannelType;
  }
}

async function refreshAuthStatuses() {
  const payload = await requestJson("/auth/status");
  state.authStatuses = payload.authStatuses || [];
  state.localAuthAgent = payload.localAuthAgent || state.localAuthAgent;
}

async function refreshMessages() {
  const payload = await requestJson("/messages?page=1&pageSize=500");
  state.messages = (payload?.items || []).slice().sort(compareEventsByPublishedAtDesc);
}

async function refreshDashboardData() {
  await Promise.all([refreshSettings(), refreshMessages()]);
  hydrateStateFromUrl();
  render();
}

function startAuthStatusPolling() {
  window.clearInterval(authStatusPollTimerId);
  authStatusPollTimerId = window.setInterval(async () => {
    try {
      await refreshAuthStatuses();
      renderAuthPanels();
    } catch {}
  }, 5000);
}

async function enableBrowserNotification() {
  if (!window.Notification) {
    showToast("当前浏览器不支持系统通知。", "error");
    return;
  }
  const permission = await Notification.requestPermission();
  state.notificationEnabled = permission === "granted";
  window.localStorage.setItem("news:browserNotificationEnabled", String(state.notificationEnabled));
  renderNotificationStatus();
  showToast(state.notificationEnabled ? "浏览器通知已开启。" : "浏览器通知未开启。", state.notificationEnabled ? "info" : "error");
}

function sendBrowserNotification(event) {
  if (!state.notificationEnabled || !window.Notification || Notification.permission !== "granted") {
    return;
  }
  const title = event.message?.title || event.message?.content || "检测到新消息";
  const notification = new Notification(`${event.platformName} / ${event.target?.label || ""}`, { body: title, tag: event.id });
  notification.onclick = () => {
    window.focus();
    if (event.message?.url) {
      window.open(event.message.url, "_blank", "noopener,noreferrer");
    }
    notification.close();
  };
}

function connectRealtimeEvents() {
  const source = new EventSource("/events");
  source.addEventListener("message", (incoming) => {
    const event = JSON.parse(incoming.data);
    upsertMessage(event);
    sendBrowserNotification(event);
  });
}

function bindEvents() {
  elements.navToggle.addEventListener("click", toggleSidebar);
  elements.sidebarNav.addEventListener("click", (event) => {
    const link = event.target.closest("[data-page-link]");
    if (!link) {
      return;
    }
    event.preventDefault();
    setPage(link.getAttribute("data-page-link"));
  });
  elements.clearFilters.addEventListener("click", clearTargetFilters);
  elements.pageSize.addEventListener("change", () => {
    state.pageSize = Number.parseInt(elements.pageSize.value || "12", 10);
    state.page = 1;
    writeUrlState();
    render();
  });
  elements.notificationButton.addEventListener("click", enableBrowserNotification);
  elements.refreshDiscoveredSessions?.addEventListener("click", async () => {
    try {
      await refreshSettings();
      render();
      showToast("已刷新发现的会话 ID。");
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  elements.monitorPlatform.addEventListener("change", () => {
    if (!state.editingTarget) {
      renderTargetFormFields();
    }
  });
  elements.targetCancel.addEventListener("click", () => {
    resetTargetEditor();
    render();
  });
  elements.monitorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const wasEditing = Boolean(state.editingTarget);
      await requestJson("/api/targets", { method: "POST", body: JSON.stringify({ platformId: elements.monitorPlatform.value, target: getTargetFormValues(), previousTargetId: state.editingTarget?.targetId }) });
      resetTargetEditor();
      await refreshDashboardData();
      showToast(wasEditing ? "监控用户已更新。" : "监控用户已添加。");
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  elements.channelType.addEventListener("change", () => {
    if (!state.editingChannelId) {
      renderChannelFormFields();
    }
  });
  elements.channelCancel.addEventListener("click", () => {
    resetChannelEditor();
    render();
  });
  elements.channelForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      let payload = { id: state.editingChannelId, pluginId: elements.channelType.value, enabled: document.getElementById("channel-enabled")?.checked ?? true };
      for (const input of elements.channelFields.querySelectorAll("[data-channel-key]")) {
        const value = input.value.trim();
        if (value) {
          payload[input.getAttribute("data-channel-key")] = value;
        }
      }
      payload = normalizeChannelPayload(payload);
      await requestJson("/api/channels", { method: "POST", body: JSON.stringify({ channel: payload }) });
      resetChannelEditor();
      await refreshSettings();
      render();
      showToast("通知渠道配置已保存。");
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  window.addEventListener("popstate", () => {
    hydrateStateFromUrl();
    render();
  });
  window.addEventListener("beforeunload", () => {
    window.clearInterval(authStatusPollTimerId);
  });
}

async function boot() {
  try {
    hydrateStateFromUrl();
    await refreshDashboardData();
    bindEvents();
    startAuthStatusPolling();
    connectRealtimeEvents();
  } catch (error) {
    elements.stream.innerHTML = `<div class="empty">页面初始化失败：${escapeHtml(error?.message || String(error))}</div>`;
  }
}

void boot();
