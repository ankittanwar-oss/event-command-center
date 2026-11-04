import { api } from "../api.js";
import { fmt, h, hsLink } from "../ui.js";

// Leads hidden from the dashboard with the checkbox. Review them one by one and restore any that were hidden by mistake.
export async function redactedView(): Promise<HTMLElement> {
  const d = await api("redactions");
  const items: any[] = d.items;
  const list = h("div", { class: "hwlist" });
  const render = () => list.replaceChildren(...(items.length ? items.map((r) => {
    const btn = h("button", { class: "btn" }, "Restore") as HTMLButtonElement;
    const row = h("div", { class: "lead" },
      h("div", { class: "l1" }, h("b", null, r.contactName ?? r.contactId), hsLink("contact", r.contactId), h("span", { class: "sp" }), btn),
      h("div", { class: "l2" }, `${r.companyName ?? "No company"}${r.events ? ` · ${r.events}` : ""}`),
      h("div", { class: "l2 faint" }, `Hidden ${fmt.day(r.redactedAt)}${r.reason ? ` · Reason: ${r.reason}` : ""}`));
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try { await api("redactions", undefined, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId: r.contactId }) });
        items.splice(items.indexOf(r), 1); render(); } catch (e) { btn.disabled = false; alert((e as Error).message); }
    });
    return row;
  }) : [h("div", { class: "faint" }, "No redacted leads. Tick the box in front of a lead to hide it here.")]));
  render();
  return h("section", { class: "card hwcard" },
    h("div", { class: "hwh" }, h("div", null, h("h2", null, `Redacted leads (${items.length})`), h("div", { class: "hwsub" }, "Hidden from every list and count. Restore puts the lead back. HubSpot is not changed."))),
    list);
}
