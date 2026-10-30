import { DEFAULT_RULES, mergeRules, type Rules } from "@ecc/core";
import { env } from "./env.js";
import { getSetting } from "./db/repo.js";
import { log } from "./log.js";

/**
 * Effective business rules = code defaults  <  RULES_JSON env variable  <  rules saved from the Admin page.
 * Every change is visible on the Admin page, and the rules used for each computation are stored in facts_meta.
 */
export async function loadRules(): Promise<Rules> {
  let rules = DEFAULT_RULES;
  if (env.rulesJson) {
    try { rules = mergeRules(rules, JSON.parse(env.rulesJson)); }
    catch (e) { log.error("RULES_JSON is not valid JSON – ignored", { error: String(e) }); }
  }
  const saved = await getSetting<unknown>("rules").catch(() => null);
  if (saved) rules = mergeRules(rules, saved);
  return rules;
}

/** Validate a rules patch before saving. Returns a list of problems (empty = valid). */
export function validateRules(r: Rules): string[] {
  const errs: string[] = [];
  for (const t of ["Hot", "Warm"] as const) {
    const c = r.cadence[t];
    if (!c) { errs.push(`cadence.${t} missing`); continue; }
    if (!(c.firstTouchBusinessDays >= 0 && c.firstTouchBusinessDays <= 60)) errs.push(`cadence.${t}.firstTouchBusinessDays must be 0–60`);
    if (!(c.stallBusinessDays >= 1 && c.stallBusinessDays <= 120)) errs.push(`cadence.${t}.stallBusinessDays must be 1–120`);
    if (!Array.isArray(c.cadence) || !c.cadence.length) errs.push(`cadence.${t}.cadence must list checkpoints`);
  }
  if (!r.temperature.hotValues.length) errs.push("temperature.hotValues must not be empty");
  if (!r.temperature.warmValues.length) errs.push("temperature.warmValues must not be empty");
  for (const rule of r.eventCategoryRules) {
    try { new RegExp(rule.pattern, "i"); } catch { errs.push(`Invalid event category pattern: ${rule.pattern}`); }
  }
  return errs;
}
