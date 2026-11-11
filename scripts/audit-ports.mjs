#!/usr/bin/env node
/**
 * Kiểm kê drift giữa bản gốc và bản port — file, export, và từng definition.
 *
 * AGENTS.md §8 yêu cầu ba lượt soi; script này là lượt 1 được tự động hoá:
 *
 *   1. **File**      — mỗi file code của `./dsh-our-free-model/` có bản port trên đĩa.
 *   2. **Export**    — mỗi export symbol của bản gốc có tên xuất hiện ở đâu đó
 *                      trong `pi-extension/`.
 *   3. **Definition** — mỗi `function` / `class` / `method` của bản gốc có mặt
 *                      trong **đúng file port tương ứng** (không chỉ ở dâu đó).
 *
 * So sánh "đã được xử lý" ở đâu: script này chỉ trả lời "có tên đó không", nên
 * một hàm bị đổi hành vi vẫn qua được. Nó tồn tại để loại trừ lớp nhiễu lớn nhất
 * (file chưa có / symbol chưa có / định nghĩa bị xoá) để người review đọc đúng
 * chỗ còn nghi.
 *
 * Chạy:  node scripts/audit-ports.mjs [--verbose]
 *
 * @module scripts/audit-ports.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const source = process.env.DSH_DIR ?? path.join(root, 'dsh-our-free-model')
const target = path.join(root, 'pi-extension')
const verbose = process.argv.includes('--verbose')

/** Directories the upstream keeps that are not code (docs, build outputs). */
const SOURCE_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'docs', 'target', '.git', 'out', 'build', '.turbo', 'coverage',
])
/** Directories in the port that are build outputs. */
const TARGET_SKIP_DIRS = new Set(['node_modules', 'dist', 'web', '.git'])

/**
 * Where a source file's port lives, when the convention does not hold.
 *
 * `null` means "deliberately not ported" — the reason is the value.
 */
const EXPLICIT = {
  // ── giữ nguyên đường dẫn ──
  'worker/dashboard.html': 'worker/dashboard.html',
  'worker/entry.js': 'worker/entry.js',
  'worker/wrangler.toml': 'worker/wrangler.toml',
  'src/o2a/assets/opencode_tools.json': 'o2a/assets/opencode_tools.json',
  'src/o2a/assets/opencode_prompt_v2.txt': 'o2a/assets/opencode_prompt_v2.txt',
  'src/o2a/SYNC.md': 'o2a/SYNC.md',
  'src/providers/registry.json': 'providers/registry.json',
  'src/sponsor.css': 'client/sponsor.css',
  'icon.svg': 'icon.svg',

  // ── đổi tên / dồn cụm ──
  'adapter/kernel.js': 'adapter.ts',
  'adapter/dsh-llm.d.ts': 'packages/standalone/frontend/types.ts',
  'cordis.patch.yml': null,
  "PACKAGING.md": null,
  "README_EN.md": null,
  'client.js': 'client',
  'index.js': 'index.ts',
  'src/token-saver.js': 'token-saver/index.ts',
  'src/token-saver/index.js': 'token-saver/index.ts',
  'src/token-saver/rtk/index.js': 'token-saver/rtk-index.ts',
  'src/route/classify.js': 'gateway/classify.ts',
  'src/bun-fetch.js': 'loopback-fetch.ts',
  'src/eac-login.js': 'eac-login.ts',
  'src/subscriptions.js': 'subscriptions.ts',
  'src/adapter.js': 'adapter.ts',
  'src/feed.js': 'feed.ts',
  'src/http.js': 'gateway/forward-server.ts',
  'src/forward.js': 'gateway/forward-server.ts',
  'src/core.js': 'core/runtime.ts',

  // ── worker/ đã dồn ──
  'worker/gateway-node.mjs': 'worker/node-host.ts',
  'worker/verify-deployment.mjs': 'worker/verify.ts',
  'worker/auth-github.mjs': 'worker/auth-github.ts',

  // ── docs của bản gốc: bản port đã viết lại, không giữ nguyên ──
  'README.md': null,
  'README_EN.md': null,
  'PACKAGING.md': null,
  'LICENSE': null,
  'package-lock.json': null,

  // ── src/*.js đã được dồn vào cụm thư mục của bản port ──
  'src/anthropic.js': 'gateway/anthropic.ts',
  'src/gemini.js': 'gateway/gemini.ts',
  'src/store.js': 'gateway/store.ts',
  'src/probe.js': 'gateway/probe.ts',
  'src/recovery.js': 'gateway/recovery.ts',
  'src/deferred-response.js': 'gateway/response-stream.ts',
  'src/local-optimize.js': 'gateway/optimize.ts',
  'src/token-saver/rtk/index.js': 'token-saver/applyFilter.ts',
  'src/token-saver/rtk/registry.js': 'token-saver/registry.ts',
  'src/token-saver/rtk/constants.js': 'token-saver/constants.ts',
  'src/token-saver/rtk/autodetect.js': 'token-saver/autodetect.ts',
  'src/token-saver/rtk/applyFilter.js': 'token-saver/applyFilter.ts',
  'src/token-saver/rtk/hitLine.js': 'token-saver/hitLine.ts',
  'src/token-saver/filters': null,

  // ── dữ liệu, không phải code tay ──
  'src/engine-parts/win32-x64.000.part': 'magpie-engine.ts',
  'src/engine-parts/win32-x64.001.part': 'magpie-engine.ts',
  'src/engine-parts/win32-x64.002.part': 'magpie-engine.ts',
  'src/engine-parts/win32-x64.003.part': 'magpie-engine.ts',
  'src/engine-parts/win32-x64.004.part': 'magpie-engine.ts',
  'src/engine-parts/win32-x64.005.part': 'magpie-engine.ts',
  'src/engine-parts/win32-x64.006.part': 'magpie-engine.ts',
  'src/image-pricing.d.ts': null,

  // ── KHÔNG port, kèm lý do duy nhất (AGENTS.md §5) ──
  'vendor/magpie/bin': 'binary không ship',
}

