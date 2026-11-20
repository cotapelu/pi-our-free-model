#!/usr/bin/env node
/**
 * Fix import paths in tests/ to match new build output structure.
 *
 * Old: ../../dist/core/upstream.js
 * New: ../../dist/packages/core/upstream.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(ROOT, "tests");

// Map from what comes after "../../dist/" to what it should be after "../../dist/"
// Sorted by length descending so more specific paths are replaced first
const PATH_MAP = [
  // Direct files at packages/core/ (most specific first)
  ["core/upstream.js", "packages/core/upstream.js"],
  ["core/catalog.js", "packages/core/catalog.js"],
  ["core/catalog-rows.js", "packages/core/catalog-rows.js"],
  ["core/completion.js", "packages/core/completion.js"],
  ["core/runtime.js", "packages/core/runtime.js"],
  ["core/stats.js", "packages/core/stats.js"],
  ["core/adapter.js", "packages/core/adapter.js"],
  ["core/combos.js", "packages/core/combos.js"],
  ["core/disclaimer.js", "packages/core/disclaimer.js"],
  ["core/effort.js", "packages/core/effort.js"],
  ["core/engine-payload.js", "packages/core/engine-payload.js"],
  ["core/extensions.js", "packages/core/extensions.js"],
  ["core/failure.js", "packages/core/failure.js"],
  ["core/feed.js", "packages/core/feed.js"],
  ["core/fingerprint.js", "packages/core/fingerprint.js"],
  ["core/kilo.js", "packages/core/kilo.js"],
  ["core/lane.js", "packages/core/lane.js"],
  ["core/magpie-engine.js", "packages/core/magpie-engine.js"],
  ["core/magpie-models.js", "packages/core/magpie-models.js"],
  ["core/magpie-policy.js", "packages/core/magpie-policy.js"],
  ["core/messages.js", "packages/core/messages.js"],
  ["core/open-external.js", "packages/core/open-external.js"],
  ["core/picks.js", "packages/core/picks.js"],
  ["core/plugins.js", "packages/core/plugins.js"],
  ["core/push.js", "packages/core/push.js"],
  ["core/reload.js", "packages/core/reload.js"],
  ["core/saver-store.js", "packages/core/saver-store.js"],
  ["core/sponsor.js", "packages/core/sponsor.js"],
  ["core/stream.js", "packages/core/stream.js"],
  ["core/subscription-adapter.js", "packages/core/subscription-adapter.js"],
  ["core/subscriptions.js", "packages/core/subscriptions.js"],
  ["core/transport.js", "packages/core/transport.js"],
  ["core/trust.js", "packages/core/trust.js"],
  ["core/updater.js", "packages/core/updater.js"],
  ["core/vault-anchor.js", "packages/core/vault-anchor.js"],
  ["core/vault-data.js", "packages/core/vault-data.js"],
  ["core/vault.js", "packages/core/vault.js"],

  // Directory prefixes
  ["catalog.js", "packages/core/catalog.js"],
  ["core/", "packages/core/"],
  ["worker/", "packages/worker/"],
  ["gateway/", "packages/gateway/"],
  ["eac.js", "packages/core/eac.js"],
  ["eac-lane.js", "packages/core/eac-lane.js"],
  ["chan-relay.js", "packages/core/chan-relay.js"],
  ["picks.js", "packages/core/picks.js"],
  ["effort.js", "packages/core/effort.js"],
  ["eac-login.js", "packages/core/eac-login.js"],
  ["magpie-policy.js", "packages/core/magpie-policy.js"],
  ["magpie-models.js", "packages/core/magpie-models.js"],
  ["reload.js", "packages/core/reload.js"],
  ["magpie-engine.js", "packages/core/magpie-engine.js"],
  ["push.js", "packages/core/push.js"],
  ["updater.js", "packages/core/updater.js"],
  ["transport.js", "packages/core/transport.js"],
  ["o2a/", "packages/core/o2a/"],
  ["token-saver/", "packages/core/token-saver/"],
  ["providers/", "packages/core/providers/"],
  ["attribution.js", "packages/core/attribution.js"],
  ["worker/auth-github.js", "packages/worker/auth-github.js"],
  ["packages/core/providers/index.js", "packages/core/providers.js"],
  ["adapter.js", "packages/core/adapter.js"],
  ["combos.js", "packages/core/combos.js"],
  ["disclaimer.js", "packages/core/disclaimer.js"],
  ["extensions.js", "packages/core/extensions.js"],
  ["plugins.js", "packages/core/plugins.js"],
  ["subscriptions.js", "packages/core/subscriptions.js"],
  ["subscription-adapter.js", "packages/core/subscription-adapter.js"],
  ["eac-user.js", "packages/core/eac-user.js"],
  ["messages.js", "packages/core/messages.js"],
  ["fingerprint.js", "packages/core/fingerprint.js"],
  ["upstream.js", "packages/core/upstream.js"],
  ["vault-anchor.js", "packages/core/vault-anchor.js"],
  ["vault-data.js", "packages/core/vault-data.js"],
  ["vault.js", "packages/core/vault.js"],
  ["chain-store.js", "packages/core/chain-store.js"],
  ["chains.js", "packages/core/chains.js"],
  ["engine-payload.js", "packages/core/engine-payload.js"],
  ["saver-store.js", "packages/core/saver-store.js"],
  ["failure.js", "packages/core/failure.js"],
  ["trust.js", "packages/core/trust.js"],
  ["feed.js", "packages/core/feed.js"],
  ["open-external.js", "packages/core/open-external.js"],
  ["sponsor.js", "packages/core/sponsor.js"],
  ["aggregate.js", "packages/core/aggregate.js"],
  ["stream.js", "packages/core/stream.js"],
  ["client/sanitizer.js", "packages/console/sanitizer.js"],

  // standalone (already correct)
  ["packages/standalone/", "packages/standalone/"],
];

function fixFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  let newContent = content;
  let changed = false;

  for (const [oldPath, newPath] of PATH_MAP) {
    const fullOld = `../../dist/${oldPath}`;
    const fullNew = `../../dist/${newPath}`;
    if (newContent.includes(fullOld)) {
      newContent = newContent.split(fullOld).join(fullNew);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, newContent);
    console.log(`Fixed: ${path.relative(ROOT, filePath)}`);
  }
  return changed;
}

function walkDir(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".mjs") ||
      entry.name.endsWith(".js")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function main() {
  console.log("Fixing test import paths...\n");
  const files = walkDir(TESTS_DIR);
  let changed = 0;
  for (const file of files) {
    if (fixFile(file)) changed++;
  }
  console.log(`\nFixed ${changed} file(s).`);
}

main();
