/**
 * API Provider độc lập entry point.
 *
 *   node dist/apps/server/main.js [--port 18900] [--key ofm-...]
 *
 * Defaults từ env: OFM_GATEWAY_PORT, OFM_GATEWAY_HOST, OFM_GATEWAY_KEY, OFM_DATA_DIR
 */

import { startGateway } from "@ofm/gateway/server";
import { buildLaneModels } from "@ofm/gateway/dispatch";
import { kiloModels, PROVIDER_ID as KILO_ID } from "@ofm/core/kilo";
import { opencodeModels, PROVIDER_ID as OPENCODE_ID } from "@ofm/core/opencode";
import { eacModels, PROVIDER_ID as EAC_ID } from "@ofm/core/eac-lane";
import {
  aggregateModels,
  PROVIDER_ID as AGGREGATE_ID,
} from "@ofm/core/aggregate-lane";
import { AnnouncementFeed, DEFAULT_FEED_SOURCES } from "@ofm/core/feed";
import { createPushHub } from "@ofm/core/push";
import { readChains } from "@ofm/core/chain-store";
import { normalizeChains } from "@ofm/core/chains";
import type { ChainRow } from "@ofm/gateway/chain";
import { JsonStore } from "@ofm/gateway/store";
import { generateKey } from "@ofm/gateway/protocol";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_PORT = 18900;
const DEFAULT_HOST = "127.0.0.1";

function dataDir(): string {
  return process.env.OFM_DATA_DIR ?? path.join(os.homedir(), ".our-free-model");
}

interface GatewaySettingsFile {
  version: number;
  key: string;
  port: number;
  host: string;
}

function settingsStore(): JsonStore<GatewaySettingsFile> {
  return new JsonStore<GatewaySettingsFile>({
    file: path.join(dataDir(), "gateway.json"),
    initial: { version: 1, key: "", port: 0, host: "127.0.0.1" },
  });
}

function readStoredKey(): string {
  return settingsStore().get().key;
}

function storeKey(key: string): void {
  settingsStore().update({ key });
}

async function main() {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let key = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === "--host" && args[i + 1]) host = args[++i];
    else if (args[i] === "--key" && args[i + 1]) key = args[++i];
  }

  const stored = readStoredKey();
  if (!key && stored) key = stored;
  if (!key) {
    key = generateKey();
    storeKey(key);
  }

  fs.mkdirSync(dataDir(), { recursive: true });

  const settings = { host, port, enabled: true, key };

  const [kilo, opencode, eac, aggregate] = await Promise.all([
    kiloModels(),
    opencodeModels(),
    eacModels(),
    aggregateModels(),
  ]);

  const laneModels = buildLaneModels([
    { id: KILO_ID, models: kilo },
    { id: OPENCODE_ID, models: opencode },
    { id: EAC_ID, models: eac },
    { id: AGGREGATE_ID, models: aggregate },
  ]);

  const chainData = normalizeChains(readChains()) as ChainRow[];
  const feed = new AnnouncementFeed({
    settings: () => ({ feedUrl: undefined }) as any,
    defaultSources: DEFAULT_FEED_SOURCES,
    cacheFile: path.join(dataDir(), "feed.json"),
  } as any);
  const push = createPushHub();

  const handle = await startGateway({
    settings: () => settings,
    models: () => laneModels,
    chains: () => chainData,
    feed: () => feed,
    push: () => push,
    log: (msg) => console.log(`[gateway] ${msg}`),
  });

  console.log(`API provider listening on http://${handle.host}:${handle.port}`);
  console.log(`API key: ${key}`);

  process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    await handle.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
