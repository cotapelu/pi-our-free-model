/**
 * Feedback page: GitHub-backed feedback submission with device code auth.
 *
 * Ported from dsh's `client.js` FeedbackPage.
 *
 * @module pi-extension/client/pages/feedback.tsx
 */

import {
  createElement as h,
  useCallback,
  useEffect,
  useRef,
  useState,
  Fragment,
} from "react";
import { api, post } from "../api.js";
import { showToast } from "../toast.js";
import { Button, Pill, Section, Switch } from "../chrome.js";

export function FeedbackPage({ t, version }) {
  const [auth, setAuth] = useState({ signedIn: false, login: "" });
  const [login, setLogin] = useState(undefined);
  const [kind, setKind] = useState("bug");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState("");
  const pollTimer = useRef(undefined);
  const live = useRef(true);

  useEffect(
    () => () => {
      live.current = false;
      clearTimeout(pollTimer.current);
    },
    [],
  );

  const readAuth = useCallback(async () => {
    try {
      const value = await api("/feedback");
      if (live.current) setAuth(value);
    } catch {
      /* auth read failure shouldn't block the form */
    }
  }, []);
  useEffect(() => {
    void readAuth();
  }, [readAuth]);

  const signIn = async () => {
    if (busy) return;
    setBusy("signin");
    setError("");
    setStatus("");
    try {
      const value = await post("/feedback/start", undefined, 30_000);
      if (!live.current) return;
      setLogin(value);
      setStatus(t("fb.opened"));
      try {
        window.open(value.verifyUrl, "_blank", "noopener,noreferrer");
      } catch {
        /* fallback */
      }
    } catch (reason) {
      if (live.current) setError(String(reason?.message ?? reason));
    } finally {
      if (live.current) setBusy("");
    }
  };

  useEffect(() => {
    if (login === undefined) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const value = await post(
          "/feedback/poll",
          { session: login.session },
          30_000,
        );
        if (cancelled || !live.current) return;
        if (value.status === "ok") {
          setLogin(undefined);
          setAuth({ signedIn: true, login: value.login ?? "" });
          setStatus(t("fb.signedIn"));
          return;
        }
        if (value.status === "expired") {
          setLogin(undefined);
          setError(t("fb.expired"));
          return;
        }
        if (value.status === "denied") {
          setLogin(undefined);
          setError(t("fb.denied"));
          return;
        }
        pollTimer.current = setTimeout(() => {
          void tick();
        }, 3000);
      } catch (reason) {
        if (cancelled || !live.current) return;
        setLogin(undefined);
        setError(String(reason?.message ?? reason));
      }
    };
    pollTimer.current = setTimeout(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(pollTimer.current);
    };
  }, [login, t]);

  const signOut = async () => {
    setBusy("signout");
    setError("");
    setStatus("");
    try {
      const value = await post("/feedback/signout");
      if (live.current) {
        setAuth(value);
        setStatus(t("fb.signedOut"));
        setSent("");
      }
    } catch (reason) {
      if (live.current) setError(String(reason?.message ?? reason));
    } finally {
      if (live.current) setBusy("");
    }
  };

  const submit = async () => {
    if (busy) return;
    setBusy("submit");
    setError("");
    setStatus("");
    setSent("");
    try {
      const result = await post(
        "/feedback/submit",
        {
          kind,
          title,
          detail,
          platform: navigator.platform,
          page: "feedback",
        },
        30_000,
      );
      if (!live.current) return;
      setTitle("");
      setDetail("");
      setSent(result.id);
      setStatus(t("fb.submitted"));
    } catch (reason) {
      if (!live.current) return;
      const stale = /登录已失效|sign-in has lapsed/.test(
        String(reason?.message ?? ""),
      );
      if (stale) {
        setAuth({ signedIn: false, login: "" });
        setError(t("fb.stale"));
        return;
      }
      setError(String(reason?.message ?? reason));
    } finally {
      if (live.current) setBusy("");
    }
  };

  const canSubmit = title.trim() !== "" && detail.trim() !== "" && busy === "";

  return h(
    "div",
    { className: "ofm_page" },
    h(
      "header",
      { className: "ofm_hero ofm_glass" },
      h(
        "div",
        { className: "ofm_pagehead" },
        h(
          "div",
          { className: "ofm_pagetitle" },
          h("h2", null, t("fb.title")),
          h("p", { className: "ofm_pagesub" }, t("fb.sub")),
        ),
        h(
          "div",
          { className: "ofm_pills" },
          h(
            Pill,
            { strong: true, tone: auth.signedIn ? "ok" : "warn" },
            auth.signedIn
              ? t("fb.signedInAs").replace("{login}", auth.login)
              : t("fb.notSignedIn"),
          ),
        ),
      ),
    ),
    auth.signedIn
      ? null
      : h(
          "div",
          { className: "ofm_panel ofm_rise" },
          h(
            "div",
            { className: "ofm_row" },
            h(
              Button,
              { kind: "primary", disabled: busy, onClick: signIn },
              busy === "signin" ? t("fb.signingIn") : t("fb.signIn"),
            ),
            h("span", { className: "ofm_note" }, t("fb.signInHint")),
          ),
        ),
    error
      ? h(
          "div",
          { className: "ofm_callout ofm_error ofm_rise" },
          h("div", null, error),
        )
      : null,
    status
      ? h(
          "div",
          {
            className: "ofm_callout ofm_rise" + (sent ? " ok" : ""),
            role: "status",
          },
          status,
        )
      : null,
    h(
      "div",
      { className: "ofm_panel ofm_rise" },
      h(
        "div",
        { className: "ofm_row" },
        h(
          "span",
          { className: "ofm_note", style: { minWidth: 90 } },
          t("fb.kind"),
        ),
        h(
          "div",
          { className: "ofm_seg", role: "group" },
          [
            ["bug", t("fb.kind.bug")],
            ["feature", t("fb.kind.feature")],
            ["question", t("fb.kind.question")],
          ].map(([key, label]) =>
            h(
              "button",
              {
                key,
                type: "button",
                "aria-pressed": kind === key ? "true" : "false",
                onClick: () => setKind(key),
              },
              label,
            ),
          ),
        ),
      ),
      h(
        "div",
        { className: "ofm_row" },
        h(
          "span",
          { className: "ofm_note", style: { minWidth: 90 } },
          t("fb.title"),
        ),
        h("input", {
          className: "ofm_input",
          value: title,
          onChange: (e) => setTitle(e.target.value),
          placeholder: t("fb.titlePlaceholder"),
          style: { flex: 1 },
        }),
      ),
      h(
        "div",
        { className: "ofm_row" },
        h(
          "span",
          { className: "ofm_note", style: { minWidth: 90 } },
          t("fb.detail"),
        ),
        h("textarea", {
          className: "ofm_input",
          value: detail,
          onChange: (e) => setDetail(e.target.value),
          placeholder: t("fb.detailPlaceholder"),
          style: { flex: 1, minHeight: 100 },
        }),
      ),
      h(
        "div",
        { className: "ofm_row" },
        h(
          Button,
          { kind: "primary", disabled: !canSubmit, onClick: submit },
          busy === "submit" ? t("fb.submitting") : t("fb.submit"),
        ),
        auth.signedIn
          ? h(
              Button,
              { kind: "ghost", disabled: busy, onClick: signOut },
              t("fb.signOut"),
            )
          : null,
        sent
          ? h(
              "span",
              { className: "ofm_note" },
              t("fb.sent").replace("{id}", sent),
            )
          : null,
      ),
    ),
  );
}
