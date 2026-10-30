import { adminHeaders, api, getAdminToken, setAdminToken } from "../api.js";
import { leadTable } from "../drawer.js";
import type { Route } from "../state.js";
import { fmt, h, table } from "../ui.js";

export async function adminView(_route: Route, meta: any): Promise<HTMLElement> {
  const [runs, rules] = await Promise.all([api("admin/sync-runs"), api("admin/rules")]);
  const msg = h("div");
  const say = (text: string, ok = true) => msg.replaceChildren(h("div", { class: `banner ${ok ? "note" : "warn"}` }, text));

  const token = h("input", { class: "text", type: "password", placeholder: "Admin token", value: getAdminToken(), style: "width:220px" }) as HTMLInputElement;
  token.addEventListener("change", () => setAdminToken(token.value));
  const trigger = (full: boolean) => async () => {
    setAdminToken(token.value);
    try {
      await api("admin/sync", undefined, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ full }) });
      say(`${full ? "Full" : "Incremental"} refresh started. It usually takes a few minutes; reload this page to follow progress.`);
    } catch (e) { say((e as Error).message, false); }
  };

  const editor = h("textarea", { class: "code", spellcheck: "false" }) as HTMLTextAreaElement;
  editor.value = JSON.stringify(rules.effective, null, 2);
  const saveRules = async () => {
    setAdminToken(token.value);
    let patch: unknown;
    try { patch = JSON.parse(editor.value); } catch { return say("Rules are not valid JSON", false); }
    try {
      const r = await api("admin/rules", undefined, { method: "PUT", headers: adminHeaders(), body: JSON.stringify(patch) });
      say(`Rules saved. ${fmt.n(r.recomputed)} lead records recomputed from stored data.`);
    } catch (e) { say((e as Error).message, false); }
  };

  const lookupIn = h("input", { class: "text", placeholder: "Email, name or HubSpot contact id", style: "width:300px" }) as HTMLInputElement;
  const lookupOut = h("div");
  const lookup = async () => {
    try { const r = await api("lookup", { q: lookupIn.value }); lookupOut.replaceChildren(h("div", { class: "card" }, leadTable(r.rows))); }
    catch (e) { lookupOut.replaceChildren(h("div", { class: "banner warn" }, (e as Error).message)); }
  };
  lookupIn.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") lookup(); });

  const c = runs.counts ?? {};
  return h("div", null,
    msg,
    h("h2", null, "Data refresh"),
    h("div", { class: "card" }, h("div", { class: "bd", style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
      h("span", null, "Last successful sync: ", h("b", null, runs.freshness.lastSuccessAt ? `${new Date(runs.freshness.lastSuccessAt).toLocaleString()} (${fmt.ago(runs.freshness.lastSuccessAt)})` : "never")),
      h("span", { class: "muted" }, `· facts computed ${fmt.ago(runs.computedAt)} as of ${runs.asOf ?? "–"}`),
      h("span", { style: "margin-left:auto" }),
      meta.adminEnabled ? [token,
        h("button", { class: "btn", onclick: trigger(false) }, "Refresh now"),
        h("button", { class: "btn", onclick: trigger(true) }, "Full reconcile")] : h("span", { class: "muted" }, "Manual refresh disabled (ADMIN_TOKEN not set)"))),
    h("h2", null, "Stored records"),
    h("div", { class: "card" }, table<any>([{ key: "k", label: "Table" }, { key: "v", label: "Rows", num: true }],
      Object.entries(c).map(([k, v]) => ({ k, v: Number(v) })))),
    h("h2", null, "Sync history", h("span", { class: "sub" }, "Last 50 runs")),
    h("div", { class: "card" }, table<any>([
      { key: "started_at", label: "Started", render: (r) => new Date(r.started_at).toLocaleString() },
      { key: "trigger", label: "Trigger" }, { key: "mode", label: "Mode", render: (r) => r.mode ?? "–" },
      { key: "status", label: "Status", render: (r) => h("span", { class: `pill ${r.status === "success" ? "good" : r.status === "failed" ? "bad" : ""}` }, r.status) },
      { key: "duration_ms", label: "Duration", num: true, render: (r) => r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : "–" },
      { key: "requests", label: "API calls", num: true }, { key: "failed_requests", label: "Failed", num: true },
      { key: "records", label: "Records", wrap: true, render: (r) => Object.entries(r.records ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") },
      { key: "error", label: "Error / warnings", wrap: true, render: (r) => r.error ?? ((r.warnings ?? []).join(" | ") || "–") },
    ], runs.runs, { initialSort: "started_at" })),
    h("h2", null, "Contact lookup", h("span", { class: "sub" }, "Audit any contact across events")),
    h("div", { style: "display:flex;gap:8px;margin-bottom:10px" }, lookupIn, h("button", { class: "btn", onclick: lookup }, "Search")),
    lookupOut,
    h("h2", null, "Business rules", h("span", { class: "sub" }, "Thresholds, cadence, eligibility, categories. Saving recomputes all numbers from stored data.")),
    editor,
    h("div", { style: "display:flex;gap:8px;margin-top:8px" },
      meta.adminEnabled ? h("button", { class: "btn primary", onclick: saveRules }, "Save rules and recompute") : null,
      meta.adminEnabled ? h("button", { class: "btn", onclick: async () => { editor.value = JSON.stringify({ reset: true }); await saveRules(); } }, "Reset to defaults") : null),
  );
}