/** Extensions the port keeps as `.ts`/`.mjs` rather than translating wholesale. */
const CODE_EXT = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.html', '.md', '.txt', '.yml', '.toml', '.part', '.wasm', '.rs'])

/** Nối file code của bản gốc theo thứ tự ổn định. */
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SOURCE_SKIP_DIRS.has(entry.name)) continue
      sourceFiles(path.join(dir, entry.name), out)
      continue
    }
    out.push(path.join(dir, entry.name))
  }
  return out
}

/** Toàn bộ file của bản port, dùng cho lượt 2 (symbol xuất hiện ở đâu). */
function targetFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (TARGET_SKIP_DIRS.has(entry.name)) continue
      targetFiles(path.join(dir, entry.name), out)
      continue
    }
    out.push(path.join(dir, entry.name))
  }
  return out
}

/** Đường dẫn tương ứng trong pi-extension/, hoặc `null` khi cố ý không port. */
function portPathOf(rel) {
  if (rel in EXPLICIT) return EXPLICIT[rel]
  if (rel.startsWith('vendor/')) return rel
  if (rel.startsWith('packages/')) return rel.replace(/\.mjs$/, '.ts').replace(/^packages\/desktop\/src-tauri\//, 'packages/desktop/src-tauri/')
  if (rel.startsWith('worker/')) return rel.replace(/\.mjs$/, '.ts')
  if (rel === 'worker/worker.js') return 'worker/entry.js'
  if (rel.startsWith('scripts/')) return rel
  if (rel.startsWith('adapter/') || rel.startsWith('catalog/') || rel.startsWith('feed/') || rel.startsWith('locale/')) {
    return rel.replace(/\.js$/, '.ts').replace(/kernel\.ts$/, 'kernel.js')
  }
  if (rel.startsWith('src/o2a/')) return 'o2a/' + rel.slice('src/o2a/'.length).replace(/\.js$/, '.ts')
  if (rel.startsWith('src/core/')) return 'core/' + rel.slice('src/core/'.length).replace(/\.js$/, '.ts')
  if (rel.startsWith('src/token-saver')) {
    // 2.8.3 giữ phân cấp rtk/; bản port bỏ lớp rtk/ vì chính nó đã là cấp đó.
    const flat = rel.slice('src/token-saver/'.length).replace(/^rtk\//, '').replace(/\.js$/, '.ts')
    return 'token-saver/' + flat
  }
  if (rel.startsWith('src/providers/')) return 'providers/' + rel.slice('src/providers/'.length).replace(/\.js$/, '.ts')
  if (rel.startsWith('src/')) {
    const name = rel.slice('src/'.length)
    const asTs = name.replace(/\.js$/, '.ts')
    // 2.8.3 đoạn một số module đã chuyển sang cụm thư mục của bản port.
    if (fs.existsSync(path.join(target, asTs))) return asTs
    if (fs.existsSync(path.join(target, asTs.replace(/\.ts$/, '/index.ts')))) return asTs.replace(/\.ts$/, '/index.ts')
    return asTs
  }
  return rel
}

/** Mọi export tên của một file JS/TS, theo cả hai cách viết. */
function exportNames(text) {
  const names = new Set()
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1])
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (piece) names.add(piece)
    }
  }
  for (const match of text.matchAll(/^export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1])
  for (const match of text.matchAll(/^module\.exports\s*=\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim().split(':').pop()?.trim()
      if (piece) names.add(piece)
    }
  }
  return names
}

