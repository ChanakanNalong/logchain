"use client";

/**
 * Page switching for views that need to send the user elsewhere (the log
 * drawer → Alerts / Verify). App has no router — every page lives on `/` and
 * swaps on state — so pages share one query string. Each page owns its own
 * keys and must merge, never overwrite, the rest (see `mergeQuery`).
 */
import { createContext, useCallback, useContext } from "react";
import { usePathname, useRouter } from "next/navigation";

/** Query keys pages use to hand each other context */
export const QUERY_KEYS = {
  /** Alerts: expand this alert */
  alert: "alert",
  /** Verify: the log whose proof to show */
  proofLog: "proofLog",
} as const;

type QueryUpdate = Record<string, string | null | undefined>;

/** Current query string with `updates` applied (null/undefined/"" deletes a key) */
export function mergeQuery(updates: QueryUpdate): string {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === "") params.delete(k);
    else params.set(k, v);
  }
  return params.toString();
}

/** `replace` the URL with only the given keys changed */
export function useReplaceQuery() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (updates: QueryUpdate) => {
      const qs = mergeQuery(updates);
      const next = qs ? `${pathname}?${qs}` : pathname;
      if (next !== `${pathname}${window.location.search}`) router.replace(next, { scroll: false });
    },
    [router, pathname],
  );
}

type Navigate = (pageId: string, query?: QueryUpdate) => void;

export const NavContext = createContext<Navigate>(() => {});

/** Switch page (by NAV_ITEMS id) and set query keys for the target page in one go */
export function useNavigate(): Navigate {
  return useContext(NavContext);
}
