import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { mergeRules, nextAction, RISK_LABEL, riskOf, rosterById, touchKind, type Activity } from "@ecc/core";
import { env, today } from "../env.js";
import { errMessage, log } from "../log.js";
import { getPool } from "../db/pool.js";
import { getSetting, setSetting } from "../db/repo.js";
import { loadRules, validateRules } from "../rules.js";
import { recomputeFacts, runSync } from "../sync/sync.js";
import { getSnapshot, invalidateSnapshot, ownerNames } from "./cache.js";
import { clearDisposition, loadDispositions, saveDisposition } from "./dispositions.js";
import { checkAppAuth, HttpError, readJson, requireAdmin, SECURITY_HEADERS, send } from "./http.js";
import * as v from "./views.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

function webDist(): string | null {
  const c = [process.env.WEB_DIST, path.resolve(process.cwd(), "apps/web/dist"), path.resolve(process.cwd(), "../web/dist")].filter((x): x is string => !!x);
  return c.find((d) => existsSync(path.join(d, "index.html"))) ?? null;
}

let manualSyncRunning = false;

async function freshness() {
  const r = await getPool().query(
    `SELECT (SELECT max(finished_at) FROM sync_runs WHERE status='success') AS last_success,
            (SELECT row_to_json(x) FROM (SELECT id, trigger, mode, status, started_at, finished_at, duration_ms, error FROM sync_runs ORDER BY started_at DESC LIMIT 1) x) AS last_run`);
  const lastSuccess: string | null = r.rows[0]?.last_success ? new Date(r.rows[0].last_success).toISOString() : null;
  const ageHours = lastSuccess ? (Date.now() - Date.parse(lastSuccess)) / 3_600_000 : null;
  return { lastSuccessAt: lastSuccess, ageHours, stale: ageHours === null || ageHours > env.staleAfterHours, staleAfterHours: env.staleAfterHours, lastRun: r.rows[0]?.last_run ?? null };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method || "GET";

  if (p === "/api/meta" && method === "GET") {
    const s = await getSnapshot();
    const t = s.asOf ?? today();
    return send(res, 200, {
      ...v.metaFor(s.facts, t), freshness: await freshness(), computedAt: s.computedAt, leadCount: s.facts.length,
      portalId: env.hubspotPortalId, adminEnabled: !!env.adminToken, manualSyncRunning, build: "update-36",
    });
  }

  const s = await getSnapshot();
  const t = s.asOf ?? today();
  const rules = s.rules;

  if (method === "GET") {
    switch (p) {
      case "/api/overview": return send(res, 200, v.overview(s.facts, q, t, rules, await loadDispositions()));
      case "/api/leads": return send(res, 200, v.leads(s.facts, q, t, rules));
      case "/api/sdr": return send(res, 200, v.sdrs(s.facts, q, t, rules));
      case "/api/cmo-hotwarm": return send(res, 200, v.cmoHotWarm(s.facts, q, t, rules));
      case "/api/cmo-hotwarm-drill": return send(res, 200, v.cmoHotWarmDrill(s.facts, q, t, rules));
      case "/api/account-drill": return send(res, 200, v.accountDrill(s.facts, q, t, rules, await loadDispositions()));
      case "/api/daily": return send(res, 200, v.daily(s.facts, q, t, rules, await loadDispositions()));
      case "/api/depth": return send(res, 200, v.depth(s.facts, q, t, rules));
      case "/api/accounts": return send(res, 200, v.accounts(s.facts, q, t, rules));
      case "/api/events": return send(res, 200, v.events(s.facts, q, t, rules));
      case "/api/performance": return send(res, 200, v.performance(s.facts, q, t));
      case "/api/data-quality": return send(res, 200, v.quality(s.facts, q, t));
      case "/api/admin/sync-runs": {
        const r = await getPool().query("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 50");
        const counts = await getPool().query(`SELECT
          (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM event_contacts) AS registrations, (SELECT count(*) FROM contacts) AS contacts,
          (SELECT count(*) FROM companies) AS companies, (SELECT count(*) FROM activities) AS activities, (SELECT count(*) FROM deals) AS deals,
          (SELECT count(*) FROM activities WHERE kind='LINKEDIN') AS linkedin_messages`);
        return send(res, 200, { runs: r.rows, freshness: await freshness(), counts: counts.rows[0], computedAt: s.computedAt, asOf: s.asOf });
      }
      case "/api/admin/rules": return send(res, 200, { effective: await loadRules(), snapshot: rules });
      case "/api/roundtable-sheet": {
        // Reconciliation of the roundtable Google Sheet with HubSpot (written by the sync). No credentials returned.
        let serviceAccountEmail: string | null = null;
        try { serviceAccountEmail = env.googleServiceAccountJson ? JSON.parse(env.googleServiceAccountJson).client_email ?? null : null; } catch { serviceAccountEmail = null; }
        return send(res, 200, {
          configured: !!env.googleServiceAccountJson, serviceAccountEmail, sheetId: env.roundtableSheetId,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${env.roundtableSheetId}/edit`,
          report: await getSetting("roundtable_sheet_report"),
        });
      }
      case "/api/lookup": {
        // Find every lead record for a contact (email, name or HubSpot id) – used to audit individual cases.
        const term = (q.get("q") || "").trim().toLowerCase();
        if (term.length < 3) throw new HttpError(400, "Enter at least 3 characters");
        const rows = s.facts.filter((f) => f.contactId === term || (f.contactEmail ?? "").toLowerCase().includes(term) || f.contactName.toLowerCase().includes(term) || (f.companyName ?? "").toLowerCase() === term);
        return send(res, 200, { rows: rows.slice(0, 100) });
      }
    }
    const ev = /^\/api\/events\/([\w-]+)$/.exec(p);
    if (ev) {
      const d = v.eventDetail(s.facts, ev[1]!, rules);
      return d ? send(res, 200, d) : send(res, 404, { error: "Event not found in the current dataset" });
    }
    const lead = /^\/api\/leads\/([\w-]+)\/([\w-]+)$/.exec(p);
    if (lead) {
      // Audit trail: every stored activity on the contact and whether (and why) it counted as a touch.
      const fact = s.facts.find((f) => f.eventId === lead[1] && f.contactId === lead[2]);
      if (!fact) return send(res, 404, { error: "Lead not found" });
      const r = await getPool().query(
        `SELECT a.*, 'contact' AS via FROM activities a JOIN activity_contacts ac ON ac.activity_id = a.id WHERE ac.contact_id = $1
         UNION ALL
         SELECT a.*, 'company' AS via FROM activities a JOIN activity_companies aco ON aco.activity_id = a.id
           WHERE aco.company_id = $2 AND NOT EXISTS (SELECT 1 FROM activity_contacts x WHERE x.activity_id = a.id AND x.contact_id = $1)
         ORDER BY ts DESC LIMIT 500`, [fact.contactId, fact.companyId ?? ""]);
      const counted = new Set(fact.touchIds);
      const activities = r.rows.map((row: any) => {
        const a: Activity = { id: row.id, kind: row.kind, objectType: row.object_type, timestamp: new Date(row.ts).toISOString(), ownerId: row.owner_id, direction: row.direction, channel: row.channel, status: row.status, title: row.title, contactIds: [], companyIds: [] };
        const kind = touchKind(a, fact.sdrOwnerId, rules);
        let why = counted.has(a.id) ? "Counted" : "";
        if (!why) {
          if (row.via === "company") why = "Logged on the company, not this contact";
          else if (!kind) why = !a.ownerId ? "No owner" : !rosterById.has(a.ownerId) ? "Owner is not a roster SDR" : `${a.kind}${a.direction ? ` (${a.direction})` : ""} is not an outbound touch`;
          else if (fact.eligibilityDate && a.timestamp.slice(0, 10) < fact.eligibilityDate) why = "Before eligibility date";
          else why = "Duplicate";
        }
        return { ...a, hsId: row.hs_id, via: row.via, ownerName: rosterById.get(a.ownerId ?? "")?.name ?? ownerNames.get(a.ownerId ?? "") ?? row.owner_id, counted: counted.has(a.id), why };
      });
      const risk = riskOf(fact, rules);
      return send(res, 200, { lead: fact, enriched: v.withRisk(fact, rules, t), nextAction: nextAction(fact, rules), risk: risk?.level ?? null, riskLabel: risk ? RISK_LABEL[risk.level] : null, riskReason: risk?.reason ?? null, activities });
    }
  }

  if (method === "POST" && p === "/api/admin/sync") {
    requireAdmin(req);
    if (manualSyncRunning) return send(res, 409, { error: "A manual refresh is already running" });
    const body = await readJson(req);
    manualSyncRunning = true;
    // Respond immediately; progress is visible in the sync history.
    runSync("manual", { forceFull: !!body.full })
      .then((r) => { log.info("manual sync done", { status: r.status, runId: r.runId }); invalidateSnapshot(); })
      .catch((e) => log.error("manual sync crashed", { error: errMessage(e) }))
      .finally(() => { manualSyncRunning = false; });
    return send(res, 202, { started: true });
  }

  // Commercial dispositions: confirmed by a named person; stored in the dashboard database (HubSpot is read-only).
  if (method === "POST" && p === "/api/dispositions") {
    const body = await readJson(req);
    const err = await saveDisposition(body);
    if (err) return send(res, 400, { error: err });
    return send(res, 200, { ok: true });
  }
  if (method === "DELETE" && p === "/api/dispositions") {
    const body = await readJson(req);
    if (!body?.scope || !body?.id || !body?.confirmedBy) return send(res, 400, { error: "scope, id and confirmedBy are required" });
    await clearDisposition(body.scope, String(body.id), String(body.confirmedBy));
    return send(res, 200, { ok: true });
  }

  if (method === "PUT" && p === "/api/admin/rules") {
    requireAdmin(req);
    const patch = await readJson(req);
    const merged = mergeRules(await loadRules(), patch);
    const errs = validateRules(merged);
    if (errs.length) return send(res, 400, { error: "Invalid rules", details: errs });
    await setSetting("rules", patch?.reset ? {} : patch);
    const n = await recomputeFacts();
    invalidateSnapshot();
    return send(res, 200, { ok: true, recomputed: n, effective: await loadRules() });
  }

  if (method === "POST" && p === "/api/admin/recompute") {
    requireAdmin(req);
    const n = await recomputeFacts();
    invalidateSnapshot();
    return send(res, 200, { ok: true, recomputed: n });
  }

  return send(res, 404, { error: "Not found" });
}

function serveStatic(res: ServerResponse, pathname: string) {
  const dist = webDist();
  if (!dist) return send(res, 503, { error: "Web assets not built. Run `npm run build`." });
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(dist, safe);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
  const ext = path.extname(file);
  const headers = SECURITY_HEADERS;
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    ...headers,
  });
  res.end(readFileSync(file));
}

export function createApp() {
  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (url.pathname === "/api/health") {
        // Liveness + database reachability for Railway's health check. No auth, no data.
        let db = false;
        try { await getPool().query("SELECT 1"); db = true; } catch { db = false; }
        let fresh = null;
        if (db) { try { fresh = await freshness(); } catch { fresh = null; } }
        return send(res, db ? 200 : 503, { ok: db, db, lastSuccessAt: fresh?.lastSuccessAt ?? null, stale: fresh?.stale ?? null, time: new Date().toISOString() });
      }
      if (!checkAppAuth(req)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Event Command Center", charset="UTF-8"', "Content-Type": "text/plain" });
        return res.end("Authentication required");
      }
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else serveStatic(res, url.pathname);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error("request failed", { path: url.pathname, error: errMessage(e) });
      if (!res.headersSent) send(res, status, { error: status >= 500 ? "Internal error" : errMessage(e) });
    } finally {
      if (url.pathname.startsWith("/api/")) log.debug("request", { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
    }
  });
}