/**
 * Mọi định nghĩa khai báo được: function, class, method, hằng cấp trên cùng.
 *
 * Chỉ lấy method shorthand **trong thân class**: regex `^  foo(` ở cấp trên cùng
 * bắt cả biến cục bộ (`b`, `last`, `seen`…) và tạo ra hàng trăm dòng nhiễu,
 * ngược lại mục đích của lượt 3.
 */
function definitionNames(text) {
  const names = new Set()
  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(match[1])
  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1])
  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) names.add(match[1])
  // method shorthand, chỉ trong thân class
  let depth = 0
  let inClass = false
  for (const line of text.split('\n')) {
    const open = (line.match(/\{/g) ?? []).length
    const close = (line.match(/\}/g) ?? []).length
    if (!inClass && /^\s*(?:export\s+)?(?:default\s+)?class\s+[A-Za-z_$]/.test(line)) inClass = true
    else if (inClass && depth <= 1 && close > open) inClass = false
    if (inClass) {
      const method = /^\s{2,}(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line)
      if (method !== null) names.add(method[1])
    }
    depth += open - close
    if (depth < 0) depth = 0
  }
  return names
}

/**
 * Cụm file của bản port tương ứng một file nguồn.
 *
 * Vài file nguồn (`o2a.js`, `core.js`, `http.js`, `forward.js`,
 * `token-saver.js`) là **bundle sinh bằng esbuild** của cả cụm module; bản port
 * giữ dạng module riêng, nên lượt 3 phải soi trên cả cụm chứ không soi trên
 * một file — soi một file sẽ báo mỗi cái tên ở file lân cận là "thiếu".
 */
const BUNDLES = new Set([
  'src/o2a.js', 'src/core.js', 'src/http.js', 'src/forward.js', 'src/token-saver.js',
  'src/core/runtime.js', 'src/adapter.js', 'src/stream.js', 'src/messages.js',
  'src/kilo.js', 'src/sponsor.js', 'src/subscription-adapter.js', 'src/upstream.js',
  'src/bun-fetch.js', 'src/magpie-engine.js', 'src/magpie-models.js',
  'src/open-external.js', 'src/catalog.js', 'src/token-saver/index.js',
  'packages/standalone/service.mjs', 'packages/standalone/management.mjs',
])

/** Cụm file của bản port để soi definition. */
function portGroup(portPath, rel) {
  const corpus = portCorpus(portPath)
  if (!BUNDLES.has(rel)) return corpus
  const extra = targetFiles(target)
    .filter(file => /\.(ts|tsx|mjs)$/.test(file))
    .filter(file => !/node_modules|\/dist\/|\/web\//.test(file))
    .map(file => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } })
  return corpus + '\n' + extra.join('\n')
}

/** Tên nào xuất hiện (dạng từ nguyên) trong một đoạn văn bản. */
function mentions(name, text) {
  return new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(text)
}

/** Đọc toàn bộ file port đã map, + mọi sibling cùng thư mục cho lượt 3. */
function portCorpus(portPath) {
  if (portPath === null) return ''
  const full = path.join(target, portPath)
  const chunks = []
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    chunks.push(fs.readFileSync(full, 'utf8'))
  } else if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    for (const file of targetFiles(full)) {
      const text = fs.readFileSync(file, 'utf8')
      chunks.push(text)
    }
  }
  return chunks.join('\n')
}

const files = sourceFiles(source)
let ported = 0
let missing = []
let exportGaps = []
let definitionGaps = []
let deliberate = []
const rows = []

for (const full of files) {
  const rel = path.relative(source, full).split(path.sep).join('/')
  const ext = path.extname(rel)
  if (!CODE_EXT.has(ext)) continue
  if (rel.startsWith('vendor/') && rel.includes('/bin/')) { deliberate.push([rel, EXPLICIT['vendor/magpie/bin']]); continue }
  const portRel = portPathOf(rel)
  if (portRel === null) { deliberate.push([rel, EXPLICIT[rel]]); continue }
  const text = fs.readFileSync(full, 'utf8')
  const corpus = portGroup(portRel, rel)
  if (corpus === '') {
    missing.push(rel)
    rows.push({ rel, portRel, state: 'THIẾU FILE', exports: [...exportNames(text)], definitions: [...definitionNames(text)] })
    continue
  }
  ported += 1
  const missingExports = [...exportNames(text)].filter(name => !mentions(name, corpus))
  const missingDefinitions = [...definitionNames(text)].filter(name => !mentions(name, corpus))
  if (missingExports.length > 0) exportGaps.push([rel, portRel, missingExports])
  if (missingDefinitions.length > 0) definitionGaps.push([rel, portRel, missingDefinitions])
  if (missingExports.length > 0 || missingDefinitions.length > 0) {
    rows.push({ rel, portRel, state: 'DRIFT', exports: missingExports, definitions: missingDefinitions })
  }
}

