#!/usr/bin/env node
/**
 * Post-build script: rewrite @ofm/* path aliases to relative imports
 * in compiled JS files so they work natively with Node.js ESM.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// Map @ofm/* package to its dist directory
const PACKAGE_DIST_DIRS = {
  core: "packages/core",
  gateway: "packages/gateway",
  provider: "packages/provider",
  standalone: "packages/standalone",
  console: "packages/console",
  shared: "packages/shared",
  desktop: "packages/desktop",
  worker: "packages/worker",
};

/**
 * Given an import specifier like '@ofm/core/upstream' and the importing file's
 * directory, return a relative path to the compiled JS file.
 */
function resolveImport(specifier, fromDir) {
  const match = specifier.match(/^@ofm\/([^\/]+)\/(.+)$/);
  if (!match) return specifier;

  const [, pkgName, subPath] = match;
  const pkgDistDir = PACKAGE_DIST_DIRS[pkgName];
  if (!pkgDistDir) return specifier;

  // Target file in dist
  const targetFile = path.join(ROOT, "dist", pkgDistDir, subPath + ".js");

  // Relative path from fromDir to targetFile
  const relativePath = path.relative(fromDir, targetFile);

  // Ensure it starts with ./ or ../
  if (!relativePath.startsWith(".")) {
    return "./" + relativePath;
  }

  return relativePath;
}

function processFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const fromDir = path.dirname(filePath);

  let newContent = content;
  let changed = false;

  // Replace @ofm/pkg/subpath imports
  newContent = newContent.replace(
    /from ['"]@ofm\/([^\/]+)\/(.+?)['"]/g,
    (match, pkgName, subPath) => {
      const targetFile = path.join(
        ROOT,
        "dist",
        PACKAGE_DIST_DIRS[pkgName],
        subPath + ".js",
      );
      if (!fs.existsSync(targetFile)) return match;
      const relativePath = path.relative(fromDir, targetFile);
      const fixed = relativePath.startsWith(".")
        ? relativePath
        : "./" + relativePath;
      changed = true;
      return `from '${fixed}'`;
    },
  );

  if (changed) {
    fs.writeFileSync(filePath, newContent);
    console.log(`Fixed: ${path.relative(ROOT, filePath)}`);
  }
}

function walkDir(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function main() {
  console.log("Rewriting @ofm/* imports to relative paths...\n");
  const files = walkDir(DIST);
  for (const file of files) {
    processFile(file);
  }
  console.log("\nDone.");
}

main();
