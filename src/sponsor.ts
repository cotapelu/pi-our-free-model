/**
 * Sponsor copy and the once-per-day claim.
 *
 * The copy is data and the day rule is arithmetic; both are portable to any
 * surface (the plugin's settings page, the standalone console, an API response).
 * `createSponsorUI` — the React page and the fold-away dialog, ~200 lines of
 * `createElement` — is **browser-only** and stays in the browser half; it is not
 * ported here and there is no stub pretending it is. See `../GOAL.md` §3 and the
 * console task in `../docs/TODO.md` §3-A.
 *
 * Two rules in the claim are the whole reason this module exists:
 *
 * 1. **A local calendar day, not a UTC one.** `toISOString()` would roll "today"
 *    over at UTC midnight, so every viewer east of Greenwich would see the
 *    notice twice a day and every viewer west of the international date line
 *    would miss one. `sponsorLocalDay` reads the machine's own calendar.
 * 2. **The write has to succeed before the show.** A storage write that fails —
 *    a privacy-mode window, a full quota — must suppress the notice rather than
 *    let a refresh re-show it forever. And a `show()` that throws rolls the
 *    storage back, so a failed render does not spend a day.
 *
 * Ported from dsh's `src/sponsor.js`.
 *
 * @module pi-extension/sponsor.js
 */

/** The sponsor copy, verbatim. Frozen: no surface edits the text it shows. */
export const SPONSOR = Object.freeze({
  title: '来自赞助商的广告',
  name: '北辰 API',
  url: 'https://beichenapi.com/register?aff=DL49WAC2DQNG',
  invite: 'DL49WAC2DQNG',
  greeting: '非常抱歉，亲爱的朋友：',
  paragraphs: Object.freeze([
    '为了租上服务器(超级贵，我们几个穷学生...)，让我们的插件正常使用，我们不得不找甲方接一点广告和挣一点佣金。非常抱歉，这都是为了提高服务器并发量和号池(100%是为了提升体验和维护运营)(突然爆火了，我们的小服务器直接炸，只好花钱换)，属实是无奈之举。若广告带来了不好的体验，还望体谅。',
    '本插件旨在给大家学习提供免费的算力，可能响应速度确实偏慢，但已经尽我们所能在提升。(肯定不是为了骗你star，最近的爆火，真是意料之外)如果响应太慢，可能是因为同时多人使用，还希望多多包涵。',
    '关于广告：广告是为了用服务器以及运营，并且其来源是大家使用中转站的抽成。(所以如果可以，请务必使用我们的邀请码呀ʕ  •ᴥ•ʔ)',
    '这是我们甲方的中转站，可以去官网首页有群链接找群主要体验，提供了优质的外国大模型算力(肯定是有品质保证的，不然也不敢挂合作)。如果希望使用外国优质大模型(大胆进行鹈鹕)测试，请务必考虑使用我们的链接。(求求大家了，不要跳过这个邀请码，我们的某位成员为此什么都会做的( •̥́ ˍ •̀ू ))',
    '(•‾̑⌣‾‑•)✧˖如果你希望使用相关付费算力，请务必考虑我们提供的渠道(其实这个渠道很不错的，价格和质量还不错)。我们的项目还会继续运营，以后也会免费下去。打这个广告也是迫不得已...(相信我们，真的不想圈米，只想运营好这个项目(所以租了个很贵的服务器)，(ó﹏ò｡) 对于讨厌广告的朋友实在抱歉啊)',
    '总之，还是感谢大家的支持(没办法以中转站的形式中支持也没关系，愿意点Star和使用，就已经让我们非常高兴)和陪伴，有了这种变相的赞助，我们肯定会保障ofm服务的越来越好。再次真心谢谢大家。',
  ]),
})

/** Where the last-shown day is remembered. Versioned, so a policy change re-shows once. */
export const SPONSOR_DAY_KEY = 'ofm.sponsor.last-shown.v1'

/**
 * The machine's own calendar day, `YYYY-MM-DD`.
 *
 * Not `toISOString()`: that rolls over at UTC midnight, which double-shows the
 * notice for anyone east of Greenwich and skips one for anyone west of the
 * international date line. `getFullYear`/`getMonth`/`getDate` are local by
 * definition, so no timezone arithmetic is needed (or wanted — a fixed offset
 * would break for the same reason in the other direction).
 */
export function sponsorLocalDay(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** What the claim needs, all injectable so the rule is testable without a window. */
export interface SponsorClaim {
  /** Where the day is remembered. A `setItem` that throws means "do not show". */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** A same-origin Web Lock, so two windows cannot both show. */
  locks?: { request: (name: string, callback: () => boolean | Promise<boolean>) => Promise<boolean> }
  now?: () => Date
  eligible?: () => boolean
  show?: () => void
}

/**
 * Claim today's one showing.
 *
 * @returns whether the caller just showed it — `false` for "already shown",
 *   "not eligible", "storage refused", or "another window holds the lock".
 */
export async function claimSponsorDay({
  storage, locks, now = () => new Date(), eligible = () => true, show = () => {},
}: SponsorClaim): Promise<boolean> {
  const claim = (): boolean => {
    if (eligible() !== true) return false
    const day = sponsorLocalDay(now())
    try {
      if (storage.getItem(SPONSOR_DAY_KEY) === day) return false
      // The write happens *before* the show, so a storage that refuses the write
      // also refuses the notice: a privacy-mode window would otherwise re-show
      // it on every refresh and every re-mount.
      const previous = storage.getItem(SPONSOR_DAY_KEY)
      storage.setItem(SPONSOR_DAY_KEY, day)
      try {
        show()
      } catch (error) {
        // A failed render must not spend the day: restore what was there before,
        // which is `null` for a first-time showing.
        if (previous === null) storage.removeItem(SPONSOR_DAY_KEY)
        else storage.setItem(SPONSOR_DAY_KEY, previous)
        throw error
      }
      return true
    } catch {
      // Any storage failure means "do not show", never "show twice".
      return false
    }
  }
  try {
    return locks?.request !== undefined ? await locks.request('ofm-sponsor-daily', claim) : claim()
  } catch {
    return false
  }
}

/** A sponsor row for an API response: the copy minus the internal bookkeeping. */
export function sponsorView(): { title: string; name: string; url: string; paragraphs: readonly string[] } {
  return { title: SPONSOR.title, name: SPONSOR.name, url: SPONSOR.url, paragraphs: SPONSOR.paragraphs }
}
