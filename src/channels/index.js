import { browserSseChannel } from "./browser-sse.js";
import { consoleChannel } from "./console.js";
import { telegramChannel } from "./telegram.js";
import { wecomBotChannel } from "./wecom-bot.js";
import { webhookChannel } from "./webhook.js";

export const builtinChannelPlugins = [
  consoleChannel,
  browserSseChannel,
  telegramChannel,
  wecomBotChannel,
  webhookChannel
];
