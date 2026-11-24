// API de la app web de Cadencias (Vercel) — corre con los accesos de David (Zoho, HubSpot, Supabase y Anthropic).
// Solo personas con sesión de un dominio permitido, salvo la vista pública de un borrador compartido (share_view).
// Consultas SQL limitadas a una lista fija + funciones permitidas.
// Roles: owner_emails = ven todo y aprueban/activan; viewer_emails = ven todo, no aprueban.
// createClient lo entrega dep.ts del despliegue (globalThis.__gvCreateClient)
const createClient = (globalThis as any).__gvCreateClient;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });
class E extends Error { constructor(public code: string, msg: string, public status = 400) { super(msg); } }

const FIXED = new Set<string>(["select json_build_object(\n 'cadences',(select coalesce(json_agg(c),'[]'::json) from (select id,name,status,module,activated_at,source_id,channel from cadences) c),\n 'enrollments',(select coalesce(json_agg(e),'[]'::json) from (select id,cadence_id,deal_id,deal_name,contact_name,contact_email,owner_name,owner_email,status,exit_reason,current_step,enrolled_at,anchor_at,next_due_at,left(last_error,160) last_error from enrollments) e),\n 'sends',(select coalesce(json_agg(s),'[]'::json) from (select id,cadence_id,enrollment_id,step_position,deal_id,deal_name,to_email,from_email,subject,status,left(error,160) error,sent_at,delivered_at,opened_at,open_count,clicked_at,replied_at,bounced_at,test,channel,hubspot_contact_id from email_sends order by sent_at desc limit 3000) s)\n) as data;", "select json_build_object(\n 'sent_today',(select count(*) from email_sends where status<>'failed' and sent_at >= (date_trunc('day', now() at time zone 'America/Santiago') at time zone 'America/Santiago')),\n 'sent_7',(select count(*) from email_sends where status<>'failed' and sent_at > now()-interval '7 days'),\n 'open_7',(select count(*) from email_sends where status in ('opened','clicked','replied') and sent_at > now()-interval '7 days'),\n 'replied_7',(select count(*) from email_sends where status='replied' and sent_at > now()-interval '7 days'),\n 'active_cads',(select count(*) from cadences where status='active'),\n 'in_flight',(select count(*) from enrollments where status='active'),\n 'next_due',(select min(next_due_at) from enrollments where status='active' and next_due_at > now()),\n 'zoho_max',(select coalesce(max(used),0) from public.zoho_sends_today()),\n 'series',(select json_agg(json_build_object('d',gs::date,'n',(select count(*) from email_sends e where e.status<>'failed' and (e.sent_at at time zone 'America/Santiago')::date = gs::date)) order by gs) from generate_series((now() at time zone 'America/Santiago')::date - 13, (now() at time zone 'America/Santiago')::date, interval '1 day') gs)\n) as data;", "select json_build_object('limit',(select value from app_config where key='zoho_daily_limit'),'cap',(select value from app_config where key='zoho_daily_cap'),'today',(select coalesce(json_agg(t),'[]'::json) from public.zoho_sends_today() t),'names',(select coalesce(json_agg(json_build_object('e',lower(zoho_email),'n',zoho_name)),'[]'::json) from zoho_connections)) as data;", "select coalesce(json_agg(c),'[]'::json) as data from (select zoho_name, zoho_email, connected_at, last_error, (signature is not null and signature<>'') as firma from zoho_connections order by zoho_name) c;", "select coalesce(json_agg(lower(zoho_email)),'[]'::json) as e from zoho_connections;", "select 1 as ok;", "select json_build_object('alert',(select value from app_config where key='zoho_alert'),'blocked_until',(select value from app_config where key='zoho_blocked_until')) as data;"]);
const FN_ANY = /^select public\.(sync_quota|request_status_sync|exec_sync_summary|att_begin|att_append|test_send|import_contacts|cadence_live)\(/;
// lecturas nuevas: forma exacta (un solo texto entre comillas o nada), sin nada más en la consulta
const FN_READ = /^select public\.(contact_lookup|overlap_alerts|cadence_history)\((?:'(?:[^']|'')*')?\) as r;?$/;
const FN_OWNER = /^select public\.(sync_cadence|run_cadence_now|request_exec_sync)\(/;
// panel de control (solo administradores): un texto JSON entre comillas
const FN_CTRL = /^select public\.control_stats\('(?:[^']|'')*'\) as r;?$/;

async function cfgList(key: string): Promise<string[]> {
  const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  return String(data?.value ?? "").split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}
const owners = () => cfgList("owner_emails");

async function domains(): Promise<string[]> {
  const { data } = await db.from("app_config").select("value").eq("key", "allowed_login_domains").maybeSingle();
  const list = String(data?.value ?? "geovictoria.com").split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return list.length ? list : ["geovictoria.com"];
}

async function sharedZohoToken(c: any): Promise<{ token: string; exp: number }> {
  const { data: h } = await db.from("zoho_token_cache").select("*").eq("user_id", c.user_id).maybeSingle();
  if (h && new Date(h.expires_at).getTime() > Date.now() + 120_000) return { token: h.access_token, exp: new Date(h.expires_at).getTime() };
  const { data: bl } = await db.from("app_config").select("value").eq("key", "zoho_blocked_until").maybeSingle();
  if (bl?.value && new Date(bl.value).getTime() > Date.now()) {
    const hhmm = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" }).format(new Date(bl.value));
    throw new Error(`Zoho bloqueó por unos minutos las renovaciones de acceso. Se reintenta después de las ${hhmm} (CDMX).`);
  }
  const r = await fetch(`${c.accounts_server}/oauth/v2/token`, { method: "POST", body: new URLSearchParams({ refresh_token: c.refresh_token, client_id: Deno.env.get("ZOHO_CLIENT_ID") ?? "", client_secret: Deno.env.get("ZOHO_CLIENT_SECRET") ?? "", grant_type: "refresh_token" }) });
  const j: any = await r.json().catch(() => ({}));
  if (j.access_token) {
    const exp = Date.now() + (j.expires_in ?? 3600) * 1000;
    await db.from("zoho_token_cache").upsert({ user_id: c.user_id, access_token: j.access_token, api_domain: c.api_domain, expires_at: new Date(exp).toISOString(), updated_at: new Date().toISOString() });
    await db.from("app_config").delete().in("key", ["zoho_blocked_until", "zoho_alert"]);
    return { token: j.access_token, exp };
  }
  const msg = String(j.error_description || j.error || r.status);
  const blocked = /too many/i.test(msg);
  if (blocked) await db.from("app_config").upsert({ key: "zoho_blocked_until", value: new Date(Date.now() + 15 * 60_000).toISOString() });
  await db.from("app_config").upsert({ key: "zoho_alert", value: JSON.stringify({ at: new Date().toISOString(), kind: blocked ? "blocked" : "auth", email: c.zoho_email, msg: msg.slice(0, 200) }) });
  throw new Error(blocked ? "Zoho bloqueó por unos minutos las renovaciones de acceso por demasiados pedidos seguidos. Se reintenta en 15 minutos." : `No se pudo renovar el acceso a Zoho de ${c.zoho_email} (${msg}). Debe reconectar su cuenta.`);
}

let ztok: { token: string; api: string; exp: number; uid: string } | null = null;
async function zohoToken(force = false) {
  if (!force && ztok && ztok.exp > Date.now() + 60_000) return ztok;
  const own = await owners();
  const { data } = await db.from("zoho_connections").select("*");
  const list = (data ?? []).sort((a: any, b: any) => (own.includes(String(a.zoho_email).toLowerCase()) ? -1 : 0) - (own.includes(String(b.zoho_email).toLowerCase()) ? -1 : 0));
  let last: Error | null = null;
  for (const c of list) {
    try {
      if (force) await db.from("zoho_token_cache").delete().eq("user_id", c.user_id);
      const t = await sharedZohoToken(c);
      ztok = { token: t.token, api: c.api_domain, exp: t.exp, uid: c.user_id };
      return ztok;
    } catch (e) { last = e as Error; if (/bloque/i.test(last.message)) break; }
  }
  throw new E("server_not_connected", last ? last.message : "No hay una conexión de Zoho válida en el motor.", 503);
}
async function zget(path: string, retry = true): Promise<any> {
  const t = await zohoToken();
  const r = await fetch(`${t.api}/crm/v8${path}`, { headers: { Authorization: `Zoho-oauthtoken ${t.token}` } });
  if (r.status === 204) return { data: [], info: { more_records: false } };
  const txt = await r.text(); let j: any = {}; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (r.status === 401 && retry) { ztok = null; await zohoToken(true); return zget(path, false); }
  if (!r.ok) throw new E("zoho", `Zoho ${r.status}: ${j?.message ?? txt.slice(0, 160)}`, 502);
  return j;
}
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString();
async function zohoTool(tool: string, a: any) {
  const p = a?.path_variables ?? {}; const q = a?.query_params ?? {};
  const mod = (v: unknown) => { const s = String(v ?? ""); if (!/^[A-Za-z0-9_]+$/.test(s)) throw new E("bad_args", "Módulo no válido"); return s; };
  switch (tool) {
    case "getFields": return zget(`/settings/fields?${qs({ module: mod(q.module), type: q.type })}`);
    case "getTags": return zget(`/settings/tags?${qs({ module: mod(q.module) })}`);
    case "getUsers": return zget(`/users?${qs({ type: q.type ?? "ActiveUsers", per_page: q.per_page ?? 200, page: q.page })}`);
    case "searchRecords": return zget(`/${mod(p.module)}/search?${qs({ criteria: q.criteria, fields: q.fields, per_page: q.per_page ?? 200, page: q.page ?? 1 })}`);
    case "getRelatedRecords": {
      const id = String(p.parentRecord ?? ""); if (!/^\d+$/.test(id)) throw new E("bad_args", "Registro no válido");
      return zget(`/${mod(p.parentRecordModule)}/${id}/${mod(p.relatedList)}?${qs({ fields: q.fields, per_page: q.perPage ?? q.per_page, page: q.page })}`);
    }
    default: throw new E("not_in_manifest", `Herramienta de Zoho no disponible: ${tool}`);
  }
}

type Cond = { field: string; op: string; value: any };
const escZ = (v: unknown) => String(v).replace(/([(),\\])/g, "\\$1");
function buildCriteria(conds: Cond[]): string | null {
  const parts: string[] = [];
  for (const c of conds ?? []) {
    if (!c?.field || !c.op || !/^[A-Za-z0-9_]+$/.test(c.field)) continue;
    const vals = (Array.isArray(c.value) ? c.value : [c.value]).filter((v) => v !== "" && v != null);
    if (!vals.length) continue;
    if (c.op === "in") parts.push(vals.length === 1 ? `(${c.field}:equals:${escZ(vals[0])})` : "(" + vals.map((v) => `(${c.field}:equals:${escZ(v)})`).join("or") + ")");
    else if (c.op === "not_in") parts.push(vals.length === 1 ? `(${c.field}:not_equal:${escZ(vals[0])})` : "(" + vals.map((v) => `(${c.field}:not_equal:${escZ(v)})`).join("and") + ")");
    else if (/^[a-z_]+$/.test(c.op)) parts.push(`(${c.field}:${c.op}:${escZ(vals[0])})`);
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : "(" + parts.join("and") + ")";
}
const EMAIL_FIELD: Record<string, string> = { Deals: "Contact_Email", Leads: "Email", Contacts: "Email" };
async function shareView(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token ?? ""))) throw new E("not_found", "Enlace no válido.", 404);
  const { data: sh } = await db.from("app_docs").select("data").eq("parent", "shares").eq("id", token).maybeSingle();
  const cadId = sh?.data?.cadId;
  if (!cadId) throw new E("not_found", "Este enlace ya no está disponible.", 404);
  const { data: c } = await db.from("app_docs").select("data").eq("parent", "cadences").eq("id", String(cadId)).maybeSingle();
  if (!c?.data) throw new E("not_found", "La cadencia de este enlace ya no existe.", 404);
  const cad = { ...c.data, id: String(cadId) };
  // resultados en vivo (solo números agregados) si la cadencia ya está en el motor
  let live: any = null;
  try {
    const { data: eng } = await db.from("cadences").select("id").eq("source_id", String(cadId)).maybeSingle();
    if (eng?.id) {
      const { data: all } = await db.rpc("cadence_live");
      const arr = typeof all === "string" ? JSON.parse(all) : all;
      live = (Array.isArray(arr) ? arr : []).find((x: any) => x.id === eng.id) ?? null;
    }
  } catch { /* sin resultados */ }
  let n: number | null = null; let truncated = false;
  if (cad.source === "list") return { cad, n, truncated, live };
  try {
    const module = ["Deals", "Leads", "Contacts"].includes(cad.module) ? cad.module : "Deals";
    const crit = buildCriteria(cad.criteria?.conditions ?? []);
    if (crit) {
      const ef = EMAIL_FIELD[module];
      let page = 1, more = true, count = 0;
      while (more && page <= 5) {
        const j = await zget(`/${module}/search?${qs({ criteria: crit, fields: ef, per_page: 200, page })}`);
        const rows = j.data ?? [];
        count += rows.filter((r: any) => r[ef]).length;
        more = !!j.info?.more_records && rows.length > 0; page++;
      }
      n = count; truncated = more;
    }
  } catch { /* sin conteo */ }
  return { cad, n, truncated, live };
}

