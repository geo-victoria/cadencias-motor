// Motor de cadencias Zoho CRM — GeoVictoria (v2)
// Rutas (?action=): connect, oauth_start, oauth_callback, me, disconnect, fields, run, cron
//   cron: revisión programada, tanda encadenada ({chain}), prueba ({test}), contactos desde Excel ({import}),
//         reactivar o recrear prospecto/trato ({import:{reactivate}}), crear campos «Cadencia Plataforma» ({ensure_fields})
// Prospección externa (settings.prospect): al tomar la lista, crea en Zoho como prospecto a quien no exista (dueño =
// quien creó la cadencia, fuente elegida); quien ya existe como prospecto o contacto no se duplica y queda fuera.
// Anti-canibalización antes del primer correo; «CAD-0000 · Nombre» en «Cadencia Plataforma» al primer envío;
// perdidos pasan a quien creó la cadencia; al salir o terminar el campo se limpia.
// createClient lo entrega index.ts (dep.ts) para que este módulo remoto no necesite importar npm:
const createClient = (globalThis as any).__gvCreateClient;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZOHO_CLIENT_ID = Deno.env.get("ZOHO_CLIENT_ID") ?? "";
const ZOHO_CLIENT_SECRET = Deno.env.get("ZOHO_CLIENT_SECRET") ?? "";
const ZOHO_ACCOUNTS = Deno.env.get("ZOHO_ACCOUNTS_URL") ?? "https://accounts.zoho.com";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const HS_TOKEN = Deno.env.get("HUBSPOT_TOKEN") ?? "";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/cadencias?action=oauth_callback`;
const ZV = "v8";
const SCOPES = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.coql.READ",
  "ZohoCRM.send_mail.all.CREATE",
  "ZohoCRM.settings.fields.ALL",
  "ZohoCRM.settings.emails.READ",
  "ZohoCRM.settings.tags.READ",
  "ZohoCRM.users.READ",
  "ZohoAnalytics.metadata.read",
  "ZohoAnalytics.data.read",
].join(",");
const RUN_BUDGET_MS = 110_000;
const HS_PER_RUN = 200;
const DEFAULT_OWNER_EMAIL = "info@geovictoria.com"; // GeoVictoria Admin

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
const text = (msg: string, status = 200) =>
  new Response(msg, { status, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ======================================================================= Dominios excluidos
let BLOCKED: string[] = [];
async function loadBlocked(): Promise<string[]> {
  try {
    const { data } = await db.from("app_docs").select("data").eq("parent", "config").eq("id", "blocked_domains").maybeSingle();
    return ((data?.data as any)?.domains ?? []).map((d: any) => String(d).toLowerCase().trim()).filter(Boolean);
  } catch { return []; }
}
function domainHit(email: string, list: any): string | null {
  const dom = String(email ?? "").toLowerCase().trim().split("@")[1] ?? "";
  if (!dom || !Array.isArray(list)) return null;
  for (const raw of list) { const d = String(raw ?? "").toLowerCase().trim(); if (d && (dom === d || dom.endsWith("." + d))) return d; }
  return null;
}
const blockedDomain = (email: string) => domainHit(email, BLOCKED);

// ======================================================================= Firma de cada persona
type Prof = { title?: string; phone?: string; meeting?: string };
let PROF = new Map<string, Prof>();
const normMail = (v: any) => String(v ?? "").trim().toLowerCase().replace(/@geo-victoria\.com$/, "@geovictoria.com");
async function loadProfiles() {
  try {
    const { data } = await db.from("app_docs").select("id, data").eq("parent", "profiles");
    const m = new Map<string, Prof>();
    for (const r of data ?? []) m.set(normMail(r.id), (r.data ?? {}) as Prof);
    PROF = m;
  } catch { /* sin datos extra */ }
}
const profOf = (email: any): Prof => PROF.get(normMail(email)) ?? {};
const meetOf = (p: Prof) => (/^https?:\/\//i.test(String(p.meeting ?? "")) ? String(p.meeting) : "");
// La cadencia puede pedir que la firma salga sin «Agenda una reunión» (settings.showMeeting === false)
const sigProf = (p: Prof, settings: any): Prof => (settings?.showMeeting === false ? { ...p, meeting: "" } : p);

// ======================================================================= Campos de cadencia en Zoho
const ZCAD: Record<string, string> = { Deals: "Cadencia_Activada", Leads: "Cadencia_seguimiento_Intento_de_Contacto" };
let CADF: Record<string, string> = {};
async function loadCadFields() {
  try {
    const { data } = await db.from("app_config").select("key, value").like("key", "cad_field_%");
    const m: Record<string, string> = {};
    for (const r of data ?? []) m[String(r.key).replace("cad_field_", "")] = String(r.value);
    CADF = m;
  } catch { /* sin campos */ }
}
async function ensureFields() {
  const admin = await adminConn(await allConns());
  if (!admin) return { error: "No hay Zoho conectado en el motor" };
  const out: any = {};
  for (const m of ["Leads", "Deals", "Contacts"]) {
    try {
      const find = async () => { const j = await zoho(admin, `/settings/fields?module=${m}`); return (j.fields ?? []).find((f: any) => String(f.field_label ?? "").trim().toLowerCase() === "cadencia plataforma"); };
      let f = await find();
      if (!f) {
        await zoho(admin, `/settings/fields?module=${m}`, { method: "POST", body: JSON.stringify({ fields: [{ field_label: "Cadencia Plataforma", data_type: "text", length: 255 }] }) });
        f = await find();
      }
      if (f) { out[m] = f.api_name; await db.from("app_config").upsert({ key: `cad_field_${m}`, value: f.api_name }); }
      else out[m] = "no se pudo crear";
    } catch (e) { out[m] = "error: " + (e as Error).message.slice(0, 200); }
  }
  await loadCadFields();
  return out;
}
const usersCache = new Map<string, string>();
const userNames = new Map<string, string>();
async function zohoUserId(c: Conn, email: any): Promise<string | null> {
  const k = normMail(email); if (!k) return null;
  if (!usersCache.size) {
    try {
      for (let page = 1; page <= 3; page++) {
        const j = await zoho(c, `/users?type=ActiveUsers&per_page=200&page=${page}`);
        for (const u of j.users ?? []) { usersCache.set(normMail(u.email), String(u.id)); userNames.set(normMail(u.email), String(u.full_name ?? u.email ?? "")); }
        if (!j.info?.more_records) break;
      }
    } catch { /* sin usuarios */ }
  }
  return usersCache.get(k) ?? null;
}
async function tagFirstSend(conn: Conn, cad: any, e: any, module: string) {
  if (!/^\d+$/.test(String(e.deal_id))) return;
  const label = `${cad.code ?? "CAD"} · ${cad.name}`.slice(0, 250);
  const rec = e.record ?? {};
  const stage = String(e.stage ?? rec.stage ?? "");
  const lost = module === "Deals" ? /perdid/i.test(stage) : module === "Leads" ? /perdid|no calific/i.test(stage) : false;
  const creator = lost ? await zohoUserId(conn, cad.created_by_email) : null;
  const main: any = { id: String(e.deal_id) };
  if (CADF[module]) main[CADF[module]] = label;
  if (module === "Leads" && creator) main.Owner = { id: creator };
  try { if (Object.keys(main).length > 1) await zoho(conn, `/${module}`, { method: "PUT", body: JSON.stringify({ data: [main], trigger: [] }) }); } catch { /* sigue */ }
  if (module === "Deals" && rec.contactId) {
    const ct: any = { id: String(rec.contactId) };
    if (CADF.Contacts) ct[CADF.Contacts] = label;
    if (creator) ct.Owner = { id: creator };
    try { if (Object.keys(ct).length > 1) await zoho(conn, `/Contacts`, { method: "PUT", body: JSON.stringify({ data: [ct], trigger: [] }) }); } catch { /* sigue */ }
  }
  if (CADF[module]) await db.from("enrollments").update({ cad_tagged: label }).eq("id", e.id);
}
async function clearTags(conns: Conn[], stats: any, deadline: number) {
  if (!Object.keys(CADF).length) return;
  const admin = await adminConn(conns); if (!admin) return;
  const { data } = await db.from("enrollments").select("id, deal_id, record, cad_tagged, cadences(spec, module)").not("cad_tagged", "is", null).neq("status", "active").limit(40);
  for (const r of data ?? []) {
    if (Date.now() > deadline) break;
    const module = (r as any).cadences?.spec?.module ?? (r as any).cadences?.module ?? "Deals";
    const label = String(r.cad_tagged);
    const clear = async (mod: string, id: string) => {
      const f = CADF[mod]; if (!f || !/^\d+$/.test(id)) return;
      try {
        const j = await zoho(admin, `/${mod}/${id}?fields=${f}`);
        if (String(j.data?.[0]?.[f] ?? "") === label) await zoho(admin, `/${mod}`, { method: "PUT", body: JSON.stringify({ data: [{ id, [f]: null }], trigger: [] }) });
      } catch { /* sigue */ }
    };
    await clear(module, String(r.deal_id));
    if (module === "Deals" && (r.record as any)?.contactId) await clear("Contacts", String((r.record as any).contactId));
    await db.from("enrollments").update({ cad_tagged: null }).eq("id", r.id);
    stats.untagged = (stats.untagged ?? 0) + 1;
  }
}

// ======================================================================= Zoho
type Conn = { user_id: string; zoho_email: string; zoho_name: string | null; zoho_user_id: string | null; refresh_token: string; accounts_server: string; api_domain: string; signature: string | null };
const tokenCache = new Map<string, { token: string; exp: number }>();

async function sharedZohoToken(c: any): Promise<{ token: string; exp: number }> {
  const { data: h } = await db.from("zoho_token_cache").select("*").eq("user_id", c.user_id).maybeSingle();
  if (h && new Date(h.expires_at).getTime() > Date.now() + 120_000) return { token: h.access_token, exp: new Date(h.expires_at).getTime() };
  const { data: bl } = await db.from("app_config").select("value").eq("key", "zoho_blocked_until").maybeSingle();
  if (bl?.value && new Date(bl.value).getTime() > Date.now()) {
    const hhmm = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" }).format(new Date(bl.value));
    throw new Error(`Zoho bloqueó por unos minutos las renovaciones de acceso. Se reintenta después de las ${hhmm} (CDMX).`);
  }
  const r = await fetch(`${c.accounts_server}/oauth/v2/token`, { method: "POST", body: new URLSearchParams({ refresh_token: c.refresh_token, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, grant_type: "refresh_token" }) });
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

async function accessToken(c: Conn): Promise<string> {
  const hit = tokenCache.get(c.user_id);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  try {
    const t = await sharedZohoToken(c);
    tokenCache.set(c.user_id, t);
    return t.token;
  } catch (e) {
    const m = (e as Error).message;
    if (!/bloque/i.test(m)) await db.from("zoho_connections").update({ last_error: m.slice(0, 200) }).eq("user_id", c.user_id);
    throw e;
  }
}

async function zoho(c: Conn, path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken(c);
  const r = await fetch(`${c.api_domain}/crm/${ZV}${path}`, {
    ...init,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (r.status === 204) return {};
  const t = await r.text();
  let j: any = {};
  try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!r.ok && !(r.status === 207 || r.status === 202)) {
    const msg = j?.message ?? j?.data?.[0]?.message ?? j?.code ?? t.slice(0, 200);
    throw new Error(`Zoho ${r.status}: ${msg}`);
  }
  return j;
}

async function allConns(): Promise<Conn[]> {
  const { data } = await db.from("zoho_connections").select("*");
  return (data ?? []) as Conn[];
}
const connByEmail = (conns: Conn[], email?: string | null) =>
  email ? conns.find((c) => c.zoho_email.toLowerCase() === String(email).toLowerCase()) : undefined;

async function connByUser(userId: string): Promise<Conn> {
  const { data } = await db.from("zoho_connections").select("*").eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(400, "Conecta tu cuenta de Zoho para continuar.");
  return data as Conn;
}
async function adminConn(conns: Conn[]): Promise<Conn | undefined> {
  const { data: ow } = await db.from("app_config").select("value").eq("key", "owner_emails").maybeSingle();
  const owners = String(ow?.value ?? "").split(/[,\s]+/).map((x) => x.trim().toLowerCase());
  return conns.find((c) => owners.includes(c.zoho_email.toLowerCase())) ?? conns[0];
}

const fromCache = new Map<string, { email: string; type: string }[]>();
async function fromAddresses(c: Conn) {
  if (fromCache.has(c.user_id)) return fromCache.get(c.user_id)!;
  let list: { email: string; type: string }[] = [];
  try {
    const j = await zoho(c, "/settings/emails/actions/from_addresses");
    list = (j.from_addresses ?? []).map((a: any) => ({ email: String(a.email ?? "").toLowerCase(), type: String(a.type ?? "") }));
  } catch { /* sin permiso */ }
  fromCache.set(c.user_id, list);
  return list;
}

// ======================================================================= Formato de la herramienta (spec)
const STAGE_DATE: Record<string, Record<string, string>> = {
  Deals: { "4. Propuesta Enviada / En Negociación": "Fecha_Hora_Env_o_Propuesta", "5. Piloto": "Fecha_paso_a_Piloto", "6. Listo para Cierre": "Fecha_paso_a_Listo_para_cierre_v2" },
  Leads: { "2. Intento de contacto": "Fecha_Hora_Intento_de_Contacto", "3. Contactado": "Fecha_Hora_Contactado", "No Calificado": "Fecha_Hora_No_Calificado" },
  Contacts: {},
};
const SELECT: Record<string, string[]> = {
  Deals: ["Deal_Name", "Account_Name", "Contact_Name", "Contact_Email", "Owner", "Stage"],
  Leads: ["First_Name", "Last_Name", "Full_Name", "Company", "Email", "Owner", "Lead_Status"],
  Contacts: ["First_Name", "Last_Name", "Full_Name", "Account_Name", "Email", "Owner", "Contact_Status"],
};
const selectOf = (module: string) => [...SELECT[module], ...(ZCAD[module] ? [ZCAD[module]] : []), ...(CADF[module] ? [CADF[module]] : [])];
const ENROLLED = "__enrolled";
const STAGE_PFX = "__stage:";
const DAY = 86400_000;
const MIN_GAP = 20 * 3600_000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const wdMX = (t: number) => WD.indexOf(new Intl.DateTimeFormat("en-US", { timeZone: "America/Mexico_City", weekday: "short" }).format(new Date(t)));
function addDaysMode(base: number, n: number, biz: boolean): number {
  if (!biz) return base + n * DAY;
  let t = base; let left = Math.max(0, Math.round(n));
  while (left > 0) { t += DAY; const w = wdMX(t); if (w !== 0 && w !== 6) left--; }
  return t;
}
const SENDAT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const fixedAt = (step: any): number | null => { const v = String(step?.req?.sendAt ?? ""); if (!SENDAT_RE.test(v)) return null; const t = Date.parse(v + ":00-06:00"); return Number.isNaN(t) ? null : t; };
const dueOf = (step: any, anchorMs: number, biz: boolean) => fixedAt(step) ?? addDaysMode(anchorMs, Number(step?.day_offset ?? 0), biz);
const nextDueOf = (next: any, anchorMs: number, biz: boolean) => { const f = fixedAt(next); return f !== null ? Math.max(f, Date.now()) : Math.max(addDaysMode(anchorMs, Number(next?.day_offset ?? 0), biz), Date.now() + MIN_GAP); };

type Cond = { field: string; op: string; value: any; byTrigger?: boolean; meta?: any };
const escZ = (v: unknown) => String(v).replace(/([(),\\])/g, "\\$1");
const DATE_OP: Record<string, string> = { last_days: "greater_equal", older_days: "less_than", greater_equal: "greater_equal", less_equal: "less_equal" };
function zDateVal(c: Cond): string | null {
  const dt = c.meta?.dtype ?? "date";
  let ymd: string;
  if (c.op === "last_days" || c.op === "older_days") { const n = Math.max(0, Number(c.value) || 0); ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - n * DAY)); }
  else ymd = String(c.value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return dt === "datetime" ? ymd + (c.op === "less_equal" ? "T23:59:59-06:00" : "T00:00:00-06:00") : ymd;
}
function buildCriteria(conds: Cond[]): string | null {
  const parts: string[] = [];
  for (const c of conds ?? []) {
    if (!c?.field || !c.op) continue;
    if (c.meta?.type === "date" || c.op === "last_days" || c.op === "older_days") {
      const v = zDateVal(c); const op = DATE_OP[c.op];
      if (v && op) parts.push(`(${c.field}:${op}:${escZ(v)})`);
      continue;
    }
    if (c.op === "in") {
      const vals = (Array.isArray(c.value) ? c.value : [c.value]).filter((v) => v !== "" && v != null);
      if (!vals.length) continue;
      parts.push(vals.length === 1 ? `(${c.field}:equals:${escZ(vals[0])})` : "(" + vals.map((v) => `(${c.field}:equals:${escZ(v)})`).join("or") + ")");
    } else if (c.op === "not_in") {
      const vals = (Array.isArray(c.value) ? c.value : [c.value]).filter((v) => v !== "" && v != null);
      if (!vals.length) continue;
      parts.push(vals.length === 1 ? `(${c.field}:not_equal:${escZ(vals[0])})` : "(" + vals.map((v) => `(${c.field}:not_equal:${escZ(v)})`).join("and") + ")");
    } else {
      if (c.value === undefined || c.value === null || c.value === "") continue;
      parts.push(`(${c.field}:${c.op}:${escZ(c.value)})`);
    }
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : "(" + parts.join("and") + ")";
}

async function searchAll(c: Conn, module: string, criteria: string, fields: string[], maxPages = 10) {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({ criteria, fields: [...new Set(fields)].join(","), per_page: "200", page: String(page) });
    const j = await zoho(c, `/${module}/search?${qs}`);
    const rows = j.data ?? [];
    out.push(...rows);
    if (!j.info?.more_records || !rows.length) break;
  }
  return out;
}

function fieldValue(raw: any, field: string): any {
  if (field === "Tag") return (raw.Tag ?? []).map((t: any) => t?.name);
  const v = raw[field];
  if (v && typeof v === "object" && !Array.isArray(v)) return v.name ?? v.id ?? v;
  return v;
}
function evalCond(raw: any, c: Cond): boolean {
  const v = fieldValue(raw, c.field);
  const s = (x: any) => String(x ?? "").toLowerCase();
  if (c.field === "Tag") {
    const want = (Array.isArray(c.value) ? c.value : [c.value]).map(s).filter(Boolean);
    const has = (v as string[]).some((t) => want.includes(s(t)));
    return c.op === "not_in" || c.op === "not_equal" ? !has : has;
  }
  if (c.meta?.type === "date" || c.op === "last_days" || c.op === "older_days") {
    const ref = zDateVal(c); if (!ref || !v) return false;
    const a = new Date(String(v)).getTime(), b = new Date(ref.length === 10 ? ref + "T00:00:00-06:00" : ref).getTime();
    return c.op === "older_days" ? a < b : c.op === "less_equal" ? a <= b + (ref.length === 10 ? DAY - 1 : 0) : a >= b;
  }
  switch (c.op) {
    case "equals": return String(v) === String(c.value) || (typeof v === "boolean" && String(v) === String(c.value));
    case "not_equal": return String(v) !== String(c.value);
    case "in": return (Array.isArray(c.value) ? c.value : [c.value]).map(String).includes(String(v));
    case "not_in": return !(Array.isArray(c.value) ? c.value : [c.value]).map(String).includes(String(v));
    case "starts_with": return s(v).startsWith(s(c.value));
    case "greater_than": return Number(v) > Number(c.value);
    case "greater_equal": return Number(v) >= Number(c.value);
    case "less_than": return Number(v) < Number(c.value);
    case "less_equal": return Number(v) <= Number(c.value);
    default: return true;
  }
}

function normRecord(module: string, r: any): any {
  const own = r.Owner ?? {};
  const zc = ZCAD[module] ? (r[ZCAD[module]] ?? null) : null;
  const pc = CADF[module] ? (r[CADF[module]] ?? null) : null;
  if (module === "Leads") {
    return { id: String(r.id), name: r.Full_Name ?? null, first: r.First_Name ?? "", last: r.Last_Name ?? "", contact: r.Full_Name ?? null, email: r.Email ?? null,
      account: r.Company ?? null, accountId: null, owner: own.name ?? null, ownerEmail: own.email ?? null, stage: r.Lead_Status ?? null, zcad: zc, pcad: pc };
  }
  if (module === "Contacts") {
    return { id: String(r.id), name: r.Full_Name ?? null, first: r.First_Name ?? "", last: r.Last_Name ?? "", contact: r.Full_Name ?? null, email: r.Email ?? null,
      account: r.Account_Name?.name ?? null, accountId: r.Account_Name?.id ?? null, owner: own.name ?? null, ownerEmail: own.email ?? null, stage: r.Contact_Status ?? null, zcad: zc, pcad: pc };
  }
  const name = r.Deal_Name ?? null;
  return { id: String(r.id), name, first: "", last: "", contact: r.Contact_Name?.name ?? null, contactId: r.Contact_Name?.id ?? null, email: r.Contact_Email ?? null,
    account: r.Account_Name?.name ?? (name ? String(name).split(" - ")[0].trim() : null), accountId: r.Account_Name?.id ?? null,
    owner: own.name ?? null, ownerEmail: own.email ?? null, stage: r.Stage ?? null, zcad: zc, pcad: pc };
}

async function enrichRecords(c: Conn, module: string, recs: any[]) {
  if (module === "Deals") {
    const ids = [...new Set(recs.map((r) => r.contactId).filter(Boolean))];
    const map = new Map<string, any>();
    const cf = ["First_Name", "Last_Name", "Full_Name", "Email", ...(CADF.Contacts ? [CADF.Contacts] : [])].join(",");
    for (let i = 0; i < ids.length; i += 100) {
      const j = await zoho(c, `/Contacts?ids=${ids.slice(i, i + 100).join(",")}&fields=${cf}`);
      (j.data ?? []).forEach((x: any) => map.set(String(x.id), x));
    }
    recs.forEach((r) => {
      const ct = r.contactId ? map.get(String(r.contactId)) : null;
      r.first = ct?.First_Name ?? String(r.contact ?? "").split(" ")[0] ?? "";
      r.last = ct?.Last_Name ?? String(r.contact ?? "").split(" ").slice(1).join(" ");
      r.contact = ct?.Full_Name ?? r.contact;
      r.email = ct?.Email ?? r.email;
      if (CADF.Contacts && ct) r.contactPcad = ct[CADF.Contacts] ?? null;
    });
  } else {
    recs.forEach((r) => { if (!r.first) r.first = String(r.contact ?? "").split(" ")[0]; });
  }
  const accIds = [...new Set(recs.map((r) => r.accountId).filter(Boolean))];
  const accMap = new Map<string, any>();
  for (let i = 0; i < accIds.length; i += 100) {
    try {
      const j = await zoho(c, `/Accounts?ids=${accIds.slice(i, i + 100).join(",")}&fields=Account_Name,Owner`);
      (j.data ?? []).forEach((x: any) => accMap.set(String(x.id), x));
    } catch { /* sin acceso a cuentas */ }
  }
  recs.forEach((r) => { const a = r.accountId ? accMap.get(String(r.accountId)) : null; r.accountOwner = a?.Owner?.name ?? null; r.accountOwnerEmail = a?.Owner?.email ?? null; });
}

async function stageEnteredAt(c: Conn, dealId: string, stage: string): Promise<string | null> {
  try {
    const j = await zoho(c, `/Deals/${dealId}/Stage_History?fields=Stage,Modified_Time&per_page=50`);
    const hits = (j.data ?? []).filter((h: any) => h.Stage === stage && h.Modified_Time).map((h: any) => h.Modified_Time).sort();
    return hits.length ? hits[hits.length - 1] : null;
  } catch { return null; }
}

function mergeMap(module: string, rec: any, sender: Conn | null, extra: Record<string, string> = {}) {
  const firstOf = (n?: string | null) => String(n ?? "").trim().split(/\s+/)[0] ?? "";
  const xl: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec.extra ?? {})) xl[`Excel.${k}`] = String(v ?? "");
  return {
    "Contacts.First Name": rec.first ?? "", "Contacts.Last Name": rec.last ?? "", "Contacts.Email": rec.email ?? "",
    "Contacts.Contact Owner": rec.owner ?? "", "Accounts.Account Name": rec.account ?? "", "Accounts.Account Owner": rec.accountOwner ?? rec.owner ?? "",
    "Deals.Deal Name": rec.name ?? "", "Deals.Deal Owner": rec.owner ?? "", "Deals.Stage": rec.stage ?? "",
    "Leads.First Name": rec.first ?? "", "Leads.Last Name": rec.last ?? "", "Leads.Email": rec.email ?? "", "Leads.Company": rec.account ?? "", "Leads.Lead Owner": rec.owner ?? "",
    "User.First Name": firstOf(sender?.zoho_name), "User.Email": sender?.zoho_email ?? "",
    "Ejecutivo.Agenda": /^https?:\/\//i.test(String(rec.meeting ?? "")) ? String(rec.meeting) : "",
    "companyLogo": "",
    ...xl,
    ...extra,
  } as Record<string, string>;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ISO_URL = "https://7742864.fs1.hubspotusercontent-na1.net/hubfs/7742864/Iso%20Original-1.png";
const ea = (v: string) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function sigHtml(name: string, email: string, p: Prof = {}) {
  const meet = meetOf(p);
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:18px;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse"><tr>` +
    `<td style="padding:0 14px 0 0;vertical-align:middle"><img src="${ISO_URL}" width="46" height="46" alt="GeoVictoria" style="display:block;border:0;width:46px;height:46px"></td>` +
    `<td style="padding:0 18px 0 0;vertical-align:middle;border-right:1px solid #c4c8cf"><div style="font-size:14px;font-weight:bold;color:#4e4e4e;line-height:1.35">${ea(name)}</div>${p.title ? `<div style="font-size:13px;color:#4e4e4e;line-height:1.35">${ea(p.title)}</div>` : ""}<div style="font-size:13px;color:#646464;line-height:1.35">GeoVictoria</div></td>` +
    `<td style="padding:0 0 0 18px;vertical-align:middle;font-size:13px;line-height:1.6">${email ? `<a href="mailto:${ea(email)}" style="color:#1d5d90;text-decoration:underline">${ea(email)}</a><br>` : ""}${p.phone ? `<span style="color:#4e4e4e">${ea(p.phone)}</span><br>` : ""}${meet ? `<a href="${ea(meet)}" style="color:#1d5d90;text-decoration:underline">Agenda una reunión</a><br>` : ""}<a href="https://www.geovictoria.com" style="color:#1d5d90;text-decoration:underline">www.geovictoria.com</a></td>` +
    `</tr></table>`;
}
function sigHtmlHs() {
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:18px;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse"><tr>` +
    `<td style="padding:0 14px 0 0;vertical-align:middle"><img src="${ISO_URL}" width="46" height="46" alt="GeoVictoria" style="display:block;border:0;width:46px;height:46px"></td>` +
    `<td style="padding:0 18px 0 0;vertical-align:middle;border-right:1px solid #c4c8cf"><div style="font-size:14px;font-weight:bold;color:#4e4e4e;line-height:1.35">{{ custom.v_sig_name }}</div><div style="font-size:13px;color:#4e4e4e;line-height:1.35">{{ custom.v_sig_title }}</div><div style="font-size:13px;color:#646464;line-height:1.35">GeoVictoria</div></td>` +
    `<td style="padding:0 0 0 18px;vertical-align:middle;font-size:13px;line-height:1.6"><a href="mailto:{{ custom.v_sig_email }}" style="color:#1d5d90;text-decoration:underline">{{ custom.v_sig_email }}</a><div style="color:#4e4e4e">{{ custom.v_sig_phone }}</div><div><a href="{{ custom.v_sig_meeting }}" style="color:#1d5d90;text-decoration:underline">{{ custom.v_sig_meeting_label }}</a></div><a href="https://www.geovictoria.com" style="color:#1d5d90;text-decoration:underline">www.geovictoria.com</a></td>` +
    `</tr></table>`;
}
const FILES_URL = `${SUPABASE_URL}/functions/v1/files?id=`;
function filesHtml(files: any): string {
  const list = (Array.isArray(files) ? files : []).filter((f: any) => f?.id && f?.name);
  if (!list.length) return "";
  const kb = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:6px 0 4px;border-collapse:separate;font-family:Arial,Helvetica,sans-serif">` +
    list.map((f: any) => `<tr><td style="padding:4px 0"><a href="${FILES_URL}${encodeURIComponent(f.id)}" style="display:inline-block;padding:10px 14px;border:1px solid #dfe2e7;border-radius:8px;color:#1d5d90;font-size:14px;font-weight:bold;text-decoration:none">&#128206; ${ea(f.name)} <span style="color:#9aa0a8;font-weight:normal;font-size:12px">&middot; ${f.size ? kb(Number(f.size)) + " &middot; " : ""}Descargar</span></a></td></tr>`).join("") +
    `</table>`;
}
const isHtml = (s: string) => /<\s*(html|body|table|div|p|br|span|td)\b/i.test(s);
function renderSubject(tpl: string, m: Record<string, string>) {
  return tpl.replace(/\$\{([^}\n]+)\}/g, (_, k) => (k === "userSignature" ? "" : (m[k] ?? ""))).replace(/\s{2,}/g, " ").trim();
}
function renderBody(tpl: string, m: Record<string, string>, signatureHtml: string) {
  if (isHtml(tpl)) {
    return tpl.replace(/\$\{([^}\n]+)\}/g, (_, k) => (k === "userSignature" ? signatureHtml : esc(m[k] ?? "")));
  }
  const SIG = "\u0000SIG\u0000";
  const filled = tpl.replace(/\$\{([^}\n]+)\}/g, (_, k) => (k === "userSignature" ? SIG : (m[k] ?? "")));
  const html = esc(filled).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px 0">${p.replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#333">${html.split(SIG).join(signatureHtml)}</div>`;
}

function inWindow(w: any): boolean {
  const tz = w?.tz ?? "America/Mexico_City";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")!.value;
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  const days: number[] = w?.days ?? [1, 2, 3, 4, 5];
  return days.includes(day) && hour >= (w?.start_hour ?? 9) && hour < (w?.end_hour ?? 18);
}

async function exitEnrollment(id: string, reason: string, status = "exited") {
  await db.from("enrollments").update({ status, exit_reason: reason, next_due_at: null, updated_at: new Date().toISOString() }).eq("id", id);
}

function hsDeadReason(msg: string): string | null {
  const m = String(msg ?? "");
  if (/UNSUBSCRIBED/i.test(m)) return "Se dio de baja en HubSpot: no recibe correos de marketing";
  if (/INVALID_EMAIL|no es válida|not a valid email/i.test(m)) return "Correo no válido";
  if (/BLOCKED_DOMAIN|PREVIOUS_SPAM|PREVIOUSLY_BOUNCED/i.test(m)) return "HubSpot bloquea los envíos a este correo (rebote o reclamo anterior)";
  return null;
}

// ======================================================================= Lista desde un Excel
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function listBase(r: any) {
  const nm = String(r?.name ?? "").trim(); const parts = nm.split(/\s+/).filter(Boolean);
  const meet = String(r?.meeting ?? "").trim();
  return { first: parts[0] ?? "", last: parts.slice(1).join(" "), contact: nm || null, email: String(r?.email ?? "").trim().toLowerCase(),
    account: String(r?.company ?? "").trim() || null, owner: String(r?.ownerName ?? "").trim() || null,
    ownerEmail: String(r?.ownerEmail ?? "").trim().toLowerCase() || null, meeting: /^https?:\/\//i.test(meet) ? meet : null, extra: r?.extra ?? {} };
}
// Prospección externa: crea en Zoho los prospectos que no existen, a nombre de quien creó la cadencia
async function enrollProspects(cad: any, spec: any, steps: any[], conn: Conn, biz: boolean, stats: any) {
  const settings = spec.settings ?? {};
  const rawSrc = String(settings.prospectSource || "").trim();
  const src = (!rawSrc || rawSrc === "__otra" ? "Prospección externa" : rawSrc).slice(0, 60);
  const seen = new Set<string>();
  const rows = (spec.list?.rows ?? []).filter((r: any) => { const e = String(r?.email ?? "").trim().toLowerCase(); if (!EMAIL_RE.test(e) || seen.has(e)) return false; seen.add(e); return true; }).slice(0, 500);
  const now = Date.now(); const firstAt = dueOf(steps[0], now, biz);
  const creatorEmail = String(cad.created_by_email ?? "").toLowerCase();
  const ownerId = await zohoUserId(conn, creatorEmail);
  const ownerName = userNames.get(normMail(creatorEmail)) ?? creatorEmail;
  let leadSource: string | null = null;
  try {
    const meta = await zoho(conn, `/settings/fields?module=Leads`);
    const f = (meta.fields ?? []).find((x: any) => x.api_name === "Lead_Source");
    const vals = (f?.pick_list_values ?? []).map((p: any) => String(p.actual_value ?? p.display_value ?? "")).filter((v: string) => v && v !== "-None-");
    leadSource = vals.find((v: string) => fold(v) === fold(src)) ?? vals.find((v: string) => fold(v).includes(fold(src)) || fold(src).includes(fold(v))) ?? null;
  } catch { /* sin metadatos */ }
  // ¿ya existen en Zoho? (prospectos y contactos)
  const existing = new Map<string, { mod: string; owner: string }>();
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10).map((r: any) => String(r.email).trim().toLowerCase());
    const crit = chunk.length === 1 ? `(Email:equals:${escZ(chunk[0])})` : "(" + chunk.map((e: string) => `(Email:equals:${escZ(e)})`).join("or") + ")";
    for (const mod of ["Leads", "Contacts"]) {
      try { (await searchAll(conn, mod, crit, ["Email", "Owner"], 1)).forEach((x: any) => { const e = String(x.Email ?? "").toLowerCase(); if (e && !existing.has(e)) existing.set(e, { mod, owner: String(x.Owner?.name ?? "") }); }); }
      catch (e) { if (/bloque/i.test((e as Error).message)) throw e; }
    }
  }
  const toCreate = rows.filter((r: any) => !existing.has(String(r.email).trim().toLowerCase()));
  const created = new Map<string, string>(); const createErr = new Map<string, string>();
  for (let i = 0; i < toCreate.length; i += 100) {
    const chunk = toCreate.slice(i, i + 100);
    const data = chunk.map((r: any) => {
      const b = listBase(r);
      const rec: any = { Email: b.email, Last_Name: (b.last || b.first || b.email.split("@")[0]).slice(0, 80), Lead_Status: "1. No contactado",
        Fuente_del_Lead: src, Description: `Creado desde Cadencias · Prospección externa (${src}) · ${cad.code ?? ""} ${cad.name ?? ""}`.trim().slice(0, 500) };
      if (b.first && b.last) rec.First_Name = b.first.slice(0, 40);
      if (b.account) rec.Company = b.account.slice(0, 100);
      const t = tldTerr(b.email); if (t) rec.Territorio = t;
      if (leadSource) rec.Lead_Source = leadSource;
      if (ownerId) rec.Owner = { id: ownerId };
      return rec;
    });
    try {
      const res = await zoho(conn, "/Leads", { method: "POST", body: JSON.stringify({ data, trigger: [] }) });
      (res.data ?? []).forEach((x: any, k: number) => {
        const e = String(chunk[k]?.email ?? "").trim().toLowerCase();
        if (x.status === "success" && x.details?.id) created.set(e, String(x.details.id));
        else createErr.set(e, `${x.message ?? x.code ?? "Zoho no lo creó"}${x.details?.api_name ? " (" + x.details.api_name + ")" : ""}`.slice(0, 160));
      });
    } catch (e) { chunk.forEach((r: any) => createErr.set(String(r.email).trim().toLowerCase(), (e as Error).message.slice(0, 160))); if (/bloque/i.test((e as Error).message)) break; }
  }
  const out = rows.map((r: any) => {
    const b = listBase(r); const id = created.get(b.email); const ex = existing.get(b.email);
    const record = { id: id ?? `xl:${b.email}`, name: b.contact ?? b.email, first: b.first, last: b.last, contact: b.contact, email: b.email, account: b.account,
      owner: ownerName, ownerEmail: creatorEmail, stage: "1. No contactado", meeting: b.meeting, extra: b.extra, prospect: true };
    return {
      cadence_id: cad.id, deal_id: id ?? `xl:${b.email}`, deal_name: b.contact ?? b.email, account_name: b.account ?? null, stage: id ? "1. No contactado" : null,
      contact_name: b.contact ?? null, contact_first_name: b.first ?? null, contact_email: b.email, owner_name: ownerName, owner_email: creatorEmail,
      record, anchor_at: new Date(now).toISOString(), current_step: 0,
      status: id ? "active" : "skipped",
      exit_reason: id ? null : ex ? `Ya existe en Zoho como ${ex.mod === "Leads" ? "prospecto" : "contacto"}${ex.owner ? ` (dueño: ${ex.owner})` : ""}: no se duplicó` : `No se pudo crear en Zoho: ${createErr.get(b.email) ?? "sin detalle"}`,
      next_due_at: id ? new Date(Math.max(firstAt, now)).toISOString() : null,
    };
  });
  for (let i = 0; i < out.length; i += 500) await db.from("enrollments").upsert(out.slice(i, i + 500), { onConflict: "cadence_id,deal_id", ignoreDuplicates: true });
  await db.from("cadences").update({ snapshot_at: new Date().toISOString() }).eq("id", cad.id);
  stats.prospects_created = created.size; stats.already_in_zoho = existing.size; stats.create_failed = createErr.size;
  stats.enrolled = created.size; stats.snapshot = `prospección externa (${src})`;
}
async function enrollList(cad: any, spec: any, module: string, steps: any[], conn: Conn, viaHubspot: boolean, biz: boolean, stats: any) {
  if (spec.settings?.prospect) return await enrollProspects(cad, spec, steps, conn, biz, stats);
  const seen = new Set<string>();
  const rows = (spec.list?.rows ?? []).filter((r: any) => { const e = String(r?.email ?? "").trim().toLowerCase(); if (!EMAIL_RE.test(e) || seen.has(e)) return false; seen.add(e); return true; }).slice(0, 2000);
  const now = Date.now(); const firstAt = dueOf(steps[0], now, biz);
  const recs: any[] = [];
  if (viaHubspot) {
    for (const r of rows) { const b = listBase(r); recs.push({ id: `xl:${b.email}`, name: b.contact ?? b.email, stage: null, ...b, _ok: true }); }
  } else {
    const ef = module === "Deals" ? "Contact_Email" : "Email";
    const found = new Map<string, any>();
    const lim = Math.min(rows.length, 1000);
    for (let i = 0; i < lim; i += 10) {
      const chunk = rows.slice(i, Math.min(i + 10, lim));
      const crit = chunk.length === 1 ? `(${ef}:equals:${escZ(String(chunk[0].email).toLowerCase())})` : "(" + chunk.map((r: any) => `(${ef}:equals:${escZ(String(r.email).trim().toLowerCase())})`).join("or") + ")";
      try {
        const raws = await searchAll(conn, module, crit, selectOf(module), 1);
        for (const raw of raws) { const e = String(raw[ef] ?? "").toLowerCase(); if (e && !found.has(e)) found.set(e, raw); }
      } catch (e) { stats.list_search_error = (e as Error).message.slice(0, 200); }
    }
    const matched: any[] = [];
    rows.forEach((r: any, i: number) => {
      const b = listBase(r); const raw = found.get(b.email);
      if (raw) { const rec = normRecord(module, raw); rec.extra = b.extra; rec.meeting = b.meeting; if (!rec.first) rec.first = b.first; if (!rec.account) rec.account = b.account; rec._ok = true; matched.push(rec); recs.push(rec); }
      else recs.push({ id: `xl:${b.email}`, name: b.contact ?? b.email, stage: null, ...b, _ok: false, _late: i >= lim });
    });
    if (matched.length) await enrichRecords(conn, module, matched);
  }
  const byId = new Map<string, any>();
  for (const rec of recs) if (!byId.has(String(rec.id))) byId.set(String(rec.id), rec);
  const out = [...byId.values()].map((rec) => {
    const { _ok, _late, ...record } = rec;
    return {
      cadence_id: cad.id, deal_id: String(rec.id), deal_name: rec.name ?? rec.email, account_name: rec.account ?? null, stage: rec.stage ?? null,
      contact_name: rec.contact ?? null, contact_first_name: rec.first ?? null, contact_email: rec.email ?? null, owner_name: rec.owner ?? null, owner_email: rec.ownerEmail ?? null,
      record, anchor_at: new Date(now).toISOString(), current_step: 0,
      status: _ok ? "active" : "skipped",
      exit_reason: _ok ? null : (_late ? "El archivo tiene más de 1.000 filas: solo se buscan en Zoho las primeras 1.000" : `No está en Zoho (${module === "Leads" ? "Prospectos" : module === "Contacts" ? "Contactos" : "Tratos"})`),
      next_due_at: _ok ? new Date(Math.max(firstAt, now)).toISOString() : null,
    };
  });
  for (let i = 0; i < out.length; i += 500) await db.from("enrollments").upsert(out.slice(i, i + 500), { onConflict: "cadence_id,deal_id", ignoreDuplicates: true });
  await db.from("cadences").update({ snapshot_at: new Date().toISOString() }).eq("id", cad.id);
  stats.enrolled = out.filter((r) => r.status === "active").length;
  stats.not_in_zoho = out.filter((r) => r.status === "skipped").length;
  stats.snapshot = "lista del Excel tomada";
}

// ======================================================================= Reactivar o recrear prospecto / trato
const THREE_MONTHS = 91 * DAY;
const LEAD_CLEAR = ["Motivo_No_calificado", "Comentario_No_Calificado", "Fecha_Hora_No_Calificado"];
const DEAL_CLEAR = ["Raz_n_de_P_rdida", "Explicaci_n_Raz_n_P_rdida_Otro", "Fecha_de_Asistencia_Taller", "Fecha_paso_SQL_2_0", "Fecha_Hora_Env_o_Propuesta", "Fecha_Hora_Env_o_Presentaci_n_de_Propuesta", "Fecha_paso_a_Listo_para_cierre_v2", "Fecha_paso_a_Cierre_Perdido"];
const LEAD_COPY = ["Salutation", "First_Name", "Last_Name", "Company", "Email", "Phone", "Mobile", "Designation", "Website", "Industry", "No_of_Employees", "Country", "State", "City", "Street", "Lead_Source", "Fuente_del_Lead", "DB_Source_2", "Data_Source", "Fuente_Original_Hubspot", "Territorio", "Rango_de_empleados_Nuevo", "Contact_Rol", "Cargo_del_contacto"];
const SKIP_TYPES = new Set(["date", "datetime", "formula", "autonumber", "ownerlookup", "rollup_summary", "fileupload", "imageupload", "subform", "multiselectlookup", "profileimage", "event_reminder", "userlookup"]);
const SKIP_FIELDS = new Set(["id", "Owner", "Created_By", "Modified_By", "Created_Time", "Modified_Time", "Stage", "Closing_Date", "Tag", "Record_Status__s", "Last_Activity_Time", "Stage_Modified_Time", "Locked__s", "Layout", "Probability", "Expected_Revenue", "Lead_Conversion_Time", "Overall_Sales_Duration", "Sales_Cycle_Duration", "Deal_Category_Status", "Cadencia_Activada", ...DEAL_CLEAR]);
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
async function zohoWrite(c: Conn, module: string, method: string, rec: any) {
  const data = { ...rec };
  for (let i = 0; i < 6; i++) {
    const r = await zoho(c, `/${module}`, { method, body: JSON.stringify({ data: [data] }) });
    const x = r.data?.[0];
    if (x?.status === "success") return x;
    const bad = x?.details?.api_name;
    if (bad && bad in data && !["Last_Name", "Deal_Name", "Stage", "Owner", "Closing_Date", "Lead_Status", "id"].includes(bad)) { delete data[bad]; continue; }
    throw new Error(`${x?.message ?? x?.code ?? "Zoho no confirmó"}${bad ? " (" + bad + ")" : ""}`);
  }
  throw new Error("Zoho rechazó varios campos");
}
async function runReactivate(r: any) {
  const { data: run } = await db.from("engine_runs").insert({ trigger: `reactivate:${String(r?.enrollment_id ?? "").slice(0, 60)}` }).select().single();
  const stats: any = { by: r?.by ?? null };
  let error: string | null = null;
  try {
    await loadCadFields();
    const { data: e } = await db.from("enrollments").select("id, deal_id, contact_email, cadence_id, cadences(spec, module, created_by_email, code, name)").eq("id", r?.enrollment_id).maybeSingle();
    if (!e) throw new Error("No encontré a esa persona en la cadencia");
    const cad: any = (e as any).cadences ?? {};
    const module = cad.spec?.module ?? cad.module ?? "Deals";
    if (!["Leads", "Deals"].includes(module)) throw new Error("Solo aplica a prospectos y tratos");
    const id = String(e.deal_id);
    if (!/^\d+$/.test(id)) throw new Error("Esta persona no está en Zoho");
    const admin = await adminConn(await allConns()); if (!admin) throw new Error("No hay Zoho conectado en el motor");
    const owner = (await zohoUserId(admin, cad.created_by_email)) ?? (await zohoUserId(admin, r?.by));
    const j = await zoho(admin, `/${module}/${id}`); const rec = j.data?.[0];
    if (!rec) throw new Error("No encontré el registro en Zoho");
    const age = Date.now() - Date.parse(rec.Created_Time);
    stats.module = module; stats.record = id; stats.age_days = Math.round(age / DAY);
    const note = `Desde Cadencias (${cad.code ?? ""} · ${cad.name ?? ""})`;
    const fmt = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short" }).format(new Date());
    let label = "";
    if (module === "Leads") {
      if (age < THREE_MONTHS) {
        const upd: any = { id, Lead_Status: "3. Contactado", Fecha_Hora_Contactado: isoNow() };
        LEAD_CLEAR.forEach((f) => upd[f] = null);
        await zohoWrite(admin, "Leads", "PUT", upd); stats.action = "lead_reactivated"; label = `Prospecto reactivado a «3. Contactado» · ${fmt}`;
      } else {
        const nw: any = { Lead_Status: "3. Contactado", Fecha_Hora_Contactado: isoNow(), Description: `${note}: prospecto nuevo a partir del ${id}.` };
        LEAD_COPY.forEach((f) => { const v = rec[f]; if (v !== null && v !== undefined && v !== "") nw[f] = v; });
        if (!nw.Last_Name) nw.Last_Name = String(rec.Email ?? "Prospecto").split("@")[0];
        if (owner) nw.Owner = { id: owner };
        const x = await zohoWrite(admin, "Leads", "POST", nw); stats.action = "lead_created"; stats.new_id = x.details?.id; label = `Prospecto nuevo creado (más de 3 meses) · ${fmt}`;
      }
    } else {
      if (age < THREE_MONTHS) {
        const upd: any = { id, Stage: "1. Trato Creado" };
        DEAL_CLEAR.forEach((f) => upd[f] = null);
        await zohoWrite(admin, "Deals", "PUT", upd); stats.action = "deal_reactivated"; label = `Trato reactivado a «1. Trato Creado» · ${fmt}`;
      } else {
        const meta = await zoho(admin, `/settings/fields?module=Deals`);
        const nw: any = {};
        for (const f of meta.fields ?? []) {
          const k = f.api_name;
          if (!k || SKIP_FIELDS.has(k) || SKIP_TYPES.has(f.data_type) || f.read_only || f.field_read_only) continue;
          if (CADF.Deals && k === CADF.Deals) continue;
          const v = rec[k];
          if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
          nw[k] = (f.data_type === "lookup" && v && typeof v === "object") ? { id: v.id } : v;
        }
        nw.Stage = "1. Trato Creado";
        nw.Closing_Date = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
        if (!nw.Deal_Name) nw.Deal_Name = rec.Deal_Name;
        if (owner) nw.Owner = { id: owner };
        const x = await zohoWrite(admin, "Deals", "POST", nw); stats.action = "deal_created"; stats.new_id = x.details?.id; label = `Trato nuevo creado (más de 3 meses) · ${fmt}`;
      }
    }
    await db.from("enrollments").update({ zoho_action: label }).eq("id", e.id);
    stats.label = label;
  } catch (err) { error = (err as Error).message; try { await db.from("enrollments").update({ zoho_action: `No se pudo: ${error}`.slice(0, 200) }).eq("id", r?.enrollment_id); } catch { /* */ } }
  await db.from("engine_runs").update({ finished_at: new Date().toISOString(), stats, error }).eq("id", run!.id);
  return { stats, error };
}

// ======================================================================= Crear contactos en Zoho desde un Excel
const TERRS = ["Alemania", "Argentina", "Bolivia", "Brasil", "Chile", "Colombia", "Costa Rica", "Ecuador", "El Salvador", "España", "Estados Unidos", "Guatemala", "Honduras", "México", "Nicaragua", "Panamá", "Paraguay", "Perú", "Puerto Rico", "República Dominicana", "Uruguay", "Venezuela"];
const ROLES = ["Administrador de Asistencia", "Administrador en Plataforma", "Gerente / VIP", "Sub-Gerencia", "Jefatura", "Encargado", "RRHH", "Finanzas", "Operaciones", "Comercial", "TI", "Técnico", "Asistente", "Analista", "Desconocido"];
const fold = (s: any) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const TERR_ALIAS: Record<string, string> = {
  mx: "México", mex: "México", cl: "Chile", co: "Colombia", col: "Colombia", pe: "Perú", br: "Brasil", brazil: "Brasil", ar: "Argentina", uy: "Uruguay",
  ec: "Ecuador", bo: "Bolivia", py: "Paraguay", ve: "Venezuela", gt: "Guatemala", sv: "El Salvador", hn: "Honduras", ni: "Nicaragua", cr: "Costa Rica",
  pa: "Panamá", do: "República Dominicana", "rep dominicana": "República Dominicana", "r dominicana": "República Dominicana", pr: "Puerto Rico", es: "España",
  spain: "España", us: "Estados Unidos", usa: "Estados Unidos", eeuu: "Estados Unidos", "ee uu": "Estados Unidos", "united states": "Estados Unidos", de: "Alemania", germany: "Alemania",
};
function normTerr(v: any): string | null { const f = fold(v); if (!f) return null; return TERRS.find((t) => fold(t) === f) ?? TERR_ALIAS[f] ?? null; }
function tldTerr(email: string): string | null { const m = String(email).toLowerCase().match(/\.([a-z]{2})$/); return m ? (TERR_ALIAS[m[1]] ?? null) : null; }
function rangoOf(v: any): string | null {
  const s = String(v ?? "").trim(); if (!s) return null;
  const R = ["1 - 99", "100 - 199", "200 - 499", "500 - 999", "1000 - 1999", "2000 - 2999", "3000 - 4999", "5000+"];
  const hit = R.find((r) => fold(r) === fold(s)); if (hit) return hit;
  const n = Number(s.replace(/[^\d]/g, "")); if (!n || !Number.isFinite(n)) return null;
  return n < 100 ? R[0] : n < 200 ? R[1] : n < 500 ? R[2] : n < 1000 ? R[3] : n < 2000 ? R[4] : n < 3000 ? R[5] : n < 5000 ? R[6] : R[7];
}
async function runImport(p: any) {
  if (p?.reactivate) return await runReactivate(p.reactivate);
  const deadline = Date.now() + 100_000;
  const file = String(p?.file ?? "Excel").slice(0, 80);
  const uploader = String(p?.uploader ?? "").toLowerCase().trim();
  const { data: run } = await db.from("engine_runs").insert({ trigger: `import:${file}`.slice(0, 120) }).select().single();
  const stats: any = { file, uploader, part: Number(p?.part ?? 1), rows: 0, created: 0, existing: 0, invalid: 0, blocked: 0, failed: 0, no_territory: 0, territories: {}, owner: null, errors: [] as string[] };
  let error: string | null = null;
  try {
    BLOCKED = await loadBlocked();
    const admin = await adminConn(await allConns());
    if (!admin) throw new Error("No hay Zoho conectado en el motor");
    const users = new Map<string, { id: string; terr: string | null; name: string }>();
    for (let page = 1; page <= 3; page++) {
      const j = await zoho(admin, `/users?type=ActiveUsers&per_page=200&page=${page}`);
      for (const u of j.users ?? []) users.set(String(u.email ?? "").toLowerCase(), { id: String(u.id), terr: u.Territorio ?? null, name: String(u.full_name ?? u.email ?? "") });
      if (!j.info?.more_records) break;
    }
    const up = users.get(uploader);
    const owner = up ?? users.get(DEFAULT_OWNER_EMAIL);
    stats.owner = owner ? (up ? uploader : DEFAULT_OWNER_EMAIL) : null;
    const seen = new Set<string>(); const rows: any[] = [];
    for (const r of (Array.isArray(p?.rows) ? p.rows : []).slice(0, 2000)) {
      const e = String(r?.email ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(e)) { stats.invalid++; continue; }
      if (blockedDomain(e)) { stats.blocked++; continue; }
      if (seen.has(e)) continue; seen.add(e); rows.push({ ...r, email: e });
    }
    stats.rows = rows.length;
    for (let i = 0; i < rows.length; i += 100) {
      if (Date.now() > deadline) {
        const rest = rows.slice(i);
        stats.continued = rest.length;
        try { await db.rpc("import_contacts", { p: { ...p, rows: rest, part: stats.part + 1 } }); } catch (e) { stats.errors.push("No se pudo continuar: " + (e as Error).message.slice(0, 100)); }
        break;
      }
      const chunk = rows.slice(i, i + 100);
      const exists = new Set<string>();
      for (let k = 0; k < chunk.length; k += 10) {
        const part = chunk.slice(k, k + 10);
        const crit = part.length === 1 ? `(Email:equals:${escZ(part[0].email)})` : "(" + part.map((r) => `(Email:equals:${escZ(r.email)})`).join("or") + ")";
        try { (await searchAll(admin, "Contacts", crit, ["Email"], 1)).forEach((x: any) => exists.add(String(x.Email ?? "").toLowerCase())); }
        catch (e) { if (/bloque/i.test((e as Error).message)) throw e; }
      }
      const fresh = chunk.filter((r) => !exists.has(r.email));
      stats.existing += chunk.length - fresh.length;
      if (!fresh.length) continue;
      const names = [...new Set(fresh.map((r) => String(r.company ?? "").trim()).filter(Boolean))].slice(0, 100);
      const acc = new Map<string, string>();
      for (let k = 0; k < names.length; k += 10) {
        const part = names.slice(k, k + 10);
        const crit = part.length === 1 ? `(Account_Name:equals:${escZ(part[0])})` : "(" + part.map((n) => `(Account_Name:equals:${escZ(n)})`).join("or") + ")";
        try { (await searchAll(admin, "Accounts", crit, ["Account_Name"], 1)).forEach((a: any) => { const key = fold(a.Account_Name); if (!acc.has(key)) acc.set(key, String(a.id)); }); } catch { /* sin cuenta */ }
      }
      const data = fresh.map((r) => {
        const nm = String(r.name ?? "").trim().split(/\s+/).filter(Boolean);
        const first = String(r.first ?? "").trim() || (nm.length > 1 ? nm[0] : "");
        const last = String(r.last ?? "").trim() || (nm.length > 1 ? nm.slice(1).join(" ") : nm[0] ?? "") || r.email.split("@")[0];
        const kam = users.get(String(r.ownerEmail ?? "").toLowerCase());
        const terr = normTerr(r.territorio) ?? tldTerr(r.email) ?? normTerr(kam?.terr) ?? normTerr(up?.terr);
        const rec: any = { Email: r.email, Last_Name: last.slice(0, 80), Description: `Creado desde Cadencias (archivo «${file}»)${uploader ? " por " + uploader : ""}.` };
        if (first) rec.First_Name = first.slice(0, 40);
        if (terr) { rec.Territorio = terr; stats.territories[terr] = (stats.territories[terr] ?? 0) + 1; } else stats.no_territory++;
        if (ROLES.includes(String(r.rol ?? ""))) rec.Contact_Rol = r.rol;
        if (r.cargo) rec.Cargo_del_contacto = String(r.cargo).slice(0, 250);
        const rg = rangoOf(r.empleados); if (rg) rec.Rango_de_empleados_Nuevo = rg;
        if (r.phone) rec.Phone = String(r.phone).slice(0, 30);
        if (r.mobile) rec.Mobile = String(r.mobile).slice(0, 30);
        if (owner) rec.Owner = { id: owner.id };
        const accId = r.company ? acc.get(fold(r.company)) : undefined; if (accId) rec.Account_Name = { id: accId };
        return rec;
      });
      try {
        const res = await zoho(admin, "/Contacts", { method: "POST", body: JSON.stringify({ data, trigger: [] }) });
        (res.data ?? []).forEach((x: any) => {
          if (x.status === "success") stats.created++;
          else { stats.failed++; if (stats.errors.length < 8) stats.errors.push(`${x.message ?? x.code ?? "error"}${x.details?.api_name ? " (" + x.details.api_name + ")" : ""}`.slice(0, 140)); }
        });
      } catch (e) { stats.failed += data.length; if (stats.errors.length < 8) stats.errors.push((e as Error).message.slice(0, 160)); if (/bloque/i.test((e as Error).message)) throw e; }
    }
  } catch (e) { error = (e as Error).message; }
  await db.from("engine_runs").update({ finished_at: new Date().toISOString(), stats, error }).eq("id", run!.id);
  return { stats, error };
}

// ======================================================================= Envío de prueba
async function testContext(c: Conn): Promise<string> {
  const { data } = await db.from("app_config").select("value").eq("key", "auth_mail_record").maybeSingle();
  if (data?.value) return String(data.value);
  const found = await zoho(c, `/Contacts/search?${new URLSearchParams({ criteria: "(Last_Name:equals:Cadencias Accesos)", fields: "Last_Name" })}`);
  let id = found.data?.[0]?.id;
  if (!id) {
    const made = await zoho(c, "/Contacts", { method: "POST", body: JSON.stringify({ data: [{ First_Name: "Sistema", Last_Name: "Cadencias Accesos", Description: "Registro técnico: aquí quedan los correos de acceso y de prueba de la app de Cadencias. No borrar." }] }) });
    id = made.data?.[0]?.details?.id;
  }
  if (!id) throw new Error("No se pudo preparar el registro técnico de Zoho para las pruebas");
  await db.from("app_config").upsert({ key: "auth_mail_record", value: String(id) });
  return String(id);
}
async function runTest(t: any) {
  const to = String(t?.to ?? "").toLowerCase().trim();
  const { data: run } = await db.from("engine_runs").insert({ trigger: `test:${to}`.slice(0, 120) }).select().single();
  const stats: any = { to, cadence: t?.name ?? null, sent: 0, errors: [] as string[] };
  let error: string | null = null;
  try {
    await loadProfiles();
    const { data: dom } = await db.from("app_config").select("value").eq("key", "allowed_login_domains").maybeSingle();
    const domains = String(dom?.value ?? "geovictoria.com").split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    if (!EMAIL_RE.test(to) || !domains.includes(to.split("@")[1])) throw new Error("Las pruebas solo pueden ir a un correo de GeoVictoria");
    const conns = await allConns();
    const admin = await adminConn(conns);
    if (!admin) throw new Error("No hay Zoho conectado en el motor");
    const module = ["Deals", "Leads", "Contacts"].includes(t.module) ? t.module : "Deals";
    const settings = t.settings ?? {};
    let rec: any = {};
    if (t.recordId && /^\d+$/.test(String(t.recordId))) {
      try {
        const j = await zoho(admin, `/${module}/${t.recordId}?fields=${SELECT[module].join(",")}`);
        const raw = j.data?.[0];
        if (raw) { const r = normRecord(module, raw); await enrichRecords(admin, module, [r]); rec = r; }
      } catch { /* sin datos de muestra */ }
    } else if (t.row && t.row.email) {
      rec = listBase(t.row);
    }
    const hs = settings.channel === "hubspot";
    const fixedHs = hs && (settings.hsSender ?? "owner") !== "owner";
    const mode = settings.sender ?? "owner";
    let sigName = rec.owner ?? admin.zoho_name ?? admin.zoho_email; let sigMail = rec.ownerEmail ?? admin.zoho_email;
    if (fixedHs) { sigName = settings.hsFromName || "GeoVictoria"; sigMail = settings.hsFromEmail || admin.zoho_email; }
    else if (!hs && mode === "account_owner") { sigName = rec.accountOwner ?? sigName; sigMail = rec.accountOwnerEmail ?? sigMail; }
    else if (!hs && (mode === "user" || mode === "custom") && settings.senderEmail) { sigName = settings.senderName || connByEmail(conns, settings.senderEmail)?.zoho_name || settings.senderEmail; sigMail = settings.senderEmail; }
    const prof = profOf(sigMail);
    const ctxId = await testContext(admin);
    const steps = (Array.isArray(t.steps) ? t.steps : []).slice(0, 12);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      try {
        const m = mergeMap(module, rec, admin, { "User.First Name": String(sigName).trim().split(/\s+/)[0] ?? "", "User.Email": String(sigMail) });
        if (!m["Ejecutivo.Agenda"] && meetOf(prof)) m["Ejecutivo.Agenda"] = meetOf(prof);
        const fileBlock = filesHtml(s.files);
        const sig = fileBlock + sigHtml(String(sigName), String(sigMail), sigProf(prof, settings));
        const subject = renderSubject(String(s.subject ?? ""), m);
        const content = renderBody(String(s.body ?? ""), m, sig) + (String(s.body ?? "").includes("${userSignature}") ? "" : fileBlock);
        const r = await zoho(admin, `/Contacts/${ctxId}/actions/send_mail`, { method: "POST", body: JSON.stringify({ data: [{
          from: { user_name: String(sigName), email: admin.zoho_email }, to: [{ user_name: to, email: to }], subject, content, mail_format: "html" }] }) });
        if (r.data?.[0]?.status !== "success") throw new Error(r.data?.[0]?.message ?? "Zoho no confirmó el envío");
        stats.sent++;
      } catch (e) { stats.errors.push(`Correo ${i + 1}: ${(e as Error).message}`.slice(0, 200)); }
    }
  } catch (e) { error = (e as Error).message; }
  await db.from("engine_runs").update({ finished_at: new Date().toISOString(), stats, error }).eq("id", run!.id);
  return { stats, error };
}

// ======================================================================= HubSpot
async function hsApi(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`https://api.hubapi.com${path}`, { ...init, headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (r.status === 204) return {};
  const t = await r.text(); let j: any = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`HubSpot ${r.status}: ${j?.message ?? t.slice(0, 200)}`);
  return j;
}
const hsKey = (k: string) => "v_" + k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function hsSubject(tpl: string) { return String(tpl ?? "").replace(/\$\{([^}\n]+)\}/g, (_, k) => k === "companyLogo" ? "" : `{{ custom.${hsKey(k)} }}`); }
function hsBody(tpl: string, files?: any) {
  const toks: string[] = [];
  const fileBlock = filesHtml(files);
  const hasSig = String(tpl ?? "").includes("${userSignature}");
  const marked = String(tpl ?? "").replace(/\$\{([^}\n]+)\}/g, (_, k) => { if (k === "companyLogo") return ""; toks.push(k === "userSignature" ? fileBlock + sigHtmlHs() : `{{ custom.${hsKey(k)} }}`); return `\u0000${toks.length - 1}\u0000`; });
  const back = (h: string) => h.replace(/\u0000(\d+)\u0000/g, (_, i) => toks[Number(i)]);
  if (isHtml(marked)) return back(marked) + (hasSig ? "" : fileBlock);
  const P = `style="margin:0 0 12px 0; font-size:15px; line-height:160%;"`;
  return back(esc(marked).split(/\n{2,}/).map((p) => `<p ${P}>${p.replace(/\n/g, "<br>")}</p>`).join("\n")) + (hasSig ? "" : fileBlock);
}
function hsContent(html: string, preview: string) {
  return {
    templatePath: "@hubspot/email/dnd/welcome.html",
    flexAreas: { main: { boxFirstElementIndex: null, boxLastElementIndex: null, boxed: false, isSingleColumnFullWidth: false, sections: [
      { columns: [{ id: "column-1-0", widgets: ["module-1-0-0"], width: 12 }], id: "section-1", style: { backgroundType: "CONTENT", paddingBottom: "30px", paddingTop: "30px" } },
      { columns: [{ id: "column-2-0", widgets: ["module-2-0-0"], width: 12 }], id: "section-2", style: { backgroundColor: "", backgroundType: "CONTENT", paddingBottom: "20px", paddingTop: "20px" } },
    ] } },
    widgets: {
      "module-1-0-0": { body: { css_class: "dnd-module", hs_enable_module_padding: true, html, module_id: 1155639, path: "@hubspot/rich_text", schema_version: 2 }, id: "module-1-0-0", module_id: 1155639, name: "module-1-0-0", order: 1, type: "module" },
      "module-2-0-0": { body: { align: "center", css_class: "dnd-module", font: { color: "#23496d", font: "Arial, sans-serif", size: { units: "px", value: 12 } }, hs_enable_module_padding: false, module_id: 2869621, path: "@hubspot/email_footer", schema_version: 2, unsubscribe_link_type: "both" }, id: "module-2-0-0", module_id: 2869621, name: "module-2-0-0", order: 2, type: "module" },
      preview_text: { body: { value: preview }, id: "preview_text", name: "preview_text", order: 0, type: "text" },
    },
  };
}
async function hsEnsureEmail(cad: any, step: any, settings: any, fallbackEmail?: string): Promise<string> {
  if (step.hubspot_email_id) return step.hubspot_email_id;
  const okMail = (v: any) => EMAIL_RE.test(String(v ?? ""));
  const replyTo = [settings.hsReplyTo, settings.hsFromEmail, fallbackEmail, cad.created_by_email].find(okMail);
  const base = {
    name: `Cadencia · ${cad.name} · Correo ${step.position + 1}`,
    subject: hsSubject(step.subject), subcategory: "marketing_single_send_api", language: "es",
    subscriptionDetails: { subscriptionId: String(settings.hsSubscriptionId || "9392292") },
    content: hsContent(hsBody(step.body, step.files), String(step.subject ?? "").replace(/\$\{[^}]+\}/g, "").slice(0, 120)),
  };
  const createAndPublish = async (from: any) => {
    const c = await hsApi("/marketing/v3/emails", { method: "POST", body: JSON.stringify({ ...base, from }) });
    try { await hsApi(`/marketing/v3/emails/${c.id}/publish`, { method: "POST" }); }
    catch (err) { try { await fetch(`https://api.hubapi.com/marketing/v3/emails/${c.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${HS_TOKEN}` } }); } catch { /* */ } throw err; }
    return String(c.id);
  };
  const defName = String(settings.hsFromName || "GeoVictoria").replace(/'/g, "");
  let id = ""; let dynamic = false;
  if ((settings.hsSender ?? "owner") === "owner" && replyTo) {
    try {
      id = await createAndPublish({ fromName: `{{ personalization_token('contact.nombre_ejecutivo', '${defName}') }}`, replyTo: `{{ personalization_token('contact.correo_ejecutivo', '${replyTo}') }}` });
      dynamic = true;
    } catch { id = ""; }
  }
  if (!id) id = await createAndPublish({ fromName: settings.hsFromName || "GeoVictoria", replyTo });
  await db.from("cadence_steps").update({ hubspot_email_id: id, hubspot_dynamic_from: dynamic }).eq("id", step.id);
  step.hubspot_email_id = id; step.hubspot_dynamic_from = dynamic;
  return id;
}
async function hsEnsureList(cad: any): Promise<string | null> {
  if (cad.hubspot_list_id) return cad.hubspot_list_id;
  try {
    const r = await hsApi("/crm/v3/lists", { method: "POST", body: JSON.stringify({ name: `Cadencia · ${cad.name}`, objectTypeId: "0-1", processingType: "MANUAL" }) });
    const id = String(r.list?.listId ?? r.listId ?? "");
    if (id) { await db.from("cadences").update({ hubspot_list_id: id }).eq("id", cad.id); cad.hubspot_list_id = id; }
    return id || null;
  } catch { return null; }
}
async function hsContact(email: string, rec: any, settings: any, exec?: { name: string; email: string } | null): Promise<{ id?: string; skip?: string }> {
  const s = await hsApi("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: ["email", "hs_marketable_status"], limit: 1 }) });
  const c = s.results?.[0];
  if (c) {
    if (String(c.properties?.hs_marketable_status) !== "true" && settings.hsNonMarketing !== "include") return { skip: "Existe en HubSpot pero no es contacto de marketing (la cadencia excluye a estos contactos)" };
    return { id: String(c.id) };
  }
  if (settings.hsMissing === "skip") return { skip: "No existe en HubSpot (la cadencia excluye a estos contactos)" };
  const props: any = { email };
  if (rec.first) props.firstname = rec.first; if (rec.last) props.lastname = rec.last; if (rec.account) props.company = rec.account;
  if (exec?.email) { props.nombre_ejecutivo = exec.name; props.correo_ejecutivo = exec.email; }
  const n = await hsApi("/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({ properties: props }) });
  return { id: String(n.id) };
}
async function hsSend(cad: any, e: any, step: any, idx: number, module: string, settings: any, stats: any, steps: any[]): Promise<boolean> {
  const rec = e.record ?? {};
  try {
    const ownerMode = (settings.hsSender ?? "owner") === "owner" && !!e.owner_email;
    const fromEmail = ownerMode ? String(e.owner_email) : String(settings.hsFromEmail || "");
    const fromName = (ownerMode ? (e.owner_name || e.owner_email) : (settings.hsFromName || "GeoVictoria")).replace(/[<>"]/g, "");
    const contact = await hsContact(String(e.contact_email).toLowerCase(), rec, settings, ownerMode ? { name: fromName, email: fromEmail } : null);
    if (contact.skip) { await exitEnrollment(e.id, contact.skip); stats.hs_skipped = (stats.hs_skipped ?? 0) + 1; return false; }
    const replyAddr = settings.hsReplyMode === "custom" && settings.hsReplyTo ? settings.hsReplyTo : (fromEmail || settings.hsReplyTo || "");
    const emailId = await hsEnsureEmail(cad, step, settings, fromEmail);
    const prof = profOf(fromEmail);
    const m = mergeMap(module, rec, null, { "User.First Name": fromName.split(" ")[0] ?? "", "User.Email": fromEmail, "userSignature": fromName });
    if (!m["Ejecutivo.Agenda"] && meetOf(prof)) m["Ejecutivo.Agenda"] = meetOf(prof);
    const custom: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) custom[hsKey(k)] = String(v ?? "");
    custom[hsKey("userSignature")] = fromName;
    custom.v_sig_name = fromName; custom.v_sig_email = fromEmail;
    custom.v_sig_title = String(prof.title ?? ""); custom.v_sig_phone = String(prof.phone ?? "");
    const profS = sigProf(prof, settings);
    custom.v_sig_meeting = meetOf(profS) || "https://www.geovictoria.com"; custom.v_sig_meeting_label = meetOf(profS) ? "Agenda una reunión" : "";
    const list = (v: any) => String(v ?? "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL_RE.test(x));
    const message: any = { to: e.contact_email, sendId: `${e.id}-${idx}` };
    if (fromEmail && !step.hubspot_dynamic_from) message.from = `${fromName} <${fromEmail}>`;
    if (replyAddr) message.replyTo = [replyAddr];
    const cc = list(settings.cc); const bcc = list(settings.bcc);
    if (cc.length) message.cc = cc; if (bcc.length) message.bcc = bcc;
    const contactProperties: Record<string, string> = ownerMode ? { nombre_ejecutivo: fromName, correo_ejecutivo: fromEmail } : {};
    const r = await hsApi("/marketing/v4/email/single-send", { method: "POST", body: JSON.stringify({ emailId: Number(emailId), message, customProperties: custom, ...(ownerMode ? { contactProperties } : {}) }) });
    const listId = await hsEnsureList(cad);
    if (listId && contact.id) { try { await hsApi(`/crm/v3/lists/${listId}/memberships/add`, { method: "PUT", body: JSON.stringify([contact.id]) }); } catch { /* el envío ya salió */ } }
    await db.from("email_sends").insert({
      enrollment_id: e.id, cadence_id: cad.id, step_id: step.id, step_position: step.position, deal_id: e.deal_id, deal_name: e.deal_name,
      to_email: e.contact_email, from_email: fromEmail || settings.hsFromEmail || "", subject: step.subject, status: "sent", channel: "hubspot",
      hubspot_email_id: emailId, hubspot_status_id: r.statusId ?? null, hubspot_contact_id: contact.id ?? null, rcpt_count: 0,
    });
    const next = steps[idx + 1];
    const nextDue = next ? nextDueOf(next, new Date(e.anchor_at).getTime(), settings.dayMode === "business") : null;
    await db.from("enrollments").update({ current_step: idx + 1, status: next ? "active" : "completed", exit_reason: next ? null : "Terminó la cadencia",
      next_due_at: nextDue ? new Date(nextDue).toISOString() : null, last_error: null, updated_at: new Date().toISOString() }).eq("id", e.id);
    stats.sent = (stats.sent ?? 0) + 1;
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    await db.from("email_sends").insert({ enrollment_id: e.id, cadence_id: cad.id, step_id: step.id, step_position: step.position, deal_id: e.deal_id, deal_name: e.deal_name,
      to_email: e.contact_email, from_email: settings.hsReplyTo || "", subject: step.subject, status: "failed", error: msg, channel: "hubspot", rcpt_count: 0 });
    const dead = hsDeadReason(msg);
    if (dead) await exitEnrollment(e.id, dead);
    else await db.from("enrollments").update({ last_error: msg }).eq("id", e.id);
    stats.errors = (stats.errors ?? 0) + 1;
    return false;
  }
}
const hsCampaign = new Map<string, string | null>();
async function syncHubspot(stats: any, deadline: number) {
  if (!HS_TOKEN) return;
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  // 1) Recién enviados: ¿HubSpot lo descartó? (rebotó antes, se dio de baja, etc.)
  const { data: fresh } = await db.from("email_sends").select("id,status,hubspot_status_id,enrollment_id").eq("channel", "hubspot").eq("status", "sent")
    .not("hubspot_status_id", "is", null).is("last_status_check", null).gte("sent_at", since).order("sent_at", { ascending: false }).limit(60);
  for (const s of fresh ?? []) {
    if (Date.now() > deadline) break;
    const upd: any = { last_status_check: new Date().toISOString() };
    try {
      const st = await hsApi(`/marketing/v3/email/send-statuses/${encodeURIComponent(s.hubspot_status_id)}`);
      const res = String(st.sendResult ?? "");
      if (res && !["SENT", "QUEUED"].includes(res) && st.status === "COMPLETE") {
        upd.status = res.includes("BOUNCE") ? "bounced" : "failed"; upd.error = `HubSpot: ${res}`;
      }
    } catch (err) { upd.error = (err as Error).message.slice(0, 160); delete upd.status; }
    await db.from("email_sends").update(upd).eq("id", s.id);
    if (upd.status) {
      stats.hs_updated = (stats.hs_updated ?? 0) + 1;
      const dead = upd.status === "bounced" ? "Correo rebotado" : (hsDeadReason(upd.error ?? "") ?? null);
      if (dead) await db.from("enrollments").update({ status: "exited", exit_reason: dead, next_due_at: null }).eq("id", s.enrollment_id).eq("status", "active");
    }
  }
  // 2) Entregas, aperturas, clics y rebotes: se leen en bloque por cada correo de HubSpot (1.000 eventos por llamada)
  const { data: pend } = await db.rpc("hs_pending_emails", { p_since: since });
  for (const row of pend ?? []) {
    if (Date.now() > deadline) break;
    const emailId = String(row.email_id);
    try {
      if (!hsCampaign.has(emailId)) {
        const em = await hsApi(`/marketing/v3/emails/${emailId}`);
        hsCampaign.set(emailId, String(em.primaryEmailCampaignId ?? em.allEmailCampaignIds?.[0] ?? "") || null);
      }
      const camp = hsCampaign.get(emailId);
      if (!camp) { await db.from("hs_event_cursor").upsert({ email_id: emailId, updated_at: new Date().toISOString() }); continue; }
      const { data: cur } = await db.from("hs_event_cursor").select("*").eq("email_id", emailId).maybeSingle();
      let start = cur?.run_start ? Number(cur.run_start) : (cur?.last_ts ? Number(cur.last_ts) + 1 : new Date(row.min_sent).getTime() - 3_600_000);
      let offset: string | null = cur?.run_offset ?? null;
      let maxTs = cur?.run_max ? Number(cur.run_max) : (cur?.last_ts ? Number(cur.last_ts) : 0);
      let done = false;
      while (Date.now() < deadline) {
        const j = await hsApi(`/email/public/v1/events?campaignId=${camp}&startTimestamp=${start}&limit=1000${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`);
        const evs: any[] = [];
        for (const e of j.events ?? []) {
          const t = String(e.type ?? "").toUpperCase();
          maxTs = Math.max(maxTs, Number(e.created ?? 0));
          if (["DELIVERED", "OPEN", "CLICK", "BOUNCE", "DROPPED"].includes(t) && e.recipient) evs.push({ r: String(e.recipient), t, at: new Date(Number(e.created ?? Date.now())).toISOString() });
        }
        if (evs.length) {
          const { data: n, error } = await db.rpc("hs_apply_events", { p_email_id: emailId, p_events: evs });
          if (error) throw new Error(error.message);
          stats.hs_updated = (stats.hs_updated ?? 0) + Number(n ?? 0);
        }
        stats.hs_events = (stats.hs_events ?? 0) + (j.events?.length ?? 0);
        if (!j.hasMore || !j.offset) { done = true; break; }
        offset = String(j.offset);
      }
      await db.from("hs_event_cursor").upsert(done
        ? { email_id: emailId, campaign_id: camp, last_ts: maxTs || cur?.last_ts || null, run_start: null, run_offset: null, run_max: null, updated_at: new Date().toISOString() }
        : { email_id: emailId, campaign_id: camp, last_ts: cur?.last_ts ?? null, run_start: start, run_offset: offset, run_max: maxTs, updated_at: new Date().toISOString() });
    } catch (err) { stats.hs_sync_error = (err as Error).message.slice(0, 200); await db.from("hs_event_cursor").upsert({ email_id: emailId, updated_at: new Date().toISOString() }); }
  }
}

async function syncHubspotReplies(conns: Conn[], stats: any, deadline: number) {
  if (!conns.length) return;
  const admin = await adminConn(conns);
  if (!admin) return;
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const { data: sends } = await db.from("email_sends").select("id, enrollment_id, deal_id, to_email, sent_at, status, cadences(module, spec)")
    .eq("channel", "hubspot").gte("sent_at", since).in("status", ["sent", "delivered", "opened", "clicked"]).not("deal_id", "like", "xl:%")
    .order("reply_checked_at", { ascending: true, nullsFirst: true }).limit(120);
  const groups = new Map<string, any[]>();
  (sends ?? []).forEach((s: any) => { const mod = s.cadences?.spec?.module ?? s.cadences?.module ?? "Deals"; const k = `${mod}|${s.deal_id}`; groups.set(k, [...(groups.get(k) ?? []), s]); });
  for (const [key, list] of groups) {
    if (Date.now() > deadline) break;
    const [module, recId] = key.split("|");
    if (!/^\d+$/.test(recId) || !["Deals", "Leads", "Contacts"].includes(module)) continue;
    let mails: any[] = [];
    try { const j = await zoho(admin, `/${module}/${recId}/Emails`); mails = j.email_related_list ?? j.Emails ?? []; }
    catch (e) { if (/bloque/i.test((e as Error).message)) break; mails = []; }
    for (const s of list) {
      const to = String(s.to_email ?? "").toLowerCase();
      const sentAt = new Date(s.sent_at).getTime();
      const reply = to ? mails.find((x) => x.sent === false && new Date(x.time ?? x.sent_time ?? 0).getTime() > sentAt
        && String(x.from?.email ?? x.from ?? "").toLowerCase().includes(to)) : null;
      const upd: any = { reply_checked_at: new Date().toISOString() };
      if (reply) { upd.status = "replied"; upd.replied_at = reply.time ?? new Date().toISOString(); stats.hs_replies = (stats.hs_replies ?? 0) + 1; }
      await db.from("email_sends").update(upd).eq("id", s.id);
      if (reply && s.cadences?.spec?.settings?.exitOnReply !== false) {
        await db.from("enrollments").update({ status: "exited", exit_reason: "Respondió", next_due_at: null }).eq("id", s.enrollment_id).eq("status", "active");
      }
    }
  }
}

// ======================================================================= Motor (spec)
type Usage = { map: Map<string, number>; cap: number };
async function runSpecCadence(cad: any, conns: Conn[], stats: any, opts: { ignoreWindow?: boolean; usage?: Usage; deadline: number }) {
  const spec = cad.spec;
  const module: string = spec.module ?? "Deals";
  const settings = spec.settings ?? {};
  const biz = settings.dayMode === "business";
  const once = settings.enrollMode === "once";
  const viaHubspot = settings.channel === "hubspot";
  if (viaHubspot && !HS_TOKEN) throw new Error("Canal HubSpot: falta configurar HUBSPOT_TOKEN");
  const { data: steps } = await db.from("cadence_steps").select("*").eq("cadence_id", cad.id).order("position");
  if (!steps?.length) { stats.skipped = "sin correos"; return; }
  const queryConn = conns.find((c) => c.user_id === cad.created_by) ?? connByEmail(conns, cad.created_by_email) ?? conns[0];
  if (!queryConn) throw new Error("Nadie ha conectado Zoho todavía");

  let idSet = new Set<string>();
  if (spec.source === "list") {
    if (!cad.snapshot_at) await enrollList(cad, spec, module, steps, queryConn, viaHubspot, biz, stats);
    const { data: all } = await db.from("enrollments").select("deal_id").eq("cadence_id", cad.id);
    idSet = new Set((all ?? []).map((x: any) => String(x.deal_id)));
    stats.match = idSet.size;
  } else {
    const conds: Cond[] = spec.criteria?.conditions ?? [];
    const criteria = buildCriteria(conds);
    if (!criteria) throw new Error("La cadencia no tiene filtros");
    const anchor: string = spec.anchor ?? "Created_Time";
    const stage = anchor.startsWith(STAGE_PFX) ? anchor.slice(STAGE_PFX.length) : null;
    const stageDateField = stage ? STAGE_DATE[module]?.[stage] : null;
    const anchorField = stage ? stageDateField : (anchor === ENROLLED ? null : anchor);
    const fields = [...selectOf(module), ...(anchorField ? [anchorField] : []), ...conds.map((c) => c.field).filter((f) => f !== "Tag")];
    const raws = await searchAll(queryConn, module, criteria, fields);
    const rawById = new Map(raws.map((r) => [String(r.id), r]));
    idSet = new Set(rawById.keys());
    stats.match = idSet.size;

    const { data: existing } = await db.from("enrollments").select("id, deal_id, status").eq("cadence_id", cad.id);
    const known = new Set((existing ?? []).map((e) => e.deal_id));
    const fresh = once && cad.snapshot_at ? [] : raws.filter((r) => !known.has(String(r.id))).slice(0, once || viaHubspot ? 2000 : 300);
    if (fresh.length) {
      const recs = fresh.map((r) => ({ ...normRecord(module, r), _raw: r }));
      await enrichRecords(queryConn, module, recs);
      const now = Date.now();
      const fixedFirst = fixedAt(steps[0]) !== null;
      const grace = Number(settings.graceDays ?? 2) * DAY;
      const rows: any[] = [];
      for (const rec of recs) {
        let a: string | null = null;
        if (!once) {
          if (stage && !stageDateField && module === "Deals") a = await stageEnteredAt(queryConn, rec.id, stage);
          else if (anchorField) a = rec._raw[anchorField] ?? null;
        }
        let t = a ? new Date(a).getTime() : now;
        if (Number.isNaN(t)) t = now;
        const firstAt = dueOf(steps[0], t, biz);
        const late = !once && !fixedFirst && now > firstAt + grace;
        const { _raw, ...record } = rec;
        rows.push({
          cadence_id: cad.id, deal_id: rec.id, deal_name: rec.name, account_name: rec.account, stage: rec.stage,
          contact_name: rec.contact, contact_first_name: rec.first, contact_email: rec.email, owner_name: rec.owner, owner_email: rec.ownerEmail,
          record, anchor_at: new Date(t).toISOString(), current_step: 0,
          status: late ? "skipped" : "active",
          exit_reason: late ? `Fuera de plazo: el correo 1 era el ${new Date(firstAt).toISOString().slice(0, 10)}` : null,
          next_due_at: late ? null : new Date(Math.max(firstAt, now)).toISOString(),
        });
      }
      for (let i = 0; i < rows.length; i += 500) await db.from("enrollments").upsert(rows.slice(i, i + 500), { onConflict: "cadence_id,deal_id", ignoreDuplicates: true });
      stats.enrolled = rows.filter((r) => r.status === "active").length;
      stats.late = rows.filter((r) => r.status === "skipped").length;
    }
    if (once && !cad.snapshot_at) {
      await db.from("cadences").update({ snapshot_at: new Date().toISOString() }).eq("id", cad.id);
      stats.snapshot = "lista fija tomada";
    }

    if (settings.exitOnCriteria !== false) {
      const out = (existing ?? []).filter((e) => e.status === "active" && !idSet.has(e.deal_id)).map((e) => e.id);
      if (out.length) {
        await db.from("enrollments").update({ status: "exited", exit_reason: "Ya no cumple las condiciones de entrada", next_due_at: null }).in("id", out);
        stats.exited = (stats.exited ?? 0) + out.length;
      }
    }
  }

  const winOk = !!opts.ignoreWindow || inWindow(cad.send_window);
  const anyFixed = steps.some((s: any) => fixedAt(s) !== null);
  if (!winOk && !anyFixed) { stats.window = "fuera de horario"; return; }
  const limit = viaHubspot ? Math.max(cad.max_per_run ?? 50, HS_PER_RUN) : (cad.max_per_run ?? 50);
  const { data: due } = await db.from("enrollments").select("*").eq("cadence_id", cad.id).eq("status", "active")
    .lte("next_due_at", new Date().toISOString()).order("next_due_at").limit(limit);
  if ((due ?? []).length >= limit) stats.more_due = true;
  const exclude = Array.isArray(settings.excludeDomains) ? settings.excludeDomains : [];
  const elsewhere = new Map<string, any>();
  if ((due ?? []).some((e: any) => e.current_step === 0)) {
    try { const { data: ow } = await db.rpc("active_elsewhere", { p_cad: cad.id }); for (const r of ow ?? []) { const k = String(r.email); const prev = elsewhere.get(k); if (!prev || r.first_at < prev.first_at) elsewhere.set(k, r); } } catch { /* sin datos */ }
  }

  for (const e of due ?? []) {
    if (Date.now() > opts.deadline) { stats.more_due = true; stats.cut = "tiempo"; break; }
    const idx: number = e.current_step;
    const step = steps[idx];
    if (!step) { await exitEnrollment(e.id, "Terminó la cadencia", "completed"); continue; }
    if (!winOk && fixedAt(step) === null) continue;
    const req = step.req ?? {};
    const rec = e.record ?? {};

    if (req.stay && !idSet.has(e.deal_id)) { await exitEnrollment(e.id, `No se envió el correo ${idx + 1}: ya no cumple las condiciones de entrada`); stats.exited = (stats.exited ?? 0) + 1; continue; }
    if (idx > 0) {
      const { data: prevSends } = await db.from("email_sends").select("status, step_position").eq("enrollment_id", e.id);
      const prev = (prevSends ?? []).filter((s) => s.step_position === idx - 1).pop();
      if ((prevSends ?? []).some((s) => s.status === "bounced")) { await exitEnrollment(e.id, "Un correo anterior rebotó"); continue; }
      if (req.noReply !== false && (prevSends ?? []).some((s) => s.status === "replied")) { await exitEnrollment(e.id, "Respondió"); continue; }
      const opened = prev && ["opened", "clicked", "replied"].includes(prev.status);
      if (req.open === "opened" && !opened) { await exitEnrollment(e.id, `No se envió el correo ${idx + 1}: no abrió el correo ${idx}`); continue; }
      if (req.open === "not_opened" && opened) { await exitEnrollment(e.id, `No se envió el correo ${idx + 1}: abrió el correo ${idx}`); continue; }
    }
    if (req.conditions?.length && !String(e.deal_id).startsWith("xl:")) {
      try {
        const fl = [...new Set(req.conditions.map((c: Cond) => c.field).filter((f: string) => f !== "Tag"))];
        const j = await zoho(queryConn, `/${module}/${e.deal_id}?fields=${[...fl, "Tag"].join(",")}`);
        const raw = j.data?.[0] ?? {};
        const ok = req.conditions.filter((c: Cond) => Array.isArray(c.value) ? c.value.length : String(c.value ?? "").trim() !== "").every((c: Cond) => evalCond(raw, c));
        if (!ok) { await exitEnrollment(e.id, `No se envió el correo ${idx + 1}: no cumplió sus condiciones`); continue; }
      } catch (err) { await db.from("enrollments").update({ last_error: (err as Error).message }).eq("id", e.id); continue; }
    }
    if (!e.contact_email) { await db.from("enrollments").update({ status: "error", last_error: "El registro no tiene correo" }).eq("id", e.id); stats.no_email = (stats.no_email ?? 0) + 1; continue; }
    {
      const ex = domainHit(e.contact_email, exclude); const bd = ex ?? blockedDomain(e.contact_email);
      if (bd) { await exitEnrollment(e.id, ex ? `Dominio excluido en esta cadencia (${ex})` : `Dominio bloqueado (${bd})`); stats.excluded = (stats.excluded ?? 0) + 1; continue; }
    }
    if (idx === 0) {
      const other = elsewhere.get(String(e.contact_email).toLowerCase());
      if (other && Date.parse(other.first_at) <= (Date.parse(e.enrolled_at ?? "") || Date.now())) { await exitEnrollment(e.id, `Ya está en otra cadencia activa: ${other.code ?? ""} · ${other.name}`); stats.busy_elsewhere = (stats.busy_elsewhere ?? 0) + 1; continue; }
      const zc = String(rec.zcad ?? "").trim();
      if (zc && zc !== "-None-") { await exitEnrollment(e.id, `Está en una cadencia de Zoho («${zc}»)`); stats.busy_zoho = (stats.busy_zoho ?? 0) + 1; continue; }
      const pc = [rec.pcad, rec.contactPcad].map((x: any) => String(x ?? "").trim()).find((x: string) => x && !(cad.code && x.startsWith(cad.code)));
      if (pc) { await exitEnrollment(e.id, `Ya está en otra cadencia según Zoho («${pc}»)`); stats.busy_elsewhere = (stats.busy_elsewhere ?? 0) + 1; continue; }
    }
    if (viaHubspot) { const ok = await hsSend(cad, e, step, idx, module, settings, stats, steps); if (ok && idx === 0) await tagFirstSend(queryConn, cad, e, module); continue; }
    if (String(e.deal_id).startsWith("xl:")) { await exitEnrollment(e.id, "No está en Zoho: por Zoho solo se envía desde un registro"); continue; }

    const mode = settings.sender ?? "owner";
    let sender: Conn | undefined; let fromEmail: string | undefined; let fromName: string | undefined; let orgEmail = false;
    if (mode === "owner") sender = connByEmail(conns, e.owner_email);
    else if (mode === "account_owner") sender = connByEmail(conns, rec.accountOwnerEmail ?? e.owner_email);
    else if (mode === "user") sender = connByEmail(conns, settings.senderEmail);
    else if (mode === "custom") {
      const want = String(settings.senderEmail ?? "").toLowerCase();
      for (const c of [connByEmail(conns, cad.created_by_email), ...conns].filter(Boolean) as Conn[]) {
        const hit = (await fromAddresses(c)).find((a) => a.email === want);
        if (hit) { sender = c; fromEmail = want; fromName = settings.senderName || want; orgEmail = hit.type === "org_email"; break; }
      }
    }
    if (!sender) {
      const who = mode === "owner" ? (e.owner_name ?? e.owner_email) : mode === "account_owner" ? (rec.accountOwner ?? "el dueño de la cuenta") : settings.senderEmail;
      await db.from("enrollments").update({ last_error: mode === "custom" ? `Nadie conectado puede enviar desde ${who}` : `${who ?? "El remitente"} no ha conectado su Zoho` }).eq("id", e.id);
      stats.waiting_sender = (stats.waiting_sender ?? 0) + 1; continue;
    }
    const sigMailZ = fromEmail ?? sender.zoho_email;
    const prof = profOf(sigMailZ);
    const fileBlock = filesHtml(step.files);
    const sig = fileBlock + sigHtml(fromName ?? sender.zoho_name ?? sender.zoho_email, sigMailZ, sigProf(prof, settings));
    const m = mergeMap(module, rec, sender);
    if (!m["Ejecutivo.Agenda"] && meetOf(prof)) m["Ejecutivo.Agenda"] = meetOf(prof);
    const subject = renderSubject(step.subject ?? "", m);
    const content = renderBody(step.body ?? "", m, sig) + (String(step.body ?? "").includes("${userSignature}") ? "" : fileBlock);
    const to = cad.test_email ? cad.test_email : e.contact_email;
    const replyTo = settings.replyTo === "owner" ? { email: e.owner_email, user_name: e.owner_name ?? e.owner_email }
      : settings.replyTo === "custom" && settings.replyToEmail ? { email: settings.replyToEmail, user_name: settings.replyToEmail } : null;

    const fromAddr = String(fromEmail ?? sender.zoho_email).toLowerCase();
    let ccList: string[] = [], bccList: string[] = [];
    if (!cad.test_email) {
      const list = (v: any) => String(v ?? "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL_RE.test(x));
      const skip = new Set([fromAddr, String(to).toLowerCase()]);
      ccList = [...new Set([...(settings.ccOwner && mode !== "owner" && e.owner_email ? [String(e.owner_email).toLowerCase()] : []), ...list(settings.cc)])].filter((x) => !skip.has(x));
      bccList = [...new Set(list(settings.bcc))].filter((x) => !skip.has(x) && !ccList.includes(x));
    }
    const rcpt = 1 + ccList.length;
    if (opts.usage) {
      const used = opts.usage.map.get(fromAddr) ?? 0;
      if (used + rcpt > opts.usage.cap) {
        await db.from("enrollments").update({ last_error: `Límite diario de Zoho alcanzado para ${fromAddr} (${used} de ${opts.usage.cap} hoy). Sigue mañana.` }).eq("id", e.id);
        stats.capped = (stats.capped ?? 0) + 1; continue;
      }
    }
    try {
      const payload: any = {
        from: { user_name: fromName ?? sender.zoho_name ?? sender.zoho_email, email: fromEmail ?? sender.zoho_email },
        to: [{ user_name: e.contact_name ?? to, email: to }],
        subject: cad.test_email ? `[PRUEBA] ${subject}` : subject, content, mail_format: "html",
      };
      if (orgEmail) payload.org_email = true;
      if (replyTo?.email) payload.reply_to = replyTo;
      if (ccList.length) payload.cc = ccList.map((email) => ({ user_name: email, email }));
      if (bccList.length) payload.bcc = bccList.map((email) => ({ user_name: email, email }));
      const r = await zoho(sender, `/${module}/${e.deal_id}/actions/send_mail`, { method: "POST", body: JSON.stringify({ data: [payload] }) });
      const res = r.data?.[0];
      if (res?.status !== "success") throw new Error(res?.message ?? "Zoho no confirmó el envío");
      await db.from("email_sends").insert({
        enrollment_id: e.id, cadence_id: cad.id, step_id: step.id, step_position: step.position, deal_id: e.deal_id, deal_name: e.deal_name,
        to_email: to, from_email: payload.from.email, subject: payload.subject, body: content, zoho_message_id: res.details?.message_id ?? null, status: "sent", test: !!cad.test_email, rcpt_count: rcpt,
      });
      if (opts.usage) opts.usage.map.set(fromAddr, (opts.usage.map.get(fromAddr) ?? 0) + rcpt);
      const next = steps[idx + 1];
      const nextDue = next ? nextDueOf(next, new Date(e.anchor_at).getTime(), biz) : null;
      await db.from("enrollments").update({ current_step: idx + 1, status: next ? "active" : "completed", exit_reason: next ? null : "Terminó la cadencia",
        next_due_at: nextDue ? new Date(nextDue).toISOString() : null, last_error: null, updated_at: new Date().toISOString() }).eq("id", e.id);
      stats.sent = (stats.sent ?? 0) + 1;
      if (idx === 0 && !cad.test_email) await tagFirstSend(queryConn, cad, e, module);
    } catch (err) {
      const msg = (err as Error).message;
      await db.from("email_sends").insert({
        enrollment_id: e.id, cadence_id: cad.id, step_id: step.id, step_position: step.position, deal_id: e.deal_id, deal_name: e.deal_name,
        to_email: to, from_email: fromEmail ?? sender.zoho_email, subject, body: content, status: "failed", error: msg, test: !!cad.test_email,
      });
      await db.from("enrollments").update({ last_error: msg }).eq("id", e.id);
      stats.errors = (stats.errors ?? 0) + 1;
    }
  }
}

// ======================================================================= Formato anterior (sin spec)
type Field = { api_name: string; label: string; type: string; picklist?: string[] };
const fieldsCache = new Map<string, Field[]>();
async function getFields(c: Conn, module: string): Promise<Field[]> {
  const k = `${c.api_domain}:${module}`;
  if (fieldsCache.has(k)) return fieldsCache.get(k)!;
  const j = await zoho(c, `/settings/fields?module=${module}`);
  const fields: Field[] = (j.fields ?? []).map((f: any) => ({
    api_name: f.api_name, label: f.field_label, type: f.data_type,
    picklist: f.pick_list_values?.length ? f.pick_list_values.map((p: any) => p.actual_value ?? p.display_value).filter((v: string) => v && v !== "-None-") : undefined,
  }));
  fieldsCache.set(k, fields);
  return fields;
}

// ======================================================================= Estados por Zoho
const RANK: Record<string, number> = { failed: -1, sent: 0, delivered: 1, opened: 2, clicked: 3, replied: 4, bounced: 5 };
async function syncStatuses(conns: Conn[], stats: any, deadline: number) {
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const { data: sends } = await db.from("email_sends").select("*, cadences(module, exit_on_reply, spec)")
    .eq("channel", "zoho").gte("sent_at", since).in("status", ["sent", "delivered", "opened", "clicked"]).not("zoho_message_id", "is", null)
    .order("last_status_check", { ascending: true, nullsFirst: true }).limit(150);
  const groups = new Map<string, any[]>();
  (sends ?? []).forEach((s) => { const k = `${s.from_email}|${s.cadences?.module ?? "Deals"}|${s.deal_id}`; groups.set(k, [...(groups.get(k) ?? []), s]); });
  for (const [key, list] of groups) {
    if (Date.now() > deadline) break;
    const [from, module, recId] = key.split("|");
    const conn = connByEmail(conns, from) ?? conns[0];
    if (!conn) continue;
    let mails: any[] = [];
    try { const j = await zoho(conn, `/${module}/${recId}/Emails`); mails = j.email_related_list ?? j.Emails ?? []; } catch { continue; }
    for (const s of list) {
      const mm = mails.find((x) => x.message_id === s.zoho_message_id);
      const upd: any = { last_status_check: new Date().toISOString() };
      let status = s.status;
      const bump = (st: string) => { if ((RANK[st] ?? 0) > (RANK[status] ?? 0)) status = st; };
      for (const st of mm?.status ?? []) {
        const t = String(st.type ?? "").toLowerCase();
        if (t.includes("bounce")) { status = "bounced"; upd.bounced_at = st.bounced_time ?? new Date().toISOString(); }
        else if (t.includes("repl")) { bump("replied"); upd.replied_at = upd.replied_at ?? new Date().toISOString(); }
        else if (t.includes("click")) { bump("clicked"); upd.clicked_at = st.last_click ?? st.first_click ?? new Date().toISOString(); }
        else if (t.includes("open")) { bump("opened"); upd.opened_at = st.first_open ?? new Date().toISOString(); upd.open_count = Number(st.count ?? 1); }
        else if (t.includes("deliver") || t === "sent") { bump("delivered"); upd.delivered_at = upd.delivered_at ?? new Date().toISOString(); }
      }
      const reply = mails.find((x) => x.sent === false && new Date(x.time ?? x.sent_time ?? 0).getTime() > new Date(s.sent_at).getTime()
        && String(x.from?.email ?? x.from ?? "").toLowerCase().includes(String(s.to_email).toLowerCase()));
      if (reply && status !== "bounced") { status = "replied"; upd.replied_at = reply.time ?? new Date().toISOString(); }
      upd.status = status;
      await db.from("email_sends").update(upd).eq("id", s.id);
      if (status !== s.status) stats.updated = (stats.updated ?? 0) + 1;
      const exitOnReply = s.cadences?.spec ? s.cadences.spec.settings?.exitOnReply !== false : s.cadences?.exit_on_reply;
      if (status === "replied" && exitOnReply) await db.from("enrollments").update({ status: "exited", exit_reason: "Respondió", next_due_at: null }).eq("id", s.enrollment_id).eq("status", "active");
      if (status === "bounced") await db.from("enrollments").update({ status: "exited", exit_reason: "Correo rebotado", next_due_at: null }).eq("id", s.enrollment_id).eq("status", "active");
    }
  }
}

async function runEngine(trigger: string, cadenceId?: string, ignoreWindow = false) {
  const t0 = Date.now();
  const deadline = t0 + RUN_BUDGET_MS;
  const { data: run } = await db.from("engine_runs").insert({ trigger, cadence_id: cadenceId ?? null }).select().single();
  const stats: any = {};
  let error: string | null = null;
  const chain: string[] = [];
  try {
    const conns = await allConns();
    stats.connections = conns.length;
    BLOCKED = await loadBlocked();
    await loadProfiles();
    await loadCadFields();
    if (trigger !== "chain") {
      // cada canal tiene su propio tiempo: Zoho no puede dejar sin revisar a HubSpot
      if (conns.length) await syncStatuses(conns, stats, t0 + 18_000);
      try { await syncHubspot(stats, Math.min(Date.now() + 22_000, t0 + 42_000)); } catch (e) { stats.hs_sync_error = (e as Error).message; }
      try { await syncHubspotReplies(conns, stats, Math.min(Date.now() + 6_000, t0 + 48_000)); } catch (e) { stats.hs_reply_error = (e as Error).message.slice(0, 200); }
    }
    const usage: Usage = { map: new Map(), cap: 250 };
    try {
      const { data: cfg } = await db.from("app_config").select("value").eq("key", "zoho_daily_cap").maybeSingle();
      if (cfg?.value && Number(cfg.value) > 0) usage.cap = Number(cfg.value);
      const { data: today } = await db.rpc("zoho_sends_today");
      (today ?? []).forEach((r: any) => usage.map.set(String(r.from_email).toLowerCase(), Number(r.used) || 0));
    } catch { /* sin tope local */ }
    let qy = db.from("cadences").select("*").eq("status", "active");
    if (cadenceId) qy = qy.eq("id", cadenceId);
    const { data: cads } = await qy;
    stats.cadences = cads?.length ?? 0;
    for (const cad of cads ?? []) {
      const s: any = {};
      let locked = false;
      try {
        if (Date.now() > deadline) { s.skipped = "sin tiempo en esta revisión: sigue en la próxima"; if (cad.spec?.settings?.channel === "hubspot") chain.push(cad.id); }
        else if (!cad.spec) s.skipped = "formato anterior: vuelve a activarla desde la herramienta";
        else {
          const { data: got } = await db.rpc("try_lock_cadence", { p_id: cad.id, p_secs: 170 });
          if (!got) s.skipped = "otra tanda de esta cadencia está enviando";
          else { locked = true; await runSpecCadence(cad, conns, s, { ignoreWindow, usage, deadline }); }
        }
      } catch (e) { s.error = (e as Error).message; }
      finally { if (locked) { try { await db.rpc("unlock_cadence", { p_id: cad.id }); } catch { /* vence solo */ } } }
      stats[cad.name] = s;
      if (s.more_due && (s.sent ?? 0) > 0 && cad.spec?.settings?.channel === "hubspot") chain.push(cad.id);
    }
    if (trigger !== "chain") { try { await clearTags(conns, stats, Math.min(deadline, Date.now() + 15_000)); } catch (e) { stats.untag_error = (e as Error).message.slice(0, 160); } }
    await db.from("oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  } catch (e) { error = (e as Error).message; }
  if (chain.length) stats.chained = chain.length;
  await db.from("engine_runs").update({ finished_at: new Date().toISOString(), stats, error }).eq("id", run!.id);
  for (const id of [...new Set(chain)]) {
    try { await db.rpc("chain_cadence", { p_id: id }); } catch { /* la próxima revisión horaria la toma */ }
  }
  return { stats, error };
}

async function runSyncOnly(by: string) {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const { data: run } = await db.from("engine_runs").insert({ trigger: `sync:${by}`.slice(0, 120) }).select().single();
  const stats: any = { sync_only: true };
  let error: string | null = null;
  try {
    const conns = await allConns();
    if (conns.length) await syncStatuses(conns, stats, deadline);
    await syncHubspot(stats, deadline);
    try { await syncHubspotReplies(conns, stats, deadline); } catch (e) { stats.hs_reply_error = (e as Error).message.slice(0, 200); }
  } catch (e) { error = (e as Error).message; }
  await db.from("engine_runs").update({ finished_at: new Date().toISOString(), stats, error }).eq("id", run!.id);
  return { stats, error };
}

// ======================================================================= HTTP
async function requireUser(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const client = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } } });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Sesión no válida");
  return data.user;
}
async function allowedDomains(): Promise<string[]> {
  const { data } = await db.from("app_config").select("value").eq("key", "allowed_email_domains").maybeSingle();
  return String(data?.value ?? "").split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}
function authUrl(state: string) {
  const u = new URL(`${ZOHO_ACCOUNTS}/oauth/v2/auth`);
  u.search = new URLSearchParams({ scope: SCOPES, client_id: ZOHO_CLIENT_ID, response_type: "code", access_type: "offline", prompt: "consent", redirect_uri: REDIRECT_URI, state }).toString();
  return u.toString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";
  try {
    if (action === "connect") {
      if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) return text("Todavía no están configuradas las credenciales de la API de Zoho (ZOHO_CLIENT_ID y ZOHO_CLIENT_SECRET). Avísale al administrador.", 503);
      const state = crypto.randomUUID() + crypto.randomUUID();
      await db.from("oauth_states").insert({ state, user_id: null, return_to: url.searchParams.get("return_to") ?? "" });
      return Response.redirect(authUrl(state), 302);
    }

    if (action === "oauth_callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const accounts = url.searchParams.get("accounts-server") ?? ZOHO_ACCOUNTS;
      const { data: st } = await db.from("oauth_states").select("*").eq("state", state ?? "").maybeSingle();
      if (!st) return text("La solicitud venció. Vuelve a abrir el enlace para conectar tu Zoho.", 400);
      await db.from("oauth_states").delete().eq("state", state!);
      const done = (msg: string, ok: boolean) => st.return_to ? Response.redirect(`${st.return_to}#zoho=${ok ? "ok" : "error"}`, 302) : text(msg, ok ? 200 : 400);
      if (!code) return done("Cancelaste la conexión. No se guardó nada.", false);
      if (!/^https:\/\/accounts\.zoho\.[a-z.]+$/.test(accounts)) return done("Servidor de Zoho no válido.", false);
      const tr = await fetch(`${accounts}/oauth/v2/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, redirect_uri: REDIRECT_URI, code }),
      });
      const tj = await tr.json();
      if (!tj.refresh_token) return done(`Zoho no entregó el acceso (${tj.error ?? tr.status}). Intenta de nuevo.`, false);
      const api = tj.api_domain ?? "https://www.zohoapis.com";
      const me = await fetch(`${api}/crm/${ZV}/users?type=CurrentUser`, { headers: { Authorization: `Zoho-oauthtoken ${tj.access_token}` } }).then((r) => r.json());
      const u = me.users?.[0] ?? {};
      const email = String(u.email ?? "").toLowerCase();
      const domains = await allowedDomains();
      if (!email || (domains.length && !domains.some((d) => email.endsWith("@" + d)))) return done(`La cuenta ${email || "(sin correo)"} no pertenece a un dominio permitido.`, false);
      const row = { zoho_email: email, zoho_name: u.full_name ?? null, zoho_user_id: u.id ?? null, signature: null,
        refresh_token: tj.refresh_token, accounts_server: accounts, api_domain: api, connected_at: new Date().toISOString(), last_error: null };
      const { data: prev } = await db.from("zoho_connections").select("user_id").ilike("zoho_email", email).maybeSingle();
      if (st.user_id) await db.from("zoho_connections").upsert({ user_id: st.user_id, ...row });
      else if (prev) await db.from("zoho_connections").update(row).eq("user_id", prev.user_id);
      else await db.from("zoho_connections").insert(row);
      await db.from("zoho_token_cache").delete().eq("user_id", st.user_id ?? prev?.user_id ?? "00000000-0000-0000-0000-000000000000");
      return done(`Listo: tu cuenta de Zoho (${email}) quedó conectada al motor de cadencias. Ya puedes cerrar esta pestaña.`, true);
    }

    if (action === "cron") {
      const { data: cfg } = await db.from("app_config").select("value").eq("key", "cron_secret").single();
      if (!cfg || req.headers.get("x-cron-secret") !== cfg.value) return json({ error: "no autorizado" }, 401);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (body.test) return json(await runTest(body.test));
      if (body.import) return json(await runImport(body.import));
      if (body.ensure_fields) return json(await ensureFields());
      if (body.sync_only) return json(await runSyncOnly(String(body.by ?? "")));
      return json(await runEngine(body.chain ? "chain" : body.cadence_id ? "manual" : "cron", body.cadence_id, !!body.ignore_window));
    }

    const user = await requireUser(req);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    switch (action) {
      case "oauth_start": {
        if (!ZOHO_CLIENT_ID) throw new HttpError(500, "Falta configurar ZOHO_CLIENT_ID y ZOHO_CLIENT_SECRET en Supabase.");
        const state = crypto.randomUUID() + crypto.randomUUID();
        await db.from("oauth_states").insert({ state, user_id: user.id, return_to: String(body.return_to ?? "") });
        return json({ url: authUrl(state) });
      }
      case "me": {
        const { data } = await db.from("zoho_connections").select("zoho_email, zoho_name, connected_at, last_error").eq("user_id", user.id).maybeSingle();
        return json({ email: user.email, zoho: data, configured: { zoho: !!ZOHO_CLIENT_ID, ai: !!ANTHROPIC_KEY } });
      }
      case "disconnect": { await db.from("zoho_connections").delete().eq("user_id", user.id); return json({ ok: true }); }
      case "fields": { const c = await connByUser(user.id); return json({ fields: await getFields(c, body.module ?? "Deals") }); }
      case "run": {
        if (!body.cadence_id) throw new HttpError(400, "Falta cadence_id");
        return json(await runEngine(`manual:${user.email}`, body.cadence_id, !!body.ignore_window));
      }
      default: return json({ error: "acción desconocida" }, 404);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
});
