import { isRosterSdr, type Rules } from "./config.js";
import type { Activity, Touch } from "./types.js";

const CALL_STATUSES_NOT_A_TOUCH = new Set(["CANCELED", "QUEUED", "CALLING_CRM_USER", "CONNECTING", "RINGING", "IN_PROGRESS"]);

/**
 * Is this activity a qualifying OUTBOUND SDR touch?
 *  - Email: outgoing sales email (hs_email_direction = EMAIL). Incoming replies, opens, clicks and
 *    marketing emails are never touches (marketing emails are not CRM email engagements at all).
 *  - Call: logged call that is not inbound and not merely queued/cancelled.
 *  - LinkedIn: a logged LinkedIn communication, or a COMPLETED LinkedIn task. Open tasks never count.
 *  - Meetings are outcomes, not touches.
 * The activity must be owned by an approved roster SDR (or the assigned SDR, depending on rules).
 */
export function touchKind(a: Activity, assignedSdr: string | null, rules: Rules): Touch["kind"] | null {
  if (!a.ownerId) return null;
  const ownerOk = rules.countAnyRosterSdrTouch ? isRosterSdr(a.ownerId) : a.ownerId === assignedSdr;
  if (!ownerOk) return null;
  switch (a.kind) {
    case "EMAIL":
      return (a.direction || "EMAIL").toUpperCase() === "EMAIL" ? "Email" : null;
    case "CALL": {
      if ((a.direction || "").toUpperCase() === "INBOUND") return null;
      if (a.status && CALL_STATUSES_NOT_A_TOUCH.has(a.status.toUpperCase())) return null;
      return "Call";
    }
    case "LINKEDIN":
      return "LinkedIn";
    case "TASK":
      return (a.channel || "").toUpperCase() === "LINKED_IN" && (a.status || "").toUpperCase() === "COMPLETED" ? "LinkedIn" : null;
    default:
      return null;
  }
}

/**
 * Remove duplicates: the same HubSpot record is counted once, and copies of one send (BCC/logged twice)
 * collapse when kind, owner and minute all match. Two genuine emails on the same day remain two touches.
 */
export function dedupeTouches(touches: Touch[]): Touch[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const out: Touch[] = [];
  for (const t of [...touches].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (seenIds.has(t.activityId)) continue;
    const key = `${t.kind}|${t.ownerId}|${t.timestamp.slice(0, 16)}`;
    if (seenKeys.has(key)) continue;
    seenIds.add(t.activityId);
    seenKeys.add(key);
    out.push(t);
  }
  return out;
}

/** Contact-level touches: only activities associated with the contact itself. */
export function contactTouches(activities: Activity[], contactId: string, assignedSdr: string | null, rules: Rules): Touch[] {
  const out: Touch[] = [];
  for (const a of activities) {
    if (!a.contactIds.includes(contactId)) continue;
    const kind = touchKind(a, assignedSdr, rules);
    if (kind) out.push({ activityId: a.id, kind, timestamp: a.timestamp, ownerId: a.ownerId, source: "contact" });
  }
  return dedupeTouches(out);
}

/** Account-level touches: each activity counted once per company even when it reached several contacts. */
export function accountTouches(activities: Activity[], companyId: string, contactIds: Set<string>, assignedSdr: string | null, rules: Rules): Touch[] {
  const out: Touch[] = [];
  for (const a of activities) {
    const onCompany = a.companyIds.includes(companyId);
    const onContact = a.contactIds.some((c) => contactIds.has(c));
    if (!onCompany && !onContact) continue;
    const kind = touchKind(a, assignedSdr, rules);
    if (kind) out.push({ activityId: a.id, kind, timestamp: a.timestamp, ownerId: a.ownerId, source: onContact ? "contact" : "company" });
  }
  return dedupeTouches(out);
}
