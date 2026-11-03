import type { LeadFact } from "./types.js";

// ---------------------------------------------------------------------------------------------------------------
// Commercial dispositions: a verified reason to stop or defer routine outreach, at CONTACT or COMPANY scope.
// Sources:
//   - "hubspot":   a structured HubSpot value that already establishes the outcome (contact Lead Status, or the
//                  company "TAGS- SDR Categories" = Cool Off Accounts). Applied automatically, labelled as such.
//   - "dashboard": confirmed by a person in the dashboard (who, when, reason, evidence, optional revisit date).
// Nothing is inferred from an SDR's own outbound email. A contact-level disposition never closes the account.
// Dispositions never change the company's Account Intent Level and never remove outreach credit already earned.
// ---------------------------------------------------------------------------------------------------------------
export const DISPOSITION_CODES = {
  competitor_satisfied: "Paused: competitor satisfied",
  no_current_need: "Paused: not evaluating / no current need",
  revisit_later: "Paused: revisit later",
  not_interested: "Closed: not interested",
  not_qualified: "Closed: not a fit / not qualified",
  left_company: "Closed: contact left / bad contact data",
  do_not_contact: "Do not contact",
  other: "Paused: other verified reason",
} as const;
export type DispositionCode = keyof typeof DISPOSITION_CODES;

export interface Disposition {
  scope: "contact" | "company";
  id: string;                       // HubSpot contact id or company id
  code: DispositionCode;
  reason: string | null;            // short reason, e.g. "Uses Ironclad, happy with it; not changing CLM"
  evidence: string | null;          // where it was verified, e.g. "Email reply 27 Aug 2026"
  revisitDate: string | null;       // YYYY-MM-DD; after this date the disposition stops suppressing outreach
  confirmedBy: string | null;
  confirmedAt: string | null;
  source: "hubspot" | "dashboard";
}

export interface DispositionSet { contact: Map<string, Disposition>; company: Map<string, Disposition> }
export const emptyDispositions = (): DispositionSet => ({ contact: new Map(), company: new Map() });

const LEAD_STATUS: Record<string, DispositionCode> = {
  NOT_INTERESTED: "not_interested", "REPLIED NOT INTERESTED": "not_interested",
  NO_CONTACT: "do_not_contact", "DO NOT CONTACT": "do_not_contact",
  NOT_QUALIFIED: "not_qualified", "NOT A FIT/JOKER": "not_qualified",
  "CONTACT IN FUTURE": "revisit_later",
  POC_LEFT_THE_COMPANY: "left_company", "CHANGED JOB": "left_company", "BAD CONTACT INFO": "left_company",
};

/** Disposition in force for one lead record: dashboard-confirmed first, then structured HubSpot values. */
export function dispositionsFor(f: LeadFact, set: DispositionSet | undefined, today: string): { contact: Disposition | null; company: Disposition | null } {
  const live = (d: Disposition | undefined | null) => (d && (!d.revisitDate || d.revisitDate > today) ? d : null);
  let contact = live(set?.contact.get(f.contactId));
  if (!contact && f.contactLeadStatus) {
    const code = LEAD_STATUS[f.contactLeadStatus.toUpperCase()];
    if (code) contact = { scope: "contact", id: f.contactId, code, reason: `HubSpot Lead Status: ${f.contactLeadStatus}`, evidence: "Contact Lead Status (structured HubSpot property)", revisitDate: null, confirmedBy: null, confirmedAt: null, source: "hubspot" };
  }
  let company = f.companyId ? live(set?.company.get(f.companyId)) : null;
  if (!company && f.companyId && /cool off/i.test(f.accountIntent?.sdrCategory ?? "")) {
    company = { scope: "company", id: f.companyId, code: "revisit_later", reason: `TAGS- SDR Categories: ${f.accountIntent!.sdrCategory}`, evidence: "Company SDR category (structured HubSpot property)", revisitDate: null, confirmedBy: null, confirmedAt: null, source: "hubspot" };
  }
  return { contact, company };
}
