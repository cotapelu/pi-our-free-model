#!/usr/bin/env node
/**
 * Fix import paths after restructuring to packages/ + apps/
 * Rewrites relative imports to use @ofm/* path aliases.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const IMPORT_MAP = new Map([
  // From core/ to gateway/
  ["../gateway/store.js", "@ofm/gateway/store"],
  ["../gateway/protocol.js", "@ofm/gateway/protocol"],
  ["../gateway/loopback.js", "@ofm/gateway/loopback"],
  ["../gateway/forward-server.js", "@ofm/gateway/forward-server"],
  ["../gateway/classify.js", "@ofm/gateway/classify"],
  ["../gateway/probe.js", "@ofm/gateway/probe"],
  ["../gateway/recovery.js", "@ofm/gateway/recovery"],
  ["../gateway/egress.js", "@ofm/gateway/egress"],
  ["../gateway/chain.js", "@ofm/gateway/chain"],

  // From core/ to core/ (fix relative to same package)
  ["../adapter.js", "@ofm/core/adapter"],
  ["../fingerprint.js", "@ofm/core/fingerprint"],
  ["../upstream.js", "@ofm/core/upstream"],
  ["../messages.js", "@ofm/core/messages"],
  ["../eac.js", "@ofm/core/eac-lane"],
  ["../kilo-poster.js", "@ofm/core/kilo-poster"],
  ["../aggregate.js", "@ofm/core/aggregate-lane"],
  ["../stream.js", "@ofm/core/stream"],
  ["../effort.js", "@ofm/core/effort"],
  ["../combos.js", "@ofm/core/combos"],
  ["../failure.js", "@ofm/core/failure"],
  ["../catalog.js", "@ofm/core/catalog"],
  ["../model-test.js", "@ofm/core/model-test"],
  ["../channel.js", "@ofm/core/channel"],
  ["../subscription-adapter.js", "@ofm/core/subscription-adapter"],
  ["../subscription-completion.js", "@ofm/core/subscription-completion"],
  ["../saver-stats.js", "@ofm/core/saver-stats"],
  ["../kilo.js", "@ofm/core/kilo"],
  ["../opencode.js", "@ofm/core/opencode"],
  ["../eac-lane.js", "@ofm/core/eac-lane"],
  ["../aggregate-lane.js", "@ofm/core/aggregate-lane"],
  ["../lane.js", "@ofm/core/lane"],
  ["../attribution.js", "@ofm/core/attribution"],
  ["../transport.js", "@ofm/core/transport"],
  ["../feed.js", "@ofm/core/feed"],
  ["../feed-ack.js", "@ofm/core/feed-ack"],
  ["../picks.js", "@ofm/core/picks"],
  ["../push.js", "@ofm/core/push"],
  ["../chains.js", "@ofm/core/chains"],
  ["../saver-store.js", "@ofm/core/saver-store"],
  ["../saver-stats.js", "@ofm/core/saver-stats"],
  ["../token-saver/index.js", "@ofm/core/token-saver/index"],
  ["../o2a/tool-renames.js", "@ofm/core/o2a/tool-renames"],
  ["../o2a/official-prompt.js", "@ofm/core/o2a/official-prompt"],
  ["../o2a/toolshape.js", "@ofm/core/o2a/toolshape"],
  ["../o2a/official-tools.js", "@ofm/core/o2a/official-tools"],
  ["../o2a/gateway-body.js", "@ofm/core/o2a/gateway-body"],

  // From core/ to gateway/ (relative ./gateway/...)
  ["./gateway/store.js", "@ofm/gateway/store"],
  ["./gateway/protocol.js", "@ofm/gateway/protocol"],
  ["./gateway/loopback.js", "@ofm/gateway/loopback"],
  ["./gateway/forward-server.js", "@ofm/gateway/forward-server"],
  ["./gateway/classify.js", "@ofm/gateway/classify"],
  ["./gateway/probe.js", "@ofm/gateway/probe"],
  ["./gateway/recovery.js", "@ofm/gateway/recovery"],
  ["./gateway/egress.js", "@ofm/gateway/egress"],
  ["./gateway/chain.js", "@ofm/gateway/chain"],

  // From core/ to core/ (relative ./... from within core)
  ["./messages.js", "@ofm/core/messages"],
  ["./stream.js", "@ofm/core/stream"],
  ["./effort.js", "@ofm/core/effort"],
  ["./combos.js", "@ofm/core/combos"],
  ["./failure.js", "@ofm/core/failure"],
  ["./catalog.js", "@ofm/core/catalog"],
  ["./model-test.js", "@ofm/core/model-test"],
  ["./channel.js", "@ofm/core/channel"],
  ["./subscription-adapter.js", "@ofm/core/subscription-adapter"],
  ["./subscription-completion.js", "@ofm/core/subscription-completion"],
  ["./saver-stats.js", "@ofm/core/saver-stats"],
  ["./kilo.js", "@ofm/core/kilo"],
  ["./opencode.js", "@ofm/core/opencode"],
  ["./eac-lane.js", "@ofm/core/eac-lane"],
  ["./aggregate-lane.js", "@ofm/core/aggregate-lane"],
  ["./lane.js", "@ofm/core/lane"],
  ["./attribution.js", "@ofm/core/attribution"],
  ["./transport.js", "@ofm/core/transport"],
  ["./feed.js", "@ofm/core/feed"],
  ["./feed-ack.js", "@ofm/core/feed-ack"],
  ["./picks.js", "@ofm/core/picks"],
  ["./push.js", "@ofm/core/push"],
  ["./chains.js", "@ofm/core/chains"],
  ["./saver-store.js", "@ofm/core/saver-store"],
  ["./saver-stats.js", "@ofm/core/saver-stats"],
  ["./token-saver/index.js", "@ofm/core/token-saver/index"],
  ["./o2a/tool-renames.js", "@ofm/core/o2a/tool-renames"],
  ["./o2a/official-prompt.js", "@ofm/core/o2a/official-prompt"],
  ["./o2a/toolshape.js", "@ofm/core/o2a/toolshape"],
  ["./o2a/official-tools.js", "@ofm/core/o2a/official-tools"],
  ["./o2a/gateway-body.js", "@ofm/core/o2a/gateway-body"],

  // From gateway/ to core/
  ["../fingerprint.js", "@ofm/core/fingerprint"],
  ["../catalog.js", "@ofm/core/catalog"],
  ["../kilo.js", "@ofm/core/kilo"],
  ["../opencode.js", "@ofm/core/opencode"],
  ["../eac-lane.js", "@ofm/core/eac-lane"],
  ["../aggregate-lane.js", "@ofm/core/aggregate-lane"],
  ["../lane.js", "@ofm/core/lane"],
  ["../attribution.js", "@ofm/core/attribution"],
  ["../transport.js", "@ofm/core/transport"],
  ["../feed.js", "@ofm/core/feed"],
  ["../feed-ack.js", "@ofm/core/feed-ack"],
  ["../picks.js", "@ofm/core/picks"],
  ["../push.js", "@ofm/core/push"],
  ["../chains.js", "@ofm/core/chains"],
  ["../saver-stats.js", "@ofm/core/saver-stats"],

  // From standalone/ to core/
  ["../../core/runtime.js", "@ofm/core/runtime"],
  ["../../core/model-runtime.js", "@ofm/core/model-runtime"],
  ["../../gateway/protocol.js", "@ofm/gateway/protocol"],
  ["../../gateway/loopback.js", "@ofm/gateway/loopback"],
  ["../../gateway/forward-server.js", "@ofm/gateway/forward-server"],
  ["../../trust.js", "@ofm/core/trust"],
  ["../../subscriptions.js", "@ofm/core/subscriptions"],
  ["../../subscription-completion.js", "@ofm/core/subscription-completion"],
  ["../../magpie-engine.js", "@ofm/core/magpie-engine"],
  ["../../magpie-models.js", "@ofm/core/magpie-models"],
  ["../../extensions.js", "@ofm/core/extensions"],
  ["../../plugins.js", "@ofm/core/plugins"],
  ["../../disclaimer.js", "@ofm/core/disclaimer"],
  ["../../gateway/store.js", "@ofm/gateway/store"],
  ["../../gateway/classify.js", "@ofm/gateway/classify"],
  ["../../gateway/dispatch.js", "@ofm/gateway/dispatch"],
  ["../../eac.js", "@ofm/core/eac-lane"],
  ["../../kilo.js", "@ofm/core/kilo"],
  ["../../opencode.js", "@ofm/core/opencode"],
  ["../../eac-lane.js", "@ofm/core/eac-lane"],
  ["../../aggregate.js", "@ofm/core/aggregate-lane"],
  ["../../aggregate-lane.js", "@ofm/core/aggregate-lane"],
  ["../../channel.js", "@ofm/core/channel"],
  ["../../catalog.js", "@ofm/core/catalog"],
  ["../../catalog-rows.js", "@ofm/core/catalog-rows"],
  ["../../stream.js", "@ofm/core/stream"],
  ["../../effort.js", "@ofm/core/effort"],
  ["../../combos.js", "@ofm/core/combos"],
  ["../../failure.js", "@ofm/core/failure"],
  ["../../model-test.js", "@ofm/core/model-test"],
  ["../../saver-store.js", "@ofm/core/saver-store"],
  ["../../saver-stats.js", "@ofm/core/saver-stats"],
  ["../../token-saver/index.js", "@ofm/core/token-saver/index"],
]);

function fixImportsInFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  let newContent = content;
  let changed = false;

  for (const [oldImport, newImport] of IMPORT_MAP) {
    const regex = new RegExp(`from\\s+['"]${escapeRegExp(oldImport)}['"]`, "g");
    if (regex.test(newContent)) {
      newContent = newContent.replace(regex, `from '${newImport}'`);
      changed = true;
    }
    const dynRegex = new RegExp(
      `import\\(['"]${escapeRegExp(oldImport)}['"]\\)`,
      "g",
    );
    if (dynRegex.test(newContent)) {
      newContent = newContent.replace(dynRegex, `import('${newImport}')`);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, newContent);
    console.log(`Fixed: ${path.relative(ROOT, filePath)}`);
  }
  return changed;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walkDir(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "web", "frontend"].includes(entry.name)) {
        files.push(...walkDir(fullPath));
      }
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  console.log("Fixing import paths...\n");

  const PACKAGES = [
    "core",
    "gateway",
    "provider",
    "standalone",
    "console",
    "shared",
    "desktop",
    "worker",
  ];

  for (const name of PACKAGES) {
    const fullPath = path.join(ROOT, "packages", name);
    if (!fs.existsSync(fullPath)) continue;

    const files = walkDir(fullPath);
    for (const file of files) {
      fixImportsInFile(file);
    }
  }

  // Also fix apps/
  const appsPath = path.join(ROOT, "apps");
  if (fs.existsSync(appsPath)) {
    const files = walkDir(appsPath);
    for (const file of files) {
      fixImportsInFile(file);
    }
  }

  // Also fix config/
  const configPath = path.join(ROOT, "config");
  if (fs.existsSync(configPath)) {
    const files = walkDir(configPath);
    for (const file of files) {
      fixImportsInFile(file);
    }
  }

  console.log("\nDone fixing imports.");
}

main().catch(console.error);
