import { api } from "../api.js";
import { openCustom } from "../drawer.js";
import { fmt, h, hsLink, table } from "../ui.js";

/** Roundtable Google Sheet status and reconciliation with HubSpot (shown on the Data Quality page). */
export async function sheetSection(): Promise<HTMLElement> {
  const d = await api("roundtable-sheet");
  const r = d.report;
  const status = !d.configured
    ? h("div", { class: "banner note" }, "Roundtable sheet not connected yet: set GOOGLE_SERVICE_ACCOUNT_JSON on the Railway services and share the sheet with the service account (Viewer). Until then roundtable registrations and attendance come from HubSpot.")
    : r?.error && !r?.tabs?.length
      ? h("div", { class: "banner warn" }, `Roundtable sheet could not be read: ${r.error}`)
      : h("div", { class: "muted", style: "margin-bottom:8px" },
        r?.readAt ? `Read ${fmt.ago(r.readAt)} · ` : r?.error ? h("span", { class: "warnr-t" }, `Last read failed (${r.error}); using the previous copy · `) : "Not read yet (runs with the next sync) · ",
        r?.authoritative ? "The sheet is the source of truth for registrations and attendance of matched roundtables." : "Sheet rows are added to HubSpot registrations; sheet attendance is used.",
        d.serviceAccountEmail ? ` Shared with ${d.serviceAccountEmail}.` : "");
  const tabs = r?.tabs ?? [];
  return h("div", null,
    h("h2", null, "Roundtable sheet", h("span", { class: "sub" }, h("a", { href: d.sheetUrl, target: "_blank", rel: "noopener noreferrer", class: "hs" }, "Open sheet ↗"))),
    status,
    tabs.length ? h("div", { class: "card" }, table<any>([
      { key: "tab", label: "Sheet tab", wrap: true },
      { key: "eventName", label: "HubSpot event", wrap: true, render: (t) => `${t.eventName} · ${fmt.day(t.eventDate)}` },
      { key: "registrants", label: "Registrants", num: true },
      { key: "attendedYes", label: "Attended", num: true },
      { key: "attendedNo", label: "Did not attend", num: true },
      { key: "attendedBlank", label: "Blank", num: true, render: (t) => t.attendedBlank ? h("span", { class: "warnr-t" }, String(t.attendedBlank)) : "0" },
      { key: "sheetOnly", label: "Added from sheet", num: true, title: "In the sheet but not associated with the event in HubSpot" },
      { key: "hubspotOnly", label: r.authoritative ? "In HubSpot only (excluded)" : "In HubSpot only", num: true,
        render: (t) => t.hubspotOnly ? h("span", { class: "link", onclick: () => openCustom(`${t.tab}: in HubSpot, not in sheet`, "Associated with the event in HubSpot but not listed in the sheet",
          h("div", { style: "padding: 10px 18px" }, t.hubspotOnlyIds.map((id: string) => h("div", null, `Contact ${id} `, hsLink("contact", id, "Open in HubSpot ↗")))) ) }, String(t.hubspotOnly)) : "0" },
      { key: "unresolved", label: "Rows not matched", num: true, sort: (t) => t.unresolved.length,
        render: (t) => t.unresolved.length ? h("span", { class: "link warnr-t", onclick: () => openCustom(`${t.tab}: rows not matched`, "No HS link and the email is not in HubSpot", table<any>([
          { key: "row", label: "Sheet row", num: true }, { key: "name", label: "Name" }, { key: "email", label: "Email", render: (x) => x.email ?? "–" },
        ], t.unresolved)) }, String(t.unresolved.length)) : "0" },
    ], tabs, { initialSort: "", rowClass: (t) => (t.unresolved.length || t.attendedBlank ? "row-warn" : "") })) : null,
    r?.unmatchedTabs?.length ? h("p", { class: "legend warnr-t" }, `Tabs not matched to a HubSpot event: ${r.unmatchedTabs.join("; ")}`) : null,
  );
}
