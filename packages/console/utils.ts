/**
 * Utility functions for reload notices, announcements, and locale handling.
 *
 * Ported from dsh's `client.js` reloadNoticePlan, announceReloadNotice, PageBody, localeTag.
 *
 * @module pi-extension/client/utils.ts
 */

import { createElement as h, Fragment } from "react";
import { api, post, kilo } from "./api.js";
import { showToast } from "./toast.js";

const NS = "settings.ourFreeModel";

/** Read the active locale tag from the host context or document. */
export function localeTag(ctx: any): string {
  try {
    const snapshot =
      typeof ctx.locale?.getLocale === "function"
        ? ctx.locale.getLocale()
        : ctx.locale?.getSnapshot?.();
    const value = snapshot?.active ?? ctx.locale?.locale;
    return typeof value === "string"
      ? value
      : document.documentElement.lang || "en";
  } catch {
    return "en";
  }
}

/**
 * Decide whether this page announces the last hot reload.
 */
export function reloadNoticePlan(
  meta: any,
  cached: any,
): { at: number; show: boolean } {
  const at = Number(meta?.reloadedAt ?? 0);
  if (!Number.isFinite(at) || at <= 0) return { at: 0, show: false };
  const seen = Number(meta?.reloadNoticeSeen ?? 0);
  if (seen === at) return { at, show: false };
  if (cached !== undefined && cached !== null && String(at) === String(cached))
    return { at, show: false };
  return { at, show: true };
}

/** Show the toast at most once, and retry any missing server acknowledgement. */
export async function announceReloadNotice(
  meta: any,
  cached: any,
  {
    show,
    ack,
    remember,
  }: {
    show: (plan: any) => void;
    ack: (at: number) => Promise<void>;
    remember: (at: number) => void;
  },
): Promise<{ at: number; show: boolean; shown: boolean }> {
  const plan = reloadNoticePlan(meta, cached);
  if (plan.at <= 0) return { ...plan, shown: false };
  remember(plan.at);
  if (plan.show) show(plan);
  if (Number(meta?.reloadNoticeSeen ?? 0) !== plan.at) {
    try {
      await ack(plan.at);
    } catch {
      /* retry on the next check without repeating the toast */
    }
  }
  return { ...plan, shown: plan.show };
}

const PAGES = [
  "ann.preamble",
  "ann.newlane",
  "ann.models",
  "ann.steps",
  "ann.features",
  "ann.updates",
];

function list(t: (key: string) => string, keys: string[]): any[] {
  return keys.map((key) => h("li", { key }, t(key)));
}

/** Renders the announcement page body for a given page index. */
export function PageBody(props: {
  page: number;
  t: (key: string) => string;
  summary: any;
}): any {
  const { page, t, summary } = props;
  if (page === 0)
    return h(
      Fragment,
      null,
      h("h3", null, t("ann.preamble")),
      h("p", null, t("ann.pitch")),
      h("ul", null, list(t, ["ann.p1", "ann.p2", "ann.p3"])),
    );
  if (page === 1)
    return h(
      Fragment,
      null,
      h("h3", null, t("ann.newlane")),
      h("ul", null, list(t, ["ann.n1", "ann.n2", "ann.n3"])),
    );
  if (page === 2) {
    const rows = (summary?.catalog ?? [])
      .slice()
      .sort(
        (a: any, b: any) =>
          (a.route === null ? 1 : 0) - (b.route === null ? 1 : 0),
      );
    if (rows.length === 0) return h("p", null, t("loading"));
    return h(
      Fragment,
      null,
      h("h3", null, t("ann.models")),
      h(
        "div",
        { className: "ofm_kv" },
        rows
          .slice(0, 8)
          .map((m: any) =>
            h(
              "div",
              { key: m.id, className: "ofm_kvc" },
              h("b", null, m.name),
              h(
                "span",
                null,
                `${t(`state.${m.availability}`)} · ${m.vision ? t("tag.vision") : t("tag.text")} · ${kilo(m.contextWindow)}`,
              ),
            ),
          ),
      ),
      rows.some((m: any) => m.availability === "region-blocked")
        ? h("p", { className: "ofm_note" }, t("hint.region"))
        : null,
    );
  }
  if (page === 3)
    return h(
      Fragment,
      null,
      h("h3", null, t("ann.steps")),
      h("ul", null, list(t, ["ann.s1", "ann.s2", "ann.s3", "ann.s4"])),
    );
  if (page === 4)
    return h(
      Fragment,
      null,
      h("h3", null, t("ann.features")),
      h(
        "ul",
        null,
        list(t, ["ann.f1", "ann.f2", "ann.f3", "ann.f4", "ann.f5"]),
      ),
    );
  return h(
    Fragment,
    null,
    h("h3", null, t("ann.updates")),
    h("ul", null, list(t, ["ann.u1", "ann.u2", "ann.u3", "ann.u4"])),
  );
}
