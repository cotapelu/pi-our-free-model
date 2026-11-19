/**
 * The one-time notice the free lanes owe the user.
 *
 * Both lanes this extension registers are somebody else's free tier, and each
 * has a property a user must know before typing anything they care about:
 * Kilo's free pool states on its own model cards that prompts may be logged by
 * the upstream provider and used to improve its services, and OpenCode's free
 * lane meters per session/IP, so a shared egress can spend it. That is not a
 * bug report, it is the price of the lane — but it has to be said once, in the
 * session where the models first appear, not buried in a README.
 *
 * The copy is versioned for the same reason dsh versions its disclaimer: when
 * the wording or the lanes change, the notice must be able to come back.
 *
 * @module pi-extension/disclaimer.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Bump to re-show the notice after the copy or the lanes change. */
export const NOTICE_VERSION = 1

const FILE_NAME = 'notice-ack.json'

/** `<dataDir or $OFM_DATA_DIR or ~/.our-free-model>/notice-ack.json`. */
export function ackPath(dataDir?: string) {
  const root = dataDir ?? process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model')
  return path.join(root, FILE_NAME)
}

/** The stored acknowledgement's version, or 0 when there is none. */
export function readAck(dataDir?: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ackPath(dataDir), 'utf8'))
    return Number.isFinite(parsed?.version) ? parsed.version : 0
  } catch {
    return 0
  }
}

/** Whether this machine has not yet seen the current notice. */
export function shouldNotice(dataDir?: string) {
  return readAck(dataDir) < NOTICE_VERSION
}

/** Record that the notice was shown, so it does not come back every session. */
export function writeAck(dataDir?: string) {
  const file = ackPath(dataDir)
  const directory = path.dirname(file)
  const temp = `${file}.tmp`
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify({ version: NOTICE_VERSION, at: Date.now() }, undefined, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* the rename already carried the temp file's mode on every platform that has one */
  }
  return NOTICE_VERSION
}

/**
 * The disclaimer copy the console shows, ported verbatim from dsh's
 * `src/disclaimer.js`.
 *
 * This is *not* the notice above: that one is the free lanes' own price, shown
 * once where the models first appear. This copy is the standalone/desktop
 * console's first-run dialog — the three channels this build mechanically
 * excludes (see `magpie-policy.ts`), and where responsibility sits for
 * everything a user does with a third party. Both DSH surfaces show it, so the
 * console serves the same object through `GET /api/management/disclaimer`.
 *
 * The copy is data, not markup: each surface renders it in its own idiom, so
 * there is exactly one place to change what the product says.
 */
export const DISCLAIMER_VERSION = 2

/** Channels this build does not offer, named for the reader. */
export const EXCLUDED_CHANNELS = Object.freeze([
  'WorkBuddy 国内版（workbuddy，亦称 CodeBuddy）',
  'WorkBuddy 国际版（workbuddy-ai）',
  '华为云 Huawei Cloud MaaS（huaweicloud，含 Token Plan）',
])

export const DISCLAIMER = Object.freeze({
  version: DISCLAIMER_VERSION,
  title: '使用须知与免责声明',
  subtitle: '关于本插件未提供的渠道，以及你需要知道的责任边界',
  intro: '本插件是一个个人学习与技术研究项目，用于学习模型网关、协议适配与本地路由的实现方式，按「现状」提供，不构成任何商业服务或产品承诺。',
  sections: Object.freeze([
    {
      id: 'excluded',
      heading: '本插件不提供这三个渠道',
      body: '本插件不包含、也不提供 WorkBuddy 国内版（workbuddy，亦称 CodeBuddy）、WorkBuddy 国际版（workbuddy-ai）与华为云 Huawei Cloud MaaS（huaweicloud，含 Token Plan）。这三者在插件端与桌面端均被移除：渠道列表、预设、登录入口、插件市场与模型目录里都不会出现，也无法通过导入配置或安装第三方插件启用。目录中看不到它们不是故障，是本项目的明确取舍，后续更新不会重新引入。',
    },
    {
      id: 'responsibility',
      heading: '使用第三方渠道与我们无关',
      body: '你若在本插件之外通过任何方式使用上述渠道或其他第三方服务，包括自行配置地址、导入凭据、安装第三方软件或登录他人账号，均属于你的个人行为，与本项目作者及团队无关。我们不参与、不背书、不提供支持，也不对其可用性、合规性或任何后果承担任何责任。',
    },
    {
      id: 'accounts',
      heading: '账号与凭据由你自己负责',
      body: '本插件只在你本机保存你主动导入的凭据，不会上传到任何服务器。请确保你使用这些账号的方式符合对应服务商的条款与所在地法律；由此产生的封禁、扣费、数据风险或其他损失，由使用者自行承担。',
    },
    {
      id: 'no-warranty',
      heading: '不提供任何担保',
      body: '本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。',
    },
    {
      id: 'lawful',
      heading: '请合法合规使用',
      body: '本项目仅用于个人学习与技术研究。请勿将其用于违反服务商条款、规避授权限制、批量滥用额度或其他违法用途。因使用方式不当引发的争议、索赔或法律责任，均由使用者自行承担。',
    },
  ]),
  accept: '我已阅读并了解',
  reopen: '查看免责声明',
})

/**
 * Whether a stored acknowledgement matches the current copy version.
 *
 * The acknowledgement rides the settings store (`disclaimerAck`), not a private
 * file: the console writes it through the same atomic settings path as every
 * other preference, so a user who acknowledged on the console is acknowledged
 * on the desktop shell too — the two surfaces share one setting.
 */
export function disclaimerAcknowledged(settings: unknown): boolean {
  return Number((settings as { disclaimerAck?: unknown } | null | undefined)?.disclaimerAck) === DISCLAIMER_VERSION
}

/**
 * The notice itself — short on purpose, and factual: what is free, what it
 * costs, and what not to send.
 */
export function noticeText() {
  return [
    'Our Free Model: free models from two third-party lanes.',
    'ofm-kilo — the upstream states free-pool prompts may be logged and used to improve its services.',
    'ofm-opencode — free tier metered per session/IP, so a shared network can spend it.',
    'Do not send passwords, keys, personal data or anything you would not hand to a third party.',
    'Each lane\'s terms are yours to follow. Details: pi-extension/README.md',
  ].join('\n')
}
