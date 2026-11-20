#!/usr/bin/env node
/**
 * Standalone service entry point.
 *
 *   node dist/apps/standalone/main.js [--port N] [--data-dir DIR] [--no-refresh]
 *                                     [--lan|--no-lan] [--lan-port N] [--help]
 */

import { startStandalone } from "../../packages/standalone/service.js";

const usage = `Our Free Model 独立本地服务
用法：node dist/apps/standalone/main.js [选项]

  --port <端口>       监听端口，默认 18900（冲突时自动选择可用端口）
  --data-dir <目录>   数据目录，默认 OFM_HOME 或 ~/.our-free-model
  --no-refresh        跳过启动与周期刷新；仍可手动刷新和推理
  --lan               启用并保存 LAN 推理中继（独立密钥，管理页仍仅限本机）
  --no-lan            关闭并保存 LAN 推理中继
  --lan-port <端口>   保存 LAN 期望端口，默认 0；不会单独开启中继
  --help              显示帮助
`;

async function main() {
  const options: Record<string, unknown> = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") {
      process.stdout.write(usage);
      return;
    }
    if (flag === "--no-refresh") {
      options.refresh = false;
      continue;
    }
    if (flag === "--lan") {
      options.lan = true;
      continue;
    }
    if (flag === "--no-lan") {
      options.lan = false;
      continue;
    }
    if (flag === "--port" && args[i + 1]) {
      options.port = Number(args[++i]);
      continue;
    }
    if (flag === "--data-dir" && args[i + 1]) {
      options.dataDir = args[++i];
      continue;
    }
    if (flag === "--lan-port" && args[i + 1]) {
      options.lanPort = Number(args[++i]);
      continue;
    }
    console.error(`未知参数: ${flag}`);
    process.exit(1);
  }

  try {
    await startStandalone(options);
  } catch (err: any) {
    console.error("启动失败:", err?.message ?? err);
    process.exit(1);
  }
}

main();