async function sql(q: string, isOwner: boolean) {
  const t = String(q ?? "").trim();
  if (!(FIXED.has(t) || FN_ANY.test(t) || FN_READ.test(t) || (FN_OWNER.test(t) && isOwner) || (FN_CTRL.test(t) && isOwner))) {
    if (FN_CTRL.test(t)) throw new E("permission_denied", "El panel de control es solo para quienes administran la herramienta.", 403);
    if (FN_OWNER.test(t)) throw new E("permission_denied", "Solo quien administra la herramienta puede activar o pausar envíos.", 403);
    throw new E("permission_denied", "Consulta no permitida.", 403);
  }
  const { data, error } = await db.rpc("app_exec", { q: t });
  if (error) throw new E("engine", error.message, 500);
  return { result: "<x>\n" + JSON.stringify(data ?? []) + "\n</x>" };
}

async function ai(messages: any[]) {
  if (!ANTHROPIC_KEY) throw new E("ai_missing", "Falta configurar ANTHROPIC_API_KEY en Supabase (Edge Functions → Secrets).", 503);
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 8000, messages: (messages ?? []).map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") })) }) });
  const j = await r.json();
  if (!r.ok) throw new E("ai", `IA: ${j?.error?.message ?? r.status}`, 502);
  const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  const a2 = clean.indexOf("["), b2 = clean.lastIndexOf("]");
  for (const [x, y] of [[a, b], [a2, b2]]) { if (x >= 0 && y > x) { try { return { json: JSON.parse(clean.slice(x, y + 1)), text }; } catch { /* sigue */ } } }
  throw new E("ai", "La IA no devolvió un resultado válido. Intenta de nuevo.", 502);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.op === "share_view") return json(await shareView(body.token));
    const auth = req.headers.get("Authorization") ?? "";
    const uc = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: u, error } = await uc.auth.getUser();
    if (error || !u.user) throw new E("unauthenticated", "Inicia sesión para continuar.", 401);
    const email = String(u.user.email ?? "").toLowerCase();
    if (!(await domains()).includes(email.split("@")[1] ?? "")) throw new E("forbidden", "Tu correo no pertenece a un dominio permitido.", 403);
    const isOwner = (await owners()).includes(email);
    switch (body.op) {
      case "me": {
        const isViewer = !isOwner && (await cfgList("viewer_emails")).includes(email);
        return json({ id: u.user.id, email, owner: isOwner, viewer: isViewer, ai: !!ANTHROPIC_KEY });
      }
      case "mcp": {
        if (body.server === "Zoho CRM") return json({ payload: await zohoTool(String(body.tool), body.args) });
        if (body.server === "Supabase" && body.tool === "execute_sql") return json({ payload: await sql(body.args?.query, isOwner) });
        throw new E("server_not_connected", `Conexión no disponible: ${body.server}`, 400);
      }
      case "ai": return json(await ai(body.messages));
      default: throw new E("bad_op", "Operación desconocida");
    }
  } catch (e) {
    const err = e instanceof E ? e : new E("internal", (e as Error).message, 500);
    return json({ error: err.message, code: err.code }, err.status);
  }
});
