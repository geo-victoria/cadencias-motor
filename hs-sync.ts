// Seguimiento de envíos por HubSpot (entregas, aperturas, clics, rebotes y descartes).
// Corre aparte del motor para que la revisión de Zoho no lo deje sin tiempo. Lee eventos en bloque (1.000 por llamada)
// por cada correo de HubSpot y guarda un cursor para continuar donde quedó.
// createClient lo entrega dep.ts del despliegue (globalThis.__gvCreateClient)
const createClient = (globalThis as any).__gvCreateClient;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const HS_TOKEN = Deno.env.get("HUBSPOT_TOKEN") ?? "";
const DAY = 86_400_000;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });

async function hsApi(path: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" } });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1200 * (attempt + 1))); continue; }
    if (r.status === 204) return {};
    const t = await r.text(); let j: any = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
    if (!r.ok) throw new Error(`HubSpot ${r.status}: ${j?.message ?? t.slice(0, 200)}`);
    return j;
  }
  throw new Error("HubSpot 429: límite de llamadas");
}
function hsDeadReason(msg: string): string | null {
  const m = String(msg ?? "");
  if (/UNSUBSCRIBED/i.test(m)) return "Se dio de baja en HubSpot: no recibe correos de marketing";
  if (/INVALID_EMAIL|no es válida|not a valid email/i.test(m)) return "Correo no válido";
  if (/BLOCKED_DOMAIN|PREVIOUS_SPAM|PREVIOUSLY_BOUNCED/i.test(m)) return "HubSpot bloquea los envíos a este correo (rebote o reclamo anterior)";
  return null;
}

const campaigns = new Map<string, string | null>();
// Tipo de evento que se guarda: entregas, aperturas, clics, rebotes, descartes, bajas (UNSUB) y reclamos de spam (SPAM)
function evType(e: any, t: string): string | null {
  if (["DELIVERED", "OPEN", "CLICK", "BOUNCE", "DROPPED"].includes(t)) return t;
  if (t === "SPAMREPORT") return "SPAM";
  if (t === "STATUSCHANGE") {
    const subs: any[] = Array.isArray(e.subscriptions) ? e.subscriptions : [];
    const unsub = String(e.portalSubscriptionStatus ?? "").toUpperCase() === "UNSUBSCRIBED" || subs.some((x) => String(x?.status ?? "").toUpperCase() === "UNSUBSCRIBED");
    return unsub ? "UNSUB" : null;
  }
  return null;
}

// Relleno único de bajas y reclamos de spam de correos ya enviados (solo esos tipos de evento)
async function backfill(budgetMs: number) {
  const t0 = Date.now(); const stats: any = { emails: 0, events: 0, updated: 0 };
  const { data: rows } = await db.from("hs_event_cursor").select("email_id,campaign_id").not("campaign_id", "is", null);
  const { data: cfg } = await db.from("app_config").select("value").eq("key", "hs_unsub_backfill").maybeSingle();
  const done = new Set(String(cfg?.value ?? "").split(",").filter(Boolean));
  for (const row of rows ?? []) {
    if (done.has(row.email_id)) continue;
    if (Date.now() - t0 > budgetMs) { stats.more = true; break; }
    for (const type of ["STATUSCHANGE", "SPAMREPORT"]) {
      let offset: string | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const j = await hsApi(`/email/public/v1/events?campaignId=${row.campaign_id}&eventType=${type}&limit=1000${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`);
        const evs: any[] = [];
        for (const e of j.events ?? []) { const tt = evType(e, String(e.type ?? "").toUpperCase()); if (tt && e.recipient) evs.push({ r: String(e.recipient), t: tt, at: new Date(Number(e.created ?? Date.now())).toISOString() }); }
        stats.events += j.events?.length ?? 0;
        if (evs.length) { const { data: n } = await db.rpc("hs_apply_events", { p_email_id: row.email_id, p_events: evs }); stats.updated += Number(n ?? 0); }
        if (!j.hasMore || !j.offset) break;
        offset = String(j.offset);
      }
    }
    done.add(row.email_id); stats.emails++;
    await db.from("app_config").upsert({ key: "hs_unsub_backfill", value: [...done].join(",") });
  }
  return stats;
}

