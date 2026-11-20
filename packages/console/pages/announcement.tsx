/**
 * Announcement modal and onboarding gate.
 *
 * Ported from dsh's `client.js` Announcement and AnnouncementGate functions.
 *
 * @module pi-extension/client/pages/announcement.tsx
 */

import {
  createElement as h,
  useEffect,
  useRef,
  useState,
  Fragment,
} from "react";
import { api, post } from "../api.js";
import { showToast, showUrgentModal, osNotify } from "../toast.js";
import { Button } from "../chrome.js";

const NS = "settings.ourFreeModel";
const PAGES = [
  "ann.preamble",
  "ann.newlane",
  "ann.models",
  "ann.steps",
  "ann.features",
  "ann.updates",
];

function announcementPortalHost() {
  let host = document.querySelector("[data-ofm-announcement-root]");
  if (host === null) {
    host = document.createElement("div");
    host.setAttribute("data-ofm-announcement-root", "true");
    document.body.appendChild(host);
  }
  return host;
}

function list(t, keys) {
  return keys.map((key) => h("li", { key }, t(key)));
}

function PageBody(props) {
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
      .sort((a, b) => (a.route === null ? 1 : 0) - (b.route === null ? 1 : 0));
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
          .map((m) =>
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
      rows.some((m) => m.availability === "region-blocked")
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

export function Announcement(props) {
  const { t, complete, openSection, page, setPage, summary, acknowledged } =
    props;
  useEffect(() => {
    if (acknowledged) complete();
  }, [acknowledged, complete]);
  const host = acknowledged ? null : announcementPortalHost();
  useEffect(
    () => () => {
      if (host && host.parentNode !== null) host.parentNode.removeChild(host);
    },
    [host],
  );
  if (acknowledged) return null;
  const last = page === PAGES.length - 1;
  const finish = async () => {
    try {
      await post(
        `/announcement/ack?version=${encodeURIComponent(summary?.announcementVersion ?? "")}`,
      );
    } catch {
      /* ack is best effort */
    }
    complete();
  };
  return h(
    Fragment,
    null,
    ReactDOM.createPortal(
      h(
        "div",
        { className: "ofm_scrim" },
        h(
          "div",
          {
            className: "ofm_ann",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": t("title"),
          },
          h(
            "div",
            { className: "ofm_annhead" },
            h("h2", { className: "ofm_anntitle" }, t("title")),
            h("p", { className: "ofm_annsub" }, t(PAGES[page])),
          ),
          h(
            "div",
            { className: "ofm_steps", "aria-hidden": "true" },
            PAGES.map((key, index) =>
              h("span", {
                key,
                className: "ofm_step",
                "data-on": index <= page ? "true" : "false",
              }),
            ),
          ),
          h(
            "div",
            { className: "ofm_annbody" },
            h(PageBody, { page, t, summary }),
          ),
          h(
            "div",
            { className: "ofm_annfoot" },
            h(
              "span",
              { className: "ofm_note" },
              t("ann.page")
                .replace("{n}", page + 1)
                .replace("{total}", PAGES.length),
            ),
            h("span", { className: "spacer" }),
            page === 0
              ? h(Button, { kind: "ghost", onClick: finish }, t("ann.later"))
              : h(
                  Button,
                  {
                    kind: "ghost",
                    onClick: () => setPage((p) => Math.max(0, p - 1)),
                  },
                  "‹",
                ),
            last
              ? h(
                  Button,
                  {
                    kind: "primary",
                    onClick: async () => {
                      await finish();
                      openSection?.("our-free-model");
                    },
                  },
                  t("ann.openSettings"),
                )
              : h(
                  Button,
                  {
                    kind: "primary",
                    onClick: () =>
                      setPage((p) => Math.min(PAGES.length - 1, p + 1)),
                  },
                  "›",
                ),
          ),
        ),
      ),
      host,
    ),
  );
}

export function AnnouncementGate(props) {
  const { t, complete, openSection, explicit } = props;
  const [ack, setAck] = useState(undefined);
  const [summary, setSummary] = useState(undefined);
  const [page, setPage] = useState(0);
  useEffect(() => {
    let alive = true;
    api("/announcement")
      .then((payload) => {
        if (alive) setAck(payload);
      })
      .catch(() => {
        if (alive) setAck({ acknowledged: true, version: "" });
      });
    api("/summary")
      .then((payload) => {
        if (alive) setSummary(payload);
      })
      .catch(() => {});
    const timer = setTimeout(() => {
      if (alive)
        setAck((current) => current ?? { acknowledged: true, version: "" });
    }, 3000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const acknowledged = ack?.acknowledged === true && explicit !== true;
  useEffect(() => {
    if (ack === undefined) return;
    if (acknowledged) complete?.();
  }, [ack, acknowledged, complete]);
  if (ack === undefined || acknowledged) return null;
  return h(Announcement, {
    t,
    complete,
    openSection,
    page,
    setPage,
    summary,
    acknowledged: false,
  });
}

import { kilo } from "../api.js";
import ReactDOM from "react-dom";
