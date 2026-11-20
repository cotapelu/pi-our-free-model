/**
 * The console shell: top nav with animated glider, page routing, and footer.
 *
 * Ported from dsh's `client.js` Shell function.
 *
 * @module pi-extension/client/pages/Shell.tsx
 */

import {
  createElement as h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
} from "react";
import { api, kilo, ago, copy } from "../api.js";
import { useAsync } from "../hooks.js";
import { showToast, osNotify } from "../toast.js";
import {
  Button,
  Pill,
  PageHero,
  Panel,
  Section,
  PanelSkeleton,
  PanelError,
  ModelCard,
  Roster,
  Heatmap,
  TrendChart,
  Sparkline,
} from "../chrome.js";
import { Switch } from "../chrome.js";
import { StarButton } from "../chrome.js";
import { Tank } from "../chrome.js";
import { EacAuth } from "../chrome.js";
import { useEacLogin } from "../chrome.js";
import { usePool, poolReading, capacityText } from "../chrome.js";
import { BRAND_ICON } from "../chrome.js";
import { CHANNEL_PROVIDERS } from "../chrome.js";
import { channelTransport, sameChannelTransport } from "../chrome.js";
import { SponsorBanner } from "../chrome.js";
import { FreePage } from "./settings.js";
import { EacPage } from "./settings.js";
import { ChannelsPage } from "./channels.js";
import { AggregatePage } from "./aggregate.js";
import { SaverPage } from "./saver.js";
import { RoutingPage } from "./routing.js";
import { LedgerPage } from "./ledger.js";
import { LogsPage } from "./logs.js";
import { GatewayPage } from "./gateway.js";
import { UpgradePage } from "./upgrade.js";
import { PicksPage } from "@ofm/core/picks";
import { ExtensionsPage } from "./extensions.js";
import { PluginsPage } from "./plugins.js";
import { WorkspacePage } from "./workspace.js";
import { FeedbackPage } from "./feedback.js";
import { Disclaimer } from "./disclaimer.js";
import { AnnouncementGate } from "./announcement.js";

const NS = "settings.ourFreeModel";
const TAB_KEY = "ofm.tab";
const EFFECTS_KEY = "ofm.effects";

const TABS = [
  "free",
  "eac",
  "channels",
  "aggregate",
  "workspace",
  "extensions",
  "plugins",
  "saver",
  "routing",
  "ledger",
  "logs",
  "gateway",
  "upgrade",
  "picks",
  "feedback",
];

/** Number of tokens that were free to the user across all time. */
function freePoolView(data) {
  const catalog = data.catalog ?? [];
  const counts = {
    available: 0,
    "region-blocked": 0,
    unavailable: 0,
    throttled: 0,
    unknown: 0,
    listed: 0,
  };
  let anonymous = 0;
  let kilo = 0;
  for (const model of catalog) {
    if (model.channel === "anonymous") {
      anonymous += 1;
      counts[model.availability] = (counts[model.availability] ?? 0) + 1;
    } else if (model.channel === "kilo") {
      kilo += 1;
      counts[model.availability] = (counts[model.availability] ?? 0) + 1;
    }
  }
  const total = anonymous + kilo;
  const selectable = catalog.filter(
    (m) =>
      (m.channel === "anonymous" || m.channel === "kilo") &&
      m.availability === "available",
  ).length;
  return { total, selectable, anonymous, kilo, counts };
}