async function run(budgetMs: number) {
  const t0 = Date.now(); const deadline = t0 + budgetMs;
  const stats: any = { fresh: 0, events: 0, updated: 0, emails: 0 };
  if (!HS_TOKEN) return { ...stats, error: "Falta HUBSPOT_TOKEN" };
  const since = new Date(Date.now() - 30 * DAY).toISOString();

  // 1) Recién enviados: ¿HubSpot lo descartó? (rebotó antes, se dio de baja, etc.)
  const { data: fresh } = await db.from("email_sends").select("id,status,hubspot_status_id,enrollment_id").eq("channel", "hubspot").eq("status", "sent")
    .not("hubspot_status_id", "is", null).is("last_status_check", null).gte("sent_at", since).order("sent_at", { ascending: false }).limit(40);
  for (const s of fresh ?? []) {
    if (Date.now() > t0 + budgetMs * 0.3) break;
    const upd: any = { last_status_check: new Date().toISOString() };
    try {
      const st = await hsApi(`/marketing/v3/email/send-statuses/${encodeURIComponent(s.hubspot_status_id)}`);
      const res = String(st.sendResult ?? "");
      if (res && !["SENT", "QUEUED"].includes(res) && st.status === "COMPLETE") { upd.status = res.includes("BOUNCE") ? "bounced" : "failed"; upd.error = `HubSpot: ${res}`; }
    } catch (err) { delete upd.last_status_check; }
    if (Object.keys(upd).length) await db.from("email_sends").update(upd).eq("id", s.id);
    stats.fresh++;
    if (upd.status) {
      stats.updated++;
      const dead = upd.status === "bounced" ? "Correo rebotado" : hsDeadReason(upd.error ?? "");
      if (dead) await db.from("enrollments").update({ status: "exited", exit_reason: dead, next_due_at: null }).eq("id", s.enrollment_id).eq("status", "active");
    }
  }

  // 2) Eventos en bloque por correo de HubSpot
  const { data: pend, error: pe } = await db.rpc("hs_pending_emails", { p_since: since });
  if (pe) return { ...stats, error: pe.message };
  for (const row of pend ?? []) {
    if (Date.now() > deadline) break;
    const emailId = String(row.email_id);
    try {
      if (!campaigns.has(emailId)) {
        const { data: c0 } = await db.from("hs_event_cursor").select("campaign_id").eq("email_id", emailId).maybeSingle();
        if (c0?.campaign_id) campaigns.set(emailId, c0.campaign_id);
        else {
          const em = await hsApi(`/marketing/v3/emails/${emailId}`);
          campaigns.set(emailId, String(em.primaryEmailCampaignId ?? em.allEmailCampaignIds?.[0] ?? "") || null);
        }
      }
      const camp = campaigns.get(emailId);
      if (!camp) { await db.from("hs_event_cursor").upsert({ email_id: emailId, updated_at: new Date().toISOString() }); continue; }
      const { data: cur } = await db.from("hs_event_cursor").select("*").eq("email_id", emailId).maybeSingle();
      const start = cur?.run_start ? Number(cur.run_start) : (cur?.last_ts ? Number(cur.last_ts) + 1 : new Date(row.min_sent).getTime() - 3_600_000);
      let offset: string | null = cur?.run_offset ?? null;
      let maxTs = cur?.run_max ? Number(cur.run_max) : (cur?.last_ts ? Number(cur.last_ts) : 0);
      let done = false;
      while (Date.now() < deadline) {
        const j = await hsApi(`/email/public/v1/events?campaignId=${camp}&startTimestamp=${start}&limit=1000${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`);
        const evs: any[] = [];
        for (const e of j.events ?? []) {
          const t = String(e.type ?? "").toUpperCase();
          maxTs = Math.max(maxTs, Number(e.created ?? 0));
          const tt = evType(e, t);
          if (tt && e.recipient) evs.push({ r: String(e.recipient), t: tt, at: new Date(Number(e.created ?? Date.now())).toISOString() });
        }
        stats.events += j.events?.length ?? 0;
        if (evs.length) {
          const { data: n, error } = await db.rpc("hs_apply_events", { p_email_id: emailId, p_events: evs });
          if (error) throw new Error(error.message);
          stats.updated += Number(n ?? 0);
        }
        if (!j.hasMore || !j.offset) { done = true; break; }
        offset = String(j.offset);
      }
      await db.from("hs_event_cursor").upsert(done
        ? { email_id: emailId, campaign_id: camp, last_ts: maxTs || cur?.last_ts || null, run_start: null, run_offset: null, run_max: null, updated_at: new Date().toISOString() }
        : { email_id: emailId, campaign_id: camp, last_ts: cur?.last_ts ?? null, run_start: start, run_offset: offset, run_max: maxTs, updated_at: new Date().toISOString() });
      stats.emails++;
    } catch (err) {
      stats.error = (err as Error).message.slice(0, 200);
      await db.from("hs_event_cursor").upsert({ email_id: emailId, updated_at: new Date().toISOString() });
    }
  }
  stats.ms = Date.now() - t0;
  return stats;
}

Deno.serve(async (req) => {
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: cfg } = await db.from("app_config").select("value").eq("key", "cron_secret").maybeSingle();
  if (!cfg?.value || secret !== cfg.value) return json({ error: "No autorizado" }, 401);
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("backfill") === "unsub") return json(await backfill(110_000));
    return json(await run(100_000));
  } catch (e) { return json({ error: (e as Error).message }, 500); }
});
