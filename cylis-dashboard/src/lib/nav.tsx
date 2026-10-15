"use client";

/**
 * Page switching for views that need to send the user elsewhere (the log
 * drawer → Alerts / Verify). App has no router — every page lives on `/` and
 * swaps on state — so pages share one query string. Each page owns its own
 * keys and must merge, never overwrite, the rest (see `mergeQuery`).
 */
import { createContext, useCallback, useContext } from "react";

/** Query keys pages use to hand each other context */
export const QUERY_KEYS = {
  /** the page on screen (NAV_ITEMS id) — survives F5 */
  view: "view",
  /** Alerts: expand this alert */
  alert: "alert",
  /** Verify: the log whose proof to show */
  proofLog: "proofLog",
} as const;

/**
 * Keys each page owns. Switching page drops the keys of every page, so one
 * page's filters never leak into another; a cross-page link passes the
 * target's keys again in the same `navigate` call.
 */
export const PAGE_QUERY_KEYS: Record<string, readonly string[]> = {
  logs: ["q", "source", "severity", "eventType", "limit", "offset"],
  alerts: [QUERY_KEYS.alert],
  verify: [QUERY_KEYS.proofLog],
};

export type QueryUpdate = Record<string, string | null | undefined>;

/** Current query string with `updates` applied (null/undefined/"" deletes a key) */
export function mergeQuery(updates: QueryUpdate): string {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === "") params.delete(k);
    else params.set(k, v);
  }
  return params.toString();
}

/**
 * Change only the given query keys. Uses the native history API, which Next
 * syncs into useSearchParams: unlike router.replace it lands synchronously,
 * so two calls in the same tick (navigate + a page's mount effect) both stick.
 */
export function replaceQuery(updates: QueryUpdate) {
  const qs = mergeQuery(updates);
  const { pathname, search } = window.location;
  if (`?${qs}` === search || (!qs && !search)) return;
  window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
}

export function useReplaceQuery() {
  return useCallback((updates: QueryUpdate) => replaceQuery(updates), []);
}

/** `?view=` of the URL the app was opened with */
export function readViewFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(QUERY_KEYS.view);
}

type Navigate = (pageId: string, query?: QueryUpdate) => void;

export const NavContext = createContext<Navigate>(() => {});

/** Switch page (by NAV_ITEMS id) and set query keys for the target page in one go */
export function useNavigate(): Navigate {
  return useContext(NavContext);
}
