import process from "node:process";

import { runPlatformLogin } from "./lib/run-platform-login.js";

function parseCliArgs(argv) {
  const parsed = {
    outputPath: process.env.NEWS_XHS_STORAGE_STATE_PATH ?? "data/browser/xiaohongshu.storage-state.json"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--output") {
      parsed.outputPath = argv[index + 1] ?? parsed.outputPath;
      index += 1;
    }
  }

  return parsed;
}

const { outputPath } = parseCliArgs(process.argv.slice(2));

await runPlatformLogin({
  platformId: "xiaohongshu",
  outputPath,
  cwd: process.cwd(),
  logger: console
});
