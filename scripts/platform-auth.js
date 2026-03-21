import process from "node:process";

import { runPlatformLogin } from "./lib/run-platform-login.js";

function parseCliArgs(argv) {
  const parsed = {
    platformId: "xiaohongshu",
    outputPath: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--platform") {
      parsed.platformId = argv[index + 1] ?? parsed.platformId;
      index += 1;
      continue;
    }

    if (arg === "--output") {
      parsed.outputPath = argv[index + 1] ?? parsed.outputPath;
      index += 1;
    }
  }

  return parsed;
}

const { platformId, outputPath } = parseCliArgs(process.argv.slice(2));

await runPlatformLogin({
  platformId,
  outputPath,
  cwd: process.cwd(),
  logger: console
});
