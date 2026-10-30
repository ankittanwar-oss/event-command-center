import { api } from "../api.js";
import { sheetSection } from "./sheet.js";
import { openLead } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, hsLink, table } from "../ui.js";

const FLAG_LABEL: Record<string, string> = {
  contact_without_company: "Contact has no associated company",
  company_not_synced: "Company could not be read",
  temperature_missing: "Lead temperature not set on company",
  temperature_unmapped_value: "Lead temperature value not mapped to Hot/Warm (e.g. Surging)",
  sdr_missing: "Company has no SDR owner",
  sdr_not_on_roster: "SDR owner is not on the approved roster (AE or former SDR)",
  allocation_date_missing: "SDR assigned but allocation date unknown",
  event_date_missing: "Event date missing",
  event_uncategorized: "Event could not be categorised",
  icp_tier_missing: "ICP tier missing",
};

export async function qualityView(route: Route): Promise<HTMLElement> {
  const flag = route.extra.get("flag") ?? "";
  const [d, sheet] = await Promise.all([api("data-quality", { ...filterParams(route.filters), flag }), sheetSection().catch(() => h("div"))]);
  const flags = Object.entries(d.flags as Record<string, number>).sort((a, b) => b[1] - a[1]);
  return h("div", null,
    h("div", { class: "banner note" }, "Region and SDR filters are not applied here: data issues often mean the region or SDR is unknown."),
    sheet,
    h("div", { class: "grid2" },
      h("div", null,
        h("h2", null, "Issues", h("span", { class: "sub" }, `${fmt.n(d.totalLeads)} registrations checked`)),
        h("div", { class: "card" }, table<any>([
          { key: "label", label: "Issue", wrap: true, render: (r) => h("span", { class: "link", onclick: () => { location.hash = buildHash("quality", route.filters, { flag: r.key }); } }, r.label) },
          { key: "count", label: "Records", num: true },
        ], flags.map(([k, v]) => ({ key: k, label: FLAG_LABEL[k] ?? k, count: v })), { initialSort: "count" }))),
      h("div", null,
        h("h2", null, "Why leads are not eligible"),
        h("div", { class: "card" }, table<any>([{ key: "key", label: "Reason", wrap: true }, { key: "count", label: "Records", num: true }], d.ineligibleReasons, { initialSort: "count" })))),
    h("div", { class: "grid2" },
      h("div", null,
        h("h2", null, "SDR owners not on the roster", h("span", { class: "sub" }, "Excluded from SDR reporting")),
        h("div", { class: "card" }, table<any>([{ key: "ownerId", label: "HubSpot owner id", render: (r) => h("span", { class: "mono" }, r.ownerId) }, { key: "count", label: "Registrations", num: true }], d.unmappedSdrs, { initialSort: "count", empty: "None" }))),
      h("div", null,
        h("h2", null, "Lead temperature values"),
        h("div", { class: "card" }, table<any>([{ key: "k", label: "Value on company" }, { key: "v", label: "Registrations", num: true }],
          Object.entries(d.temperatureValues).map(([k, v]) => ({ k, v })), { initialSort: "v" })))),
    d.attendanceSuspect.length ? [h("h2", null, "Attendance to check"), h("div", { class: "card" }, table<any>([{ key: "name", label: "Event", wrap: true }, { key: "registered", label: "Registered = attended", num: true }], d.attendanceSuspect))] : null,
    flag ? [
      h("h2", null, FLAG_LABEL[flag] ?? flag, h("span", { class: "sub" }, `${d.flagRows.length} records`)),
      h("div", { class: "card" }, table<any>([
        { key: "contactName", label: "Contact", render: (r) => [h("span", { class: "link", onclick: () => openLead(r.eventId, r.contactId) }, r.contactName), hsLink("contact", r.contactId)] },
        { key: "companyName", label: "Company", render: (r) => [r.companyName ?? "–", hsLink("company", r.companyId)] },
        { key: "eventName", label: "Event", wrap: true },
        { key: "sdrOwnerRaw", label: "SDR owner id", render: (r) => r.sdrOwnerRaw ?? "–" },
        { key: "temperatureRaw", label: "Temperature", render: (r) => r.temperatureRaw ?? "–" },
        { key: "icpTier", label: "ICP", render: (r) => r.icpTier ?? "–" },
      ], d.flagRows)),
    ] : null,
  );
}
