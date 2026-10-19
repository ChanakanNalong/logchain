/**
 * Rules for the Logs search box, shared by the page and the mock backend
 * (lib/mock/index.ts) so both search for the same text. The real backend
 * matches `message ILIKE '%q%'` literally, so text copied from chat apps or
 * documents has to be brought back to what the logs actually contain.
 * Runs of spaces are kept: a log may really hold two spaces in a row.
 */

const NBSP = /[   ]/g;
const DOUBLE_QUOTES = /[“”„‟]/g;
const SINGLE_QUOTES = /[‘’‚‛]/g;
/** newlines and tabs — a one-line input would drop newlines, gluing the words together */
const BREAKS = /\r\n|[\r\n\t]/g;
/** an ellipsis left at the end (typed, or copied from a cut-off text) is not in the log */
const TRAILING_ELLIPSIS = /…+\s*$/;

/** What the box shows while typing / after a paste — not trimmed, so typing a space still works */
export function normalizeSearchInput(s: string): string {
  return s
    .replace(BREAKS, " ")
    .replace(NBSP, " ")
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(TRAILING_ELLIPSIS, "");
}

/** The term actually sent as `q` */
export function normalizeSearch(s: string): string {
  return normalizeSearchInput(s).trim();
}
