import type { Rules } from "./config.js";
import type { EventCategory } from "./types.js";

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  owned: "Owned Events",
  sponsored: "Sponsored Events",
  webinar: "Webinars",
  roundtable: "Roundtables",
  uncategorized: "Uncategorized",
};

/**
 * Exactly one category per event (no double counting). Order of precedence:
 *   1. explicit override by HubSpot event id (rules.eventCategoryOverrides)
 *   2. HubSpot "event_type" property when it names a roundtable or webinar
 *   3. name rules in order (roundtable, webinar, owned, sponsored)
 *   4. "uncategorized" – surfaced in the Data Quality view, never guessed
 */
export function categorizeEvent(
  id: string,
  name: string,
  eventType: string | null,
  rules: Rules,
): { category: EventCategory; source: "override" | "rule" | "none" } {
  const override = rules.eventCategoryOverrides[id];
  if (override) return { category: override, source: "override" };
  const type = (eventType || "").toLowerCase();
  if (/round ?table/.test(type)) return { category: "roundtable", source: "rule" };
  if (/webinar/.test(type)) return { category: "webinar", source: "rule" };
  const n = (name || "").toLowerCase();
  for (const r of rules.eventCategoryRules) {
    if (new RegExp(r.pattern, "i").test(n)) return { category: r.category, source: "rule" };
  }
  return { category: "uncategorized", source: "none" };
}
