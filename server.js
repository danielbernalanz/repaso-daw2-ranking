// Servidor mínimo del ranking: sirve la web y guarda un documento de récord por dispositivo.
// Sin cuentas: cualquiera con el enlace puede jugar y aparecer en el ranking.
// Con DATABASE_URL guarda en Postgres; sin ella usa memoria (solo para pruebas locales).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 3000;
const PAGE = path.join(__dirname, 'public', 'index.html');

// ---------- almacenamiento ----------
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 4 });
  store = {
    async init() { await pool.query('create table if not exists rank (id text primary key, doc jsonb not null, updated_at timestamptz not null default now())'); },
    async list() { const r = await pool.query('select doc from rank order by updated_at desc limit 2000'); return r.rows.map(x => x.doc); },
    async put(id, doc) { await pool.query('insert into rank (id, doc, updated_at) values ($1, $2, now()) on conflict (id) do update set doc = excluded.doc, updated_at = now()', [id, doc]); },
    async del(id) { await pool.query('delete from rank where id = $1', [id]); }
  };
} else {
  const mem = new Map();
  console.warn('Sin DATABASE_URL: los récords se guardan en memoria y se pierden al reiniciar.');
  store = { async init() {}, async list() { return [...mem.values()]; }, async put(id, doc) { mem.set(id, doc); }, async del(id) { mem.delete(id); } };
}

// ---------- validación ----------
const ID_RE = /^[a-z0-9-]{1,24}~[a-z0-9]{4,12}$/;
const BADGE_RE = /^(first|s5|s10|p100|mod:[a-z]{2,8})$/;
const MODS = ['dep', 'dwes', 'diw', 'sos'];
const cleanNick = s => String(s == null ? '' : s).normalize('NFC').replace(/[\u0000-\u001f\u007f<>"'`&\\\/]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
const badNick = n => /@|https?:|www\./i.test(n) || /\d{6,}/.test(n.replace(/[\s.-]/g, ''));
const num = v => (Number.isFinite(v) ? Math.max(0, Math.min(Math.floor(v), 1e6)) : null);
function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const nick = cleanNick(b.nick); if (!nick || badNick(nick)) return null;
  const out = { nick, pts: num(b.pts), ok: num(b.ok), tot: num(b.tot), best: num(b.best), ts: Date.now(), badges: [], m: {} };
  if ([out.pts, out.ok, out.tot, out.best].some(v => v === null)) return null;
  if (out.ok > out.tot) out.ok = out.tot;
  out.slug = nick.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'jugador';
  if (Array.isArray(b.badges)) out.badges = b.badges.filter(x => typeof x === 'string' && BADGE_RE.test(x)).slice(0, 12);
  const m = b.m && typeof b.m === 'object' ? b.m : {};
  for (const k of MODS) { const s = m[k]; if (s && typeof s === 'object') { const p = num(s.pts), o = num(s.ok), t = num(s.tot); if (p !== null && o !== null && t !== null) out.m[k] = { pts: p, ok: Math.min(o, t), tot: t }; } }
  return out;
}

// ---------- límite de peticiones por IP (en memoria) ----------
const hits = new Map();
function limited(ip, max) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 60000); recent.push(now); hits.set(ip, recent);
  return recent.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 60000).unref();

// ---------- HTTP ----------
const HEAD = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
function send(res, code, body, type) { res.writeHead(code, Object.assign({ 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' }, HEAD)); res.end(body); }
const json = (res, code, o) => send(res, code, JSON.stringify(o));
function readBody(req, max) {
  return new Promise((ok, ko) => {
    let n = 0; const ch = [];
    let over = false;
    // Si se pasa del límite se responde 413 y se descarta el resto sin cortar la conexión de golpe.
    req.on('data', c => { if (over) return; n += c.length; if (n > max) { over = true; ch.length = 0; ko(Object.assign(new Error('grande'), { status: 413 })); } else ch.push(c); });
    req.on('end', () => ok(Buffer.concat(ch).toString('utf8')));
    req.on('error', ko);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); const p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (p === '/healthz') return json(res, 200, { ok: true });
    if ((p === '/' || p === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      const html = fs.readFileSync(PAGE);
      res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, HEAD)); return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (p === '/api/rank' && req.method === 'GET') {
      if (limited('g' + ip, 120)) return json(res, 429, { error: 'demasiadas peticiones' });
      return json(res, 200, await store.list());
    }
    const m = /^\/api\/rank\/([^/]+)$/.exec(p);
    if (m) {
      let id; try { id = decodeURIComponent(m[1]); } catch (e) { return json(res, 400, { error: 'id' }); }
      if (!ID_RE.test(id)) return json(res, 400, { error: 'id no válido' });
      if (req.method === 'PUT') {
        if (limited('w' + ip, 40)) return json(res, 429, { error: 'demasiadas peticiones' });
        let body; try { body = JSON.parse(await readBody(req, 8192)); } catch (e) { return json(res, e.status || 400, { error: 'cuerpo no válido' }); }
        const doc = validate(body); if (!doc) return json(res, 400, { error: 'datos no válidos' });
        doc.id = id; // el cliente lo usa para saber si el servidor conserva su documento (si se reinició, lo vuelve a enviar)
        await store.put(id, doc); return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (limited('w' + ip, 40)) return json(res, 429, { error: 'demasiadas peticiones' });
        await store.del(id); return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'método no permitido' });
    }
    return json(res, 404, { error: 'no encontrado' });
  } catch (e) { console.error(e); return json(res, 500, { error: 'error del servidor' }); }
});

store.init().then(() => server.listen(PORT, () => console.log('Ranking en el puerto ' + PORT)))
  .catch(e => { console.error('No se pudo iniciar el almacenamiento', e); process.exit(1); });