export function Shell(props) {
  const {
    t,
    data,
    counts,
    summary,
    stats,
    eacAuth,
    setEacAuth,
    eacLogin,
    busy,
    setBusy,
    apply,
    bench,
    benches,
    ctx,
  } = props;
  const [tab, setTab] = useState(() => {
    try {
      const saved = window.localStorage?.getItem(TAB_KEY);
      return saved === "subscriptions"
        ? "workspace"
        : TABS.includes(saved)
          ? saved
          : "free";
    } catch {
      return "free";
    }
  });
  const [workspaceSection, setWorkspaceSection] = useState(() => {
    try {
      return window.localStorage?.getItem(TAB_KEY) === "subscriptions"
        ? "accounts"
        : window.localStorage?.getItem("ofm.workspace.section") === "accounts"
          ? "accounts"
          : "tools";
    } catch {
      return "tools";
    }
  });
  const [effects, setEffects] = useState(() => {
    try {
      return window.localStorage?.getItem(EFFECTS_KEY) === "on";
    } catch {
      return false;
    }
  });
  const toggleEffects = () =>
    setEffects((current) => {
      const next = !current;
      try {
        window.localStorage?.setItem(EFFECTS_KEY, next ? "on" : "off");
      } catch {
        /* current page still toggles */
      }
      return next;
    });
  const [disclaimer, setDisclaimer] = useState(undefined);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    api("/disclaimer")
      .then((payload) => {
        if (alive) setDisclaimer(payload);
      })
      .catch(() => {
        if (alive) setDisclaimer({ acknowledged: true });
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (disclaimer === undefined) return;
    if (disclaimer.acknowledged !== true) setDisclaimerOpen(true);
  }, [disclaimer]);
  const shellRef = useRef(null);
  const [active, setActive] = useState(true);
  useEffect(() => {
    let inViewport = true;
    const update = () => setActive(inViewport && document.hidden !== true);
    update();
    document.addEventListener?.("visibilitychange", update);
    const observer =
      typeof IntersectionObserver === "function" && shellRef.current
        ? new IntersectionObserver((entries) => {
            inViewport = entries.some((entry) => entry.isIntersecting);
            update();
          })
        : null;
    if (observer) observer.observe(shellRef.current);
    return () => {
      document.removeEventListener?.("visibilitychange", update);
      observer?.disconnect();
    };
  }, []);
  const tabRefs = useRef({});
  const [glider, setGlider] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const [catalogBusy, setCatalogBusy] = useState(false);
  const catalogPending = useRef(false);
  useEffect(() => {
    try {
      window.localStorage?.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable */
    }
    const measure = () => {
      const node = tabRefs.current[tab];
      if (node)
        setGlider({
          left: node.offsetLeft,
          top: node.offsetTop,
          width: node.offsetWidth,
          height: node.offsetHeight,
        });
    };
    measure();
    const node = tabRefs.current[tab];
    const observer =
      typeof ResizeObserver === "function" && node?.parentElement
        ? new ResizeObserver(measure)
        : null;
    if (observer) observer.observe(node.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tab, t.locale]);

  const runCatalog = async (path) => {
    if (catalogPending.current) return;
    catalogPending.current = true;
    setCatalogBusy(true);
    try {
      await post(path, undefined, 600_000);
      summary.reload();
      stats.reload();
    } catch (error) {
      showToast({
        title: t("settings.failed"),
        body: String(error?.message ?? error),
        tone: "warn",
      });
    } finally {
      catalogPending.current = false;
      setCatalogBusy(false);
    }
  };
  const refresh = () => runCatalog("/refresh");
  const reprobe = () => runCatalog("/reprobe");

  const tabs = [
    ["free", t("nav.tab.free"), freePoolView(data).total],
    [
      "eac",
      t("nav.tab.eac"),
      data.catalog.filter((m) => m.channel === "eac").length,
    ],
    ["channels", t("nav.tab.channels"), CHANNEL_PROVIDERS.length],
    [
      "aggregate",
      t("nav.tab.aggregate"),
      data.catalog.filter((m) => m.channel === "aggregate").length,
    ],
    [
      "workspace",
      t("nav.tab.workspace"),
      data.catalog.filter((m) => m.channel === "subscription").length,
    ],
    [
      "extensions",
      t("nav.tab.extensions"),
      (data.extensions?.installed ?? []).length,
    ],
    [
      "plugins",
      t("nav.tab.extensions"),
      (data.extensions?.installed ?? []).length,
    ],
    ["saver", t("nav.tab.saver"), null],
    [
      "routing",
      t("nav.tab.routing"),
      data.catalog.filter((m) => m.channel === "combo").length,
    ],
    ["ledger", t("nav.tab.ledger"), null],
    ["logs", t("nav.tab.logs"), null],
    ["gateway", t("nav.tab.gateway"), null],
    ["upgrade", t("nav.tab.upgrade"), null],
    ["picks", t("nav.tab.picks"), null],
    ["feedback", t("nav.tab.feedback"), null],
  ];
  const nav = h(
    "nav",
    { className: "ofm_nav" },
    h(
      "span",
      { className: "ofm_navbrand" },
      h(
        "span",
        { className: "ofm_navmark", "aria-hidden": "true" },
        h("img", { src: BRAND_ICON, alt: "" }),
      ),
      t("title"),
    ),
    h(
      "div",
      {
        className: "ofm_tabs",
        role: "tablist",
        "aria-label": t("title"),
        onKeyDown: (event) => {
          const steps = {
            ArrowDown: 1,
            ArrowRight: 1,
            ArrowUp: -1,
            ArrowLeft: -1,
          };
          if (
            !Object.hasOwn(steps, event.key) &&
            event.key !== "Home" &&
            event.key !== "End"
          )
            return;
          event.preventDefault();
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (tabs.findIndex(([id]) => id === tab) +
                    steps[event.key] +
                    tabs.length) %
                  tabs.length;
          setTab(tabs[index][0]);
          event.currentTarget.querySelectorAll('[role="tab"]')[index]?.focus();
        },
      },
      h("span", {
        className: "ofm_tabglider",
        "aria-hidden": "true",
        style: {
          transform: `translate(${glider.left}px, ${glider.top}px)`,
          width: `${glider.width}px`,
          height: `${glider.height}px`,
        },
      }),
      tabs.map(([id, label, num]) =>
        h(
          "button",
          {
            key: id,
            type: "button",
            role: "tab",
            "aria-selected": tab === id ? "true" : "false",
            className: "ofm_tab",
            "data-on": tab === id ? "true" : "false",
            tabIndex: tab === id ? 0 : -1,
            ref: (node) => {
              tabRefs.current[id] = node;
            },
            id: `ofm-tab-${id}`,
            "aria-controls": "ofm-workspace",
            onClick: () => setTab(id),
          },
          label,
          num === null
            ? null
            : h("span", { className: "ofm_tabnum" }, String(num)),
        ),
      ),
    ),
    h(
      "div",
      { className: "ofm_navtools", title: t("effects.hint") },
      h(Switch, {
        checked: effects,
        label: t("effects.enabled"),
        onChange: toggleEffects,
      }),
      h(StarButton, { t }),
    ),
  );

  const page =
    tab === "workspace"
      ? h(WorkspacePage, {
          t,
          summary,
          section: workspaceSection,
          onSelect: setWorkspaceSection,
        })
      : tab === "extensions"
        ? h(ExtensionsPage, { t, onChanged: summary.reload })
        : tab === "plugins"
          ? h(PluginsPage, { t, onChanged: summary.reload })
          : tab === "channels"
            ? h(ChannelsPage, { t, ctx, summary })
            : tab === "aggregate"
              ? h(AggregatePage, { t, summary })
              : tab === "saver"
                ? h(SaverPage, { t })
                : tab === "routing"
                  ? h(RoutingPage, { t })
                  : tab === "ledger"
                    ? h(LedgerPage, { t, ctx })
                    : tab === "logs"
                      ? h(LogsPage, { t, ctx })
                      : tab === "gateway"
                        ? h(GatewayPage, { t, ctx })
                        : tab === "upgrade"
                          ? h(UpgradePage, {
                              t,
                              settings: data.settings,
                              onApply: apply,
                              busy,
                            })
                          : tab === "picks"
                            ? h(PicksPage, { t, effects })
                            : tab === "feedback"
                              ? h(FeedbackPage, { t, version: data.version })
                              : tab === "eac"
                                ? h(EacPage, {
                                    t,
                                    data,
                                    counts,
                                    summary,
                                    stats,
                                    eacAuth,
                                    setEacAuth,
                                    eacLogin,
                                    busy,
                                    catalogBusy,
                                    apply,
                                    bench,
                                    benches,
                                    refresh,
                                    reprobe,
                                  })
                                : h(FreePage, {
                                    t,
                                    data,
                                    counts,
                                    summary,
                                    stats,
                                    eacAuth,
                                    eacLogin,
                                    busy,
                                    catalogBusy,
                                    apply,
                                    bench,
                                    benches,
                                    refresh,
                                    reprobe,
                                  });

  return h(
    "div",
    {
      className: "ofm_root ofm_shell",
      ref: shellRef,
      "data-ofm-effects": effects ? "on" : "off",
      "data-ofm-active": active ? "true" : "false",
    },
    nav,
    h(
      "div",
      {
        className: "ofm_workspace",
        id: "ofm-workspace",
        role: "tabpanel",
        "aria-labelledby": `ofm-tab-${tab}`,
      },
      page,
    ),
    h(
      "footer",
      { className: "ofm_shellfoot" },
      h(
        "button",
        {
          type: "button",
          className: "ofm_linkbtn",
          onClick: () => setDisclaimerOpen(true),
        },
        t("disclaimer.reopen"),
      ),
    ),
    disclaimerOpen && disclaimer !== undefined
      ? h(Disclaimer, {
          t,
          copy: disclaimer,
          onClose: () => setDisclaimerOpen(false),
        })
      : null,
  );
}

function post(path, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (res) => {
      clearTimeout(timer);
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      throw new Error(
        `${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
      );
    })
    .catch((err) => {
      clearTimeout(timer);
      throw err;
    });
}