// ── lượt 2: toàn bộ export của bản gốc, soi trên toàn bộ bản port ────────────
const allPortText = targetFiles(target).map(file => fs.readFileSync(file, 'utf8')).join('\n')
const projectGaps = []
const seenProject = new Set()
for (const full of files) {
  const rel = path.relative(source, full).split(path.sep).join('/')
  if (!CODE_EXT.has(path.extname(rel))) continue
  const portRel = portPathOf(rel)
  if (portRel === null) continue
  const text = fs.readFileSync(full, 'utf8')
  for (const name of exportNames(text)) {
    if (seenProject.has(name)) continue
    seenProject.add(name)
    if (!mentions(name, allPortText)) projectGaps.push([rel, name])
  }
}

const codeFiles = files.filter(f => CODE_EXT.has(path.extname(f)))
console.log(`# Kiểm kê port — ${path.basename(source)} → pi-extension/`)
console.log(`File code: ${codeFiles.length} · đã map: ${ported} · thiếu: ${missing.length} · cố ý không port: ${deliberate.length}`)
console.log(`Export quét: ${seenProject.size} · không thấy ở bất kỳ đâu: ${projectGaps.length}`)
console.log(`Drift trong file đã map: ${rows.length} (export ${exportGaps.length} · definition ${definitionGaps.length})`)

if (missing.length > 0) {
  console.log(`\n## 1. FILE CHƯA CÓ (${missing.length})`)
  for (const rel of missing) console.log(`  - ${rel}  →  ${portPathOf(rel)}`)
}
if (projectGaps.length > 0) {
  console.log(`\n## 2. EXPORT KHÔNG XUẤT HIỆN TRONG TOÀN BỘ BẢN PORT (${projectGaps.length})`)
  for (const [rel, name] of projectGaps) console.log(`  - ${name}   (${rel})`)
}
if (definitionGaps.length > 0) {
  console.log(`\n## 3. DEFINITION THIẾU TRONG ĐÚNG FILE PORT (${definitionGaps.length})`)
  for (const [rel, portRel, names] of definitionGaps) {
    console.log(`  - ${rel} → ${portRel}`)
    console.log(`      thiếu: ${names.join(', ')}`)
  }
}
if (exportGaps.length > 0 && verbose) {
  console.log(`\n## 4. EXPORT THIẾU TRONG ĐÚNG FILE PORT (${exportGaps.length}, chỉ hiện với --verbose)`)
  for (const [rel, portRel, names] of exportGaps) console.log(`  - ${rel} → ${portRel}\n      thiếu: ${names.join(', ')}`)
}
if (deliberate.length > 0) {
  console.log(`\n## CỐ Ý KHÔNG PORT (${deliberate.length})`)
  for (const [rel, why] of deliberate) console.log(`  - ${rel} — ${why}`)
}

fs.writeFileSync(path.join(root, 'docs', 'audit-ports.md'), [
  `# Kiểm kê port — sinh tự động bởi \`scripts/audit-ports.mjs\``,
  '',
  `> Nguồn: \`${source}\`. Chạy \`node scripts/audit-ports.mjs [--verbose]\` để tạo lại.`,
  `> Con số này trả lời "có tên không", không trả lời "đúng hành vi không".`,
  '',
  `- File code: **${codeFiles.length}**`,
  `- Đã map: **${ported}** · thiếu: **${missing.length}**`,
  `- Export quét: **${seenProject.size}** · không thấy ở đâu: **${projectGaps.length}**`,
  `- File đã map nhưng có drift: **${rows.length}**`,
  '',
  '## 1. File chưa có',
  ...(missing.length === 0 ? ['(không)'] : missing.map(rel => `- \`${rel}\` → \`${portPathOf(rel)}\``)),
  '',
  '## 2. Export không xuất hiện trong toàn bộ bản port',
  ...(projectGaps.length === 0 ? ['(không)'] : projectGaps.map(([rel, name]) => `- \`${name}\` — ${rel}`)),
  '',
  '## 3. Definition thiếu trong đúng file port',
  ...(definitionGaps.length === 0 ? ['(không)'] : definitionGaps.flatMap(([rel, portRel, names]) => [`- \`${rel}\` → \`${portRel}\`: ${names.join(', ')}`])),
  '',
].join('\n') + '\n')
console.log(`\nĐã ghi docs/audit-ports.md`)
