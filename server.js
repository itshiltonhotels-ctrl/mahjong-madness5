// Mahjong Madness booking backend. Zero dependencies. Needs Node 22+.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const E = process.env;
const PORT = E.PORT || 3000;
const CFG = { tables: 4, cap: 4, fee: 1000, rent: 500, sets: +(E.RENTAL_SETS || 8), open: 720, close: 1080, dur: 120, step: 30 };
const STAFF_EMAIL = E.STAFF_EMAIL || 'murali.dg@shiltonhospitality.com';
const db = new DatabaseSync(E.DB_PATH || 'bookings.db');
db.exec(`CREATE TABLE IF NOT EXISTS bookings(
 id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, date TEXT, start INTEGER,
 players INTEGER, type TEXT, tbl INTEGER, sets INTEGER, game_fee INTEGER, rental_fee INTEGER, total INTEGER,
 games INTEGER DEFAULT 1, pay_method TEXT DEFAULT 'Pay at venue', pay_status TEXT DEFAULT 'Pending',
 status TEXT DEFAULT 'confirmed', requests TEXT, cancelled_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, email_status TEXT)`);

for (const c of ['hold_until INTEGER', 'order_id TEXT', 'payment_id TEXT', 'refund_status TEXT', 'refund_ref TEXT', 'refund_note TEXT', 'paid_at TEXT']) { try { db.exec('ALTER TABLE bookings ADD COLUMN ' + c); } catch {} }
const HOLD = +(E.HOLD_MINUTES || 10), PAYU = () => !!(E.PAYU_KEY && E.PAYU_SALT);
const sha512 = t => crypto.createHash('sha512').update(t).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const formBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { req.destroy(); no(); } }); req.on('end', () => { try { ok((req.headers['content-type'] || '').includes('json') ? JSON.parse(d) : Object.fromEntries(new URLSearchParams(d))); } catch { ok({}); } }); });
db.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY AUTOINCREMENT, tbl INTEGER, date TEXT, start INTEGER, end INTEGER, reason TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, name TEXT, role TEXT, pass TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, username TEXT, expires INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, username TEXT, action TEXT, detail TEXT, ip TEXT)`);
const getSet = (k, d) => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? +r.v : d; };
const setsAvail = () => Math.max(0, getSet('sets_total', CFG.sets) - getSet('sets_damaged', 0));
function blockOcc() { // table closures shown to the booking page as occupied tables
  const out = [];
  for (const k of db.prepare('SELECT * FROM blocks WHERE date>=?').all(istNow().d)) {
    for (let x = k.start; x <= Math.max(k.start, k.end - CFG.dur); x += CFG.step) out.push({ id: 'blk' + k.id, date: k.date, start: x, players: CFG.cap, type: 'private', table: k.tbl, sets: 0, status: 'confirmed' });
  }
  return out;
}
const pad = n => String(n).padStart(2, '0');
const fmt = m => { const h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + (mm ? ':' + pad(mm) : '') + ' ' + (h < 12 ? 'AM' : 'PM'); };
const rng = s => fmt(s) + ' – ' + fmt(s + CFG.dur);
const istNow = () => { const p = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }); return { d: p.slice(0, 10), m: +p.slice(11, 13) * 60 + +p.slice(14, 16), t: Date.parse(p.replace(' ', 'T') + 'Z') }; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function overlapping(date, s, ignore) {
  return db.prepare(`SELECT * FROM bookings WHERE (status='confirmed' OR (status='held' AND hold_until>?)) AND date=? AND id<>? AND ABS(start-?)<?`).all(Date.now(), date, ignore || '', s, CFG.dur);
}
function allocate(date, s, type, n, sets, ignore, only) {
  const ex = overlapping(date, s, ignore);
  if (setsAvail() - ex.reduce((a, b) => a + b.sets, 0) < sets) return -1;
  const bl = db.prepare('SELECT tbl FROM blocks WHERE date=? AND start<? AND end>?').all(date, s + CFG.dur, s).map(r => r.tbl);
  for (let t = 0; t < CFG.tables; t++) {
    if (bl.includes(t) || (only != null && t !== only)) continue;
    const on = ex.filter(b => b.tbl === t);
    if (type === 'private' ? !on.length : !on.some(b => b.type === 'private') && on.reduce((a, b) => a + b.players, 0) + n <= CFG.cap) return t;
  }
  return -1;
}
function refId() { return 'MM-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }

async function sendMail(to, subject, html) {
  if (!E.RESEND_API_KEY || !E.FROM_EMAIL) { console.log('[email NOT sent, RESEND_API_KEY/FROM_EMAIL missing]', to, subject); return 'not_configured'; }
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: E.FROM_EMAIL, to: [to], subject, html }) });
    return r.ok ? 'sent' : 'failed:' + r.status + ' ' + (await r.text()).slice(0, 200);
  } catch (e) { return 'failed'; }
}
const VENUE = "Watson's Vasanth Nagar,<br>1st Floor, Kodava Samaja Building,<br>Vasanth Nagar, Bengaluru, Karnataka 560001.";
const typeLbl = t => t === 'private' ? 'Private Table' : 'Individual Seats';
function details(b) {
  return `Booking ID: ${b.id}<br>Date: ${b.date}<br>Time: ${rng(b.start)}<br>People: ${b.players}<br>Game: Three rounds<br>Booking: One whole table<br>Table Fee: ₹${b.game_fee}<br>Mahjong Sets Rented: ${b.sets}<br>Set Rental: ₹${b.rental_fee}<br>Total Amount: ₹${b.total}<br>Payment: ${b.pay_method} (${b.pay_status})`;
}
async function notifyBooked(b) {
  const guest = !b.email ? 'no_email' : await sendMail(b.email, 'Your Mahjong Madness booking is confirmed!',
    `<p>Hey ${esc(b.name)},</p><p>You're booked!<br>Your Mahjong Madness game at Watson's Vasanth Nagar is confirmed.</p><p>Here are your booking details:<br>${details(b)}</p><p>Venue:<br>${VENUE}</p><p>Get your crew together and get ready for some Mahjong madness!<br>See you at the table.</p><p>Exclusively curated by Watson's Cantina.</p>`);
  const staff = await sendMail(STAFF_EMAIL, `NEW BOOKING ${b.id}: ${b.date} ${rng(b.start)} (${b.players} players)`,
    `<p><b>New Mahjong Madness booking</b></p><p>${details(b)}</p><p>Guest: ${esc(b.name)}<br>Mobile: ${esc(b.phone)}<br>Email: ${esc(b.email)}<br>Assigned table: ${b.tbl + 1}<br>Special requests: ${esc(b.requests) || 'None'}</p>`);
  db.prepare('UPDATE bookings SET email_status=? WHERE id=?').run(`guest:${guest}; staff:${staff}`, b.id);
}
async function notifyCancelled(b) {
  if (b.email) await sendMail(b.email, 'Your Mahjong Madness booking has been cancelled.', `<p>Hey ${esc(b.name)},</p><p>Your Mahjong Madness booking has been cancelled.</p><p>Booking ID: ${b.id}<br>Date: ${b.date}<br>Time: ${rng(b.start)}</p><p>If your booking was paid online and is eligible for a refund, the applicable refund information will be shared through the configured payment process.</p><p>Hope to see you at the table another time!</p>`);
  await sendMail(STAFF_EMAIL, `CANCELLED ${b.id}: ${b.date} ${rng(b.start)}`, `<p>Booking cancelled by guest.</p><p>${details(b)}</p><p>Guest: ${esc(b.name)}, ${esc(b.phone)}</p>`);
}

// ---- PayU: build the signed payment form (the salt never leaves the server) ----
function payuStart(b, req) {
  const txnid = b.id.replace(/\W/g, '') + 'T' + crypto.randomBytes(2).toString('hex');
  db.prepare('UPDATE bookings SET order_id=? WHERE id=?').run(txnid, b.id);
  const amount = Number(b.total).toFixed(2), productinfo = 'Mahjong Madness game';
  const firstname = String(b.name).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 40) || 'Guest';
  const base = E.PUBLIC_URL || ('https://' + req.headers.host);
  const f = { key: E.PAYU_KEY, txnid, amount, productinfo, firstname, email: b.email, phone: b.phone, surl: base + '/api/payu/return', furl: base + '/api/payu/return', udf1: b.id };
  f.hash = sha512([f.key, txnid, amount, productinfo, firstname, b.email, b.id, '', '', '', '', '', '', '', '', '', E.PAYU_SALT].join('|'));
  return { action: (E.PAYU_ENV === 'test' ? 'https://test.payu.in' : 'https://secure.payu.in') + '/_payment', fields: f };
}
async function verifyPayu(txnid) {
  const cmd = 'verify_payment';
  const r = await fetch((E.PAYU_ENV === 'test' ? 'https://test.payu.in' : 'https://info.payu.in') + '/merchant/postservice?form=2', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: E.PAYU_KEY, command: cmd, var1: txnid, hash: sha512([E.PAYU_KEY, cmd, txnid, E.PAYU_SALT].join('|')) }) });
  return r.json();
}
// Checks PayU's reply (reverse hash + amount + reconciliation) and confirms the booking only if genuine.
async function handlePayu(p) {
  const id = p.udf1 || '';
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND order_id=?').get(id, p.txnid || '');
  if (!b || !PAYU()) return { ok: false, id };
  const rev = [E.PAYU_SALT, p.status, '', '', '', '', '', p.udf5 || '', p.udf4 || '', p.udf3 || '', p.udf2 || '', p.udf1 || '', p.email, p.firstname, p.productinfo, p.amount, p.txnid, E.PAYU_KEY];
  if (p.additionalCharges) rev.unshift(p.additionalCharges);
  if (!safeEq(sha512(rev.join('|')), String(p.hash || '').toLowerCase())) { console.error('PayU hash mismatch for', id); return { ok: false, id }; }
  if (p.status !== 'success' || Number(p.amount) !== Number(b.total)) return { ok: false, id };
  try { const v = await verifyPayu(p.txnid), t = v && v.transaction_details && v.transaction_details[p.txnid]; if (t && t.status && t.status !== 'success') return { ok: false, id }; }
  catch (e) { console.error('PayU verify_payment unreachable, relying on signed reply', e.message); }
  const r = await confirmPaid(b.id, p.mihpayid || '');
  return { ok: !!r && !r.problem, id };
}
// Confirms a booking after VERIFIED payment (called from verify endpoint and webhook). Safe to call twice.
async function confirmPaid(id, paymentId) {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b) return null;
  if (b.status === 'confirmed') return b;
  if (b.status !== 'held') return { ...b, problem: true };
  if (b.hold_until < Date.now()) { // hold expired: only confirm if capacity is still free
    const t = allocate(b.date, b.start, b.type, b.players, b.sets, b.id);
    if (t < 0) {
      db.prepare(`UPDATE bookings SET status='paid_conflict',payment_id=?,pay_status='Paid - NEEDS REFUND' WHERE id=?`).run(paymentId, b.id);
      sendMail(STAFF_EMAIL, 'ACTION NEEDED: paid booking ' + b.id + ' has no free table', '<p>The guest paid after the hold expired and the slot was taken. Please contact ' + esc(b.name) + ', ' + esc(b.phone) + ' and arrange a refund. Payment ID: ' + esc(paymentId) + '</p>');
      return { ...b, problem: true };
    }
    db.prepare('UPDATE bookings SET tbl=? WHERE id=?').run(t, b.id);
  }
  db.prepare(`UPDATE bookings SET status='confirmed',pay_status='Paid',payment_id=?,hold_until=NULL,paid_at=? WHERE id=?`).run(paymentId, new Date().toISOString(), b.id);
  audit(null, 'system', 'payment_confirmed', b.id + ' ₹' + b.total + ' ' + paymentId);
  const nb = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  notifyBooked(nb);
  return nb;
}
const ADMIN_ONLY = new Set(['users', 'audit', 'report', 'settings', 'refund', 'markrefunded', 'markpaid', 'user/create', 'user/update', 'user/password']);
async function adminApi(req, res, url, sess) {
  const p = url.pathname.slice('/admin/api/'.length), j = (c, o) => json(res, c, o), now = istNow();
  if (ADMIN_ONLY.has(p) && sess.role !== 'admin') return j(403, { error: 'Admin access required.' });
  const g = k => url.searchParams.get(k) || '';
  if (p === 'me') return j(200, { user: sess.user, role: sess.role, owner: sess.user === OWNER() });
  if (p === 'users') return j(200, { owner: OWNER(), users: db.prepare('SELECT id,username,name,role,active,created_at,last_login FROM users ORDER BY username').all() });
  if (p === 'audit') {
    const from = g('from'), to = g('to'), usr = g('user'), act = g('action'), q = g('q').toLowerCase();
    const all = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 5000').all();
    const rows = all.filter(a => { const d = toIstDate(a.at); return (!from || d >= from) && (!to || d <= to) && (!usr || a.username === usr) && (!act || a.action === act) && (!q || (a.detail + ' ' + a.action).toLowerCase().includes(q)); });
    return j(200, { rows: rows.slice(0, 1000), users: [...new Set(all.map(a => a.username))].sort(), actions: [...new Set(all.map(a => a.action))].sort() });
  }
  if (p === 'guests') {
    const q = g('q').toLowerCase().trim(), m = new Map();
    for (const b of db.prepare(`SELECT * FROM bookings WHERE status IN ('confirmed','cancelled') ORDER BY date,start`).all()) {
      const k = String(b.phone).slice(-10); let a = m.get(k);
      if (!a) m.set(k, a = { phone: k, name: b.name, email: '', bookings: 0, cancelled: 0, paid: 0, refunded: 0, first: b.date, last: b.date, last_id: b.id });
      a.name = b.name; if (b.email) a.email = b.email; a.last = b.date; a.last_id = b.id;
      if (b.status === 'confirmed') { a.bookings++; if (b.pay_status === 'Paid') a.paid += b.total; } else { a.cancelled++; if (b.refund_status === 'Refunded') a.refunded += b.total; }
    }
    let list = [...m.values()].filter(a => !q || [a.name, a.phone, a.email].join(' ').toLowerCase().includes(q)).sort((a, b) => b.last.localeCompare(a.last));
    return j(200, { guests: list.slice(0, 500), count: list.length });
  }
  if (p === 'report') {
    const from = g('from'), to = g('to'), grp = g('group') === 'month' ? 'month' : 'day', basis = g('basis') === 'paid' ? 'paid' : 'play';
    const dateOf = b => basis === 'paid' ? toIstDate(b.paid_at || b.created_at) : b.date;
    const sel = db.prepare(`SELECT * FROM bookings WHERE status IN ('confirmed','cancelled')`).all().filter(b => { const d = dateOf(b); return (!from || d >= from) && (!to || d <= to); });
    const blank = k => ({ period: k, bookings: 0, people: 0, table_fees: 0, rental_fees: 0, gross: 0, collected: 0, refunded: 0, refund_pending: 0, cancelled: 0, net: 0 }), groups = new Map();
    for (const b of sel) {
      const d = dateOf(b), k = grp === 'month' ? d.slice(0, 7) : d; let a = groups.get(k); if (!a) groups.set(k, a = blank(k));
      if (b.status === 'confirmed') { a.bookings++; a.people += b.players; a.table_fees += b.game_fee; a.rental_fees += b.rental_fee; a.gross += b.total; } else a.cancelled++;
      if (b.pay_status === 'Paid') a.collected += b.total;
      if (b.refund_status === 'Refunded') a.refunded += b.total; else if (String(b.refund_status || '').startsWith('Refund')) a.refund_pending += b.total;
    }
    const list = [...groups.values()].sort((a, b) => a.period.localeCompare(b.period)); list.forEach(a => a.net = a.collected - a.refunded - a.refund_pending);
    const tot = blank('Total'); list.forEach(a => { for (const k of Object.keys(tot)) if (k !== 'period') tot[k] += a[k]; });
    const payments = sel.filter(b => b.pay_status === 'Paid' || b.refund_status).map(b => ({ date: dateOf(b), play_date: b.date, id: b.id, name: b.name, phone: b.phone, method: b.pay_method, payment_id: b.payment_id || '', txnid: b.order_id || '', amount: b.total, pay_status: b.pay_status, status: b.status, refund_status: b.refund_status || '', paid_at: b.paid_at || b.created_at || '' })).sort((a, b) => b.date.localeCompare(a.date));
    return j(200, { groups: list, totals: tot, payments });
  }
  if (p === 'day') {
    const d = url.searchParams.get('date') || now.d;
    const b = db.prepare(`SELECT * FROM bookings WHERE date=? AND (status='confirmed' OR (status='held' AND hold_until>?)) ORDER BY start`).all(d, Date.now());
    return j(200, { date: d, tables: CFG.tables, bookings: b, blocks: db.prepare('SELECT * FROM blocks WHERE date=? ORDER BY start').all(d), sets: { total: getSet('sets_total', CFG.sets), damaged: getSet('sets_damaged', 0), booked: b.reduce((a, x) => a + x.sets, 0) } });
  }
  if (p === 'bookings') {
    const g = k => url.searchParams.get(k) || '', q = g('q').toLowerCase().trim(), qd = q.replace(/\D/g, ''), pm = g('pm'), ps = g('ps'), st = g('st') || 'active', from = g('from'), to = g('to');
    let r = db.prepare('SELECT * FROM bookings ORDER BY date DESC,start DESC').all();
    r = r.filter(b => {
      if (st === 'any' ? false : st === 'active' ? !['confirmed', 'held'].includes(b.status) : st === 'all' ? b.status === 'failed' : b.status !== st) return false;
      if (pm === 'online' && b.pay_method !== 'Online') return false;
      if (pm === 'venue' && b.pay_method === 'Online') return false;
      if (ps === 'paid' && b.pay_status !== 'Paid') return false;
      if (ps === 'pending' && b.pay_status === 'Paid') return false;
      if (ps === 'refund' && !String(b.refund_status || '').startsWith('Refund')) return false;
      if (ps === 'awaiting' && b.status !== 'held') return false;
      if ((from && b.date < from) || (to && b.date > to)) return false;
      if (q && !([b.name, b.id, b.email].join(' ').toLowerCase().includes(q) || (qd.length >= 3 && String(b.phone).includes(qd)))) return false;
      return true;
    });
    const ok = r.filter(b => b.status === 'confirmed'), sum = (a, f) => a.reduce((t, b) => t + (+f(b) || 0), 0);
    return j(200, { bookings: r.slice(0, 500), totals: { count: r.length, players: sum(ok, b => b.players), game: sum(ok, b => b.game_fee), rental: sum(ok, b => b.rental_fee), total: sum(ok, b => b.total), paid: sum(ok.filter(b => b.pay_status === 'Paid'), b => b.total), pending: sum(ok.filter(b => b.pay_status !== 'Paid'), b => b.total), online: sum(ok.filter(b => b.pay_method === 'Online'), b => b.total), cancelled: r.filter(b => b.status === 'cancelled').length, refunds: r.filter(b => b.refund_status === 'Refund due' || b.refund_status === 'Refund failed').length } });
  }
  if (p === 'booking') { const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(url.searchParams.get('id') || ''); return b ? j(200, { booking: b }) : j(404, { error: 'Not found' }); }
  if (p === 'blocks') return j(200, { blocks: db.prepare('SELECT * FROM blocks WHERE date>=? ORDER BY date,start').all(now.d) });
  if (req.method !== 'POST') return j(404, { error: 'Not found' });
  const x = await body(req), live = id => db.prepare(`SELECT * FROM bookings WHERE id=? AND status IN ('confirmed','held')`).get(id || '');
  if (p === 'cancel') {
    const b = live(x.id); if (!b) return j(404, { error: 'Booking not found.' });
    const refund = cancelRow(b);
    notifyCancelled(b); audit(req, sess.user, 'cancel_booking', b.id + (refund ? ' (refund due)' : ''));
    return j(200, { ok: true, note: refund ? 'Refund is due: use the Refund button on this booking.' : '' });
  }
  if (p === 'refund') {
    const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND status='cancelled' AND refund_status IN ('Refund due','Refund failed')`).get(x.id || '');
    if (!b || !b.payment_id || !PAYU()) return j(404, { error: 'No refund can be started for this booking (payment ID missing or PayU not configured).' });
    try {
      const r = await payuRefund(b);
      if (Number(r.status) === 1) { db.prepare(`UPDATE bookings SET refund_status='Refund requested',refund_ref=?,refund_note=? WHERE id=?`).run(String(r.txn_update_id || r.token), String(r.msg || ''), b.id); audit(req, sess.user, 'refund_requested', b.id + ' ₹' + b.total); return j(200, { ok: true, msg: r.msg }); }
      db.prepare(`UPDATE bookings SET refund_status='Refund failed',refund_note=? WHERE id=?`).run(String(r.msg || '').slice(0, 200), b.id);
      return j(502, { error: 'PayU did not accept the refund: ' + String(r.msg || 'unknown reason').slice(0, 200) });
    } catch (e) { return j(502, { error: 'Could not reach PayU. Try again, or refund from your PayU dashboard and use Mark refunded.' }); }
  }
  if (p === 'markrefunded') { db.prepare(`UPDATE bookings SET refund_status='Refunded' WHERE id=? AND status='cancelled'`).run(x.id || ''); audit(req, sess.user, 'refund_marked_done', x.id); return j(200, { ok: true }); }
  if (p === 'markpaid') { db.prepare(`UPDATE bookings SET pay_status='Paid' WHERE id=? AND status='confirmed'`).run(x.id || ''); return j(200, { ok: true }); }
  if (p === 'move') {
    const b = live(x.id), t = +x.tbl; if (!b) return j(404, { error: 'Booking not found.' });
    if (!(t >= 0 && t < CFG.tables)) return j(400, { error: 'Invalid table.' });
    db.exec('BEGIN IMMEDIATE');
    if (allocate(b.date, b.start, b.type, b.players, b.sets, b.id, t) < 0) { db.exec('ROLLBACK'); return j(409, { error: 'That table is not free (or is blocked) at that time.' }); }
    db.prepare('UPDATE bookings SET tbl=? WHERE id=?').run(t, b.id); db.exec('COMMIT'); audit(req, sess.user, 'move_booking', b.id + ' to table ' + (t + 1));
    return j(200, { ok: true });
  }
  if (p === 'block') {
    const t = +x.tbl, st = +x.start, en = +x.end;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date || '') || !(t >= -1 && t < CFG.tables) || !(st >= CFG.open && en <= CFG.close && en > st)) return j(400, { error: 'Invalid date, table or time.' });
    let conflicts = 0;
    for (const tt of t === -1 ? [0, 1, 2, 3] : [t]) {
      db.prepare('INSERT INTO blocks(tbl,date,start,end,reason) VALUES(?,?,?,?,?)').run(tt, x.date, st, en, String(x.reason || '').slice(0, 100));
      conflicts += db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='confirmed' AND date=? AND tbl=? AND start<? AND start+?>?`).get(x.date, tt, en, CFG.dur, st).c;
    }
    audit(req, sess.user, 'block_table', (t === -1 ? 'all tables' : 'table ' + (t + 1)) + ' ' + x.date + ' ' + st + '-' + en + ' ' + String(x.reason || ''));
    return j(200, { ok: true, conflicts });
  }
  if (p === 'book') { // staff-created (phone / walk-in) booking
    const n = +x.players, q = +x.sets || 0, st = +x.start, only = (x.tbl === '' || x.tbl == null || +x.tbl < 0) ? undefined : +x.tbl;
    const errs = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date || '') || x.date < now.d) errs.push('Choose today or a future date.');
    if (!Number.isInteger(st) || st < CFG.open || st + CFG.dur > CFG.close || (st - CFG.open) % CFG.step) errs.push('Invalid time.');
    x.type = 'private'; // whole-table bookings only
    if (!(n >= 1 && n <= 4)) errs.push('Players must be 1 to 4.');
    if (!(q >= 0 && q <= 4)) errs.push('Invalid number of sets.');
    if (String(x.name || '').trim().length < 2) errs.push('Name required.');
    if (!/^(91)?[6-9]\d{9}$/.test(String(x.phone || '').replace(/\D/g, ''))) errs.push('Valid mobile number required.');
    if (x.email && !/^\S+@\S+\.\S+$/.test(x.email)) errs.push('Email looks invalid (leave it empty if unknown).');
    if (errs.length) return j(400, { error: errs.join(' ') });
    db.exec('BEGIN IMMEDIATE');
    const t = allocate(x.date, st, x.type, n, q, undefined, only);
    if (t < 0) { db.exec('ROLLBACK'); return j(409, { error: 'No table (or not enough rental sets) free for that time.' }); }
    const b = { id: refId(), name: String(x.name).trim(), phone: String(x.phone).replace(/\D/g, ''), email: String(x.email || '').trim(), date: x.date, start: st, players: n, type: x.type, tbl: t, sets: q, game_fee: CFG.fee, rental_fee: q * CFG.rent, total: CFG.fee + q * CFG.rent, pay_method: 'Pay at venue', pay_status: x.paid ? 'Paid' : 'Pending', requests: String(x.requests || '').slice(0, 500) };
    db.prepare(`INSERT INTO bookings(id,name,phone,email,date,start,players,type,tbl,sets,game_fee,rental_fee,total,pay_method,pay_status,requests,status,hold_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',NULL)`).run(b.id, b.name, b.phone, b.email, b.date, b.start, b.players, b.type, b.tbl, b.sets, b.game_fee, b.rental_fee, b.total, b.pay_method, b.pay_status, b.requests);
    db.exec('COMMIT');
    notifyBooked(b);
    return j(201, { ok: true, booking: b });
  }
  if (p === 'export-log') { audit(req, sess.user, 'export', String(x.what || '').slice(0, 100)); return j(200, { ok: true }); }
  if (p === 'me/password') {
    if (sess.user === OWNER()) return j(400, { error: 'The owner password is set in Render (ADMIN_PASS). Change it there.' });
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(sess.user);
    if (!u || !checkPw(String(x.current || ''), u.pass)) return j(400, { error: 'Current password is wrong.' });
    if (String(x.password || '').length < 8) return j(400, { error: 'New password must be at least 8 characters.' });
    db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPw(String(x.password)), u.id); audit(req, sess.user, 'password_changed', ''); return j(200, { ok: true });
  }
  if (p === 'user/create') {
    const un = String(x.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(un)) return j(400, { error: 'User ID: 3 to 30 characters, letters, numbers, dot, dash or underscore.' });
    if (un === OWNER() || db.prepare('SELECT 1 FROM users WHERE username=?').get(un)) return j(409, { error: 'That user ID already exists.' });
    if (!['admin', 'staff'].includes(x.role)) return j(400, { error: 'Choose a role.' });
    if (String(x.password || '').length < 8) return j(400, { error: 'Password must be at least 8 characters.' });
    db.prepare('INSERT INTO users(username,name,role,pass) VALUES(?,?,?,?)').run(un, String(x.name || '').trim().slice(0, 60), x.role, hashPw(String(x.password)));
    audit(req, sess.user, 'user_created', un + ' (' + x.role + ')'); return j(200, { ok: true });
  }
  if (p === 'user/update') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(+x.id); if (!u) return j(404, { error: 'User not found.' });
    if (u.username === sess.user && (x.active === 0 || x.active === false)) return j(400, { error: 'You cannot disable your own account.' });
    const role = ['admin', 'staff'].includes(x.role) ? x.role : u.role, active = x.active === undefined ? u.active : (x.active ? 1 : 0);
    db.prepare('UPDATE users SET role=?,active=? WHERE id=?').run(role, active, u.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE username=?').run(u.username);
    audit(req, sess.user, 'user_updated', u.username + ' role=' + role + ' active=' + active); return j(200, { ok: true });
  }
  if (p === 'user/password') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(+x.id); if (!u) return j(404, { error: 'User not found.' });
    if (String(x.password || '').length < 8) return j(400, { error: 'Password must be at least 8 characters.' });
    db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPw(String(x.password)), u.id); db.prepare('DELETE FROM sessions WHERE username=?').run(u.username);
    audit(req, sess.user, 'password_reset', u.username); return j(200, { ok: true });
  }
  if (p === 'unblock') { db.prepare('DELETE FROM blocks WHERE id=?').run(+x.id); audit(req, sess.user, 'unblock_table', 'block #' + x.id); return j(200, { ok: true }); }
  if (p === 'settings') {
    const up = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
    const tot = Math.max(0, Math.min(200, +x.sets_total | 0)), dmg = Math.max(0, Math.min(tot, +x.sets_damaged | 0));
    up('sets_total', tot); up('sets_damaged', dmg); audit(req, sess.user, 'rental_sets', 'total ' + tot + ', damaged ' + dmg);
    return j(200, { ok: true, available: tot - dmg });
  }
  return j(404, { error: 'Not found' });
}
// ---------- staff accounts, sessions, activity log ----------
const OWNER = () => (E.ADMIN_USER || 'admin').trim().toLowerCase();
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const checkPw = (pw, stored) => { const [salt, h] = String(stored || '').split(':'); return !!(salt && h) && safeEq(crypto.scryptSync(pw, salt, 32).toString('hex'), h); };
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const ipOf = req => req ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() : '';
const toIstDate = t => new Date(/Z$|\+\d\d:?\d\d$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z').toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
function audit(req, user, action, detail) { db.prepare('INSERT INTO audit(at,username,action,detail,ip) VALUES(?,?,?,?,?)').run(new Date().toISOString(), user || '', action, String(detail || '').slice(0, 300), ipOf(req)); }
function getSession(req) {
  const m = /(?:^|; )mm_session=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(sha(m[1]), Date.now()); if (!s) return null;
  if (s.username === OWNER()) return { user: s.username, role: 'admin' };
  const u = db.prepare('SELECT active,role FROM users WHERE username=?').get(s.username);
  return u && u.active ? { user: s.username, role: u.role } : null;
}
function doLogin(req, username, password) {
  const un = String(username || '').trim().toLowerCase(), pw = String(password || ''); let ok = false;
  if (E.ADMIN_PASS && un === OWNER() && safeEq(pw, E.ADMIN_PASS.trim())) ok = true;
  else { const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(un); if (u && checkPw(pw, u.pass)) { ok = true; db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), u.id); } }
  if (!ok) { audit(req, un || '?', 'login_failed', ''); return null; }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions(token,username,expires) VALUES(?,?,?)').run(sha(token), un, Date.now() + 12 * 36e5);
  audit(req, un, 'login', ''); return token;
}
const lfails = new Map(); setInterval(() => lfails.clear(), 36e5).unref();
const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Mahjong Madness Admin Login</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101F46;font:16px system-ui,sans-serif}form{background:#F7F3E9;padding:28px;border-radius:18px;width:min(92vw,360px)}h1{margin:0 0 14px;color:#101F46;font-size:1.3rem}label{display:block;font-weight:700;font-size:.8rem;margin:10px 0 4px}input{width:100%;padding:11px;border:2px solid #101F46;border-radius:8px;font:inherit}button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#F5D442;color:#101F46;font:700 1rem system-ui;cursor:pointer}p{color:#a12;min-height:1.2em;margin:10px 0 0}</style></head><body><form id="f"><h1>Mahjong Madness · Admin</h1><label for="u">User ID</label><input id="u" autocomplete="username" autofocus><label for="p">Password</label><input id="p" type="password" autocomplete="current-password"><button>Sign in</button><p id="m" role="alert"></p></form><script>document.getElementById('f').onsubmit=function(e){e.preventDefault();fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(o){if(o.ok)location.href='/admin';else document.getElementById('m').textContent=o.j.error||'Could not sign in.'}).catch(function(){document.getElementById('m').textContent='Could not reach the server.'})}</script></body></html>`;
// simple brute-force guard for guest lookups: 10 attempts per IP per 15 minutes
const tries = new Map(); setInterval(() => tries.clear(), 36e5).unref();
function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
  const a = (tries.get(ip) || []).filter(t => now - t < 9e5); a.push(now); tries.set(ip, a);
  return a.length > 10;
}
const TOO_MANY = { error: 'Too many attempts. Please try again in 15 minutes, or contact our booking team: Alka Nagpal +91 99801 36969 or Vedashree +91 98452 71738.' };
// Cancels a booking row; if it was paid online, flag a refund as due (staff trigger the actual refund).
function cancelRow(b) {
  const refund = b.pay_method === 'Online' && b.pay_status === 'Paid';
  db.prepare(`UPDATE bookings SET status='cancelled',cancelled_at=?,refund_status=? WHERE id=?`).run(new Date().toISOString(), refund ? 'Refund due' : null, b.id);
  if (refund) sendMail(STAFF_EMAIL, 'REFUND DUE: ' + b.id, '<p>Booking ' + b.id + ' (' + esc(b.name) + ', ' + esc(b.phone) + ') was cancelled and paid online: ₹' + b.total + '. Open the admin dashboard to refund it via PayU.</p>');
  return refund;
}
async function payuRefund(b) {
  const cmd = 'cancel_refund_transaction', token = ('RF' + b.id.replace(/\W/g, '') + Date.now().toString(36)).slice(0, 23);
  const r = await fetch((E.PAYU_ENV === 'test' ? 'https://test.payu.in' : 'https://info.payu.in') + '/merchant/postservice?form=2', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: E.PAYU_KEY, command: cmd, var1: b.payment_id, var2: token, var3: Number(b.total).toFixed(2), hash: sha512([E.PAYU_KEY, cmd, b.payment_id, E.PAYU_SALT].join('|')) }) });
  return { ...(await r.json()), token };
}
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
const body = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e4) { req.destroy(); no(); } }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { no(); } }); });
function authed(req) {
  const t = Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString(), i = t.indexOf(':');
  const u = t.slice(0, i), p = t.slice(i + 1); // password may itself contain ':'
  return !!E.ADMIN_PASS && i > -1 && u === (E.ADMIN_USER || 'admin').trim() && p === E.ADMIN_PASS.trim();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/occupancy') // anonymised: no guest data
      return json(res, 200, [...blockOcc(), ...db.prepare(`SELECT id,date,start,players,type,tbl AS "table",sets,status FROM bookings WHERE (status='confirmed' OR (status='held' AND hold_until>${Date.now()})) AND date>=?`).all(istNow().d)]);

    if (url.pathname === '/api/config') return json(res, 200, { enabled: PAYU(), test: E.PAYU_ENV === 'test', sets: setsAvail() });

    if (url.pathname === '/api/pay/start' && req.method === 'POST') { // retry payment for a held booking
      const x = await body(req);
      const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(email)=lower(?) AND status='held'`).get(x.id || '', x.email || '');
      if (!b || !PAYU()) return json(res, 404, { error: 'Booking not found.' });
      if (b.hold_until < Date.now()) return json(res, 410, { error: 'Your table hold has expired. Please make a new booking.' });
      return json(res, 200, { payu: payuStart(b, req) });
    }

    if (url.pathname === '/api/booking/lookup' && req.method === 'POST') { // guest finds own booking: reference + email must both match
      if (limited(req)) return json(res, 429, TOO_MANY);
      const x = await body(req);
      const b = db.prepare(`SELECT id,name,date,start,players,type,sets,game_fee,rental_fee,total,pay_method,pay_status,status,refund_status FROM bookings WHERE upper(id)=upper(?) AND lower(email)=lower(?) AND status IN ('confirmed','cancelled','held')`).get(String(x.id || '').trim(), String(x.email || '').trim());
      return b ? json(res, 200, { booking: b }) : json(res, 404, { error: "We couldn't find a booking with those details. Please check the reference and email." });
    }

    if (url.pathname === '/api/booking/status' && req.method === 'POST') {
      const x = await body(req);
      const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(email)=lower(?) AND status='confirmed'`).get(x.id || '', x.email || '');
      return b ? json(res, 200, { booking: b }) : json(res, 404, { error: 'Booking not confirmed yet.' });
    }

    if (url.pathname === '/api/payu/return' && req.method === 'POST') { // guest is sent back here by PayU
      const r = await handlePayu(await formBody(req));
      res.writeHead(303, { Location: '/?pay=' + (r.ok ? 'success' : 'failed') + '&ref=' + encodeURIComponent(r.id || '') });
      return res.end();
    }

    if (url.pathname === '/api/payu/webhook' && req.method === 'POST') { // server-to-server backup from PayU
      await handlePayu(await formBody(req));
      res.writeHead(200); return res.end('ok');
    }

    if (url.pathname === '/api/bookings' && req.method === 'POST') {
      const x = await body(req), n = +x.players, q = +x.sets || 0, now = istNow();
      const errs = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date) || x.date < now.d) errs.push('Invalid or past date.');
      if (!Number.isInteger(x.start) || x.start < CFG.open || x.start + CFG.dur > CFG.close || (x.start - CFG.open) % CFG.step) errs.push('Invalid time.');
      if (x.date === now.d && x.start <= now.m) errs.push('That time has passed.');
      x.type = 'private'; // whole-table bookings only
      if (!(n >= 1 && n <= 4)) errs.push('Players must be 1 to 4.');
      if (!(q >= 0 && q <= 4)) errs.push('Invalid number of sets.');
      if (String(x.name || '').trim().length < 2) errs.push('Name required.');
      if (!/^(91)?[6-9]\d{9}$/.test(String(x.phone || '').replace(/\D/g, ''))) errs.push('Valid mobile required.');
      if (!/^\S+@\S+\.\S+$/.test(x.email || '')) errs.push('Valid email required.');
      if (!x.agreed) errs.push('Terms must be accepted.');
      if (errs.length) return json(res, 400, { error: errs.join(' ') });
      const online = true; // all bookings are paid online
      if (online && !PAYU()) return json(res, 400, { error: 'Online booking is temporarily unavailable. Please contact our booking team: Alka Nagpal +91 99801 36969 or Vedashree +91 98452 71738.' });
      let b;
      db.exec('BEGIN IMMEDIATE'); // atomic: no two guests can take the same capacity
      try {
        const t = allocate(x.date, x.start, x.type, n, q);
        if (t < 0) { db.exec('ROLLBACK'); return json(res, 409, { error: 'Sorry, that capacity was just taken. Please pick another slot.' }); }
        b = { id: refId(), name: String(x.name).trim(), phone: String(x.phone).replace(/\D/g, ''), email: x.email.trim(), date: x.date, start: x.start, players: n, type: x.type, tbl: t, sets: q, game_fee: CFG.fee, rental_fee: q * CFG.rent, total: CFG.fee + q * CFG.rent, pay_method: online ? 'Online' : 'Pay at venue', pay_status: online ? 'Awaiting payment' : 'Pending', requests: String(x.requests || '').slice(0, 500) };
        db.prepare(`INSERT INTO bookings(id,name,phone,email,date,start,players,type,tbl,sets,game_fee,rental_fee,total,pay_method,pay_status,requests,status,hold_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(b.id, b.name, b.phone, b.email, b.date, b.start, b.players, b.type, b.tbl, b.sets, b.game_fee, b.rental_fee, b.total, b.pay_method, b.pay_status, b.requests, online ? 'held' : 'confirmed', online ? Date.now() + HOLD * 60000 : null);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (online) return json(res, 201, { booking: b, payu: payuStart(b, req), holdMinutes: HOLD });
      notifyBooked(b); // async, booking is already saved
      return json(res, 201, { booking: b });
    }

    if (url.pathname === '/api/cancel' && req.method === 'POST') {
      if (limited(req)) return json(res, 429, TOO_MANY);
      const x = await body(req);
      const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(email)=lower(?) AND status='confirmed'`).get(x.id || '', x.email || '');
      if (!b) return json(res, 404, { error: 'Booking not found.' });
      const bt = Date.parse(b.date + 'T' + pad(Math.floor(b.start / 60)) + ':' + pad(b.start % 60) + ':00Z');
      if (bt - istNow().t < 864e5) return json(res, 403, { error: 'Free cancellation closes 24 hours before your booking. Please contact our booking team: Alka Nagpal +91 99801 36969 or Vedashree +91 98452 71738.' });
      const refund = cancelRow(b);
      notifyCancelled(b); audit(req, 'guest', 'guest_cancel', b.id + (refund ? ' (refund due)' : ''));
      return json(res, 200, { ok: true, refund });
    }

    if (url.pathname.startsWith('/admin')) {
      if (url.pathname === '/admin/login' && req.method === 'POST') {
        const ip = ipOf(req), now = Date.now(), a = (lfails.get(ip) || []).filter(t => now - t < 9e5);
        if (a.length >= 10) return json(res, 429, { error: 'Too many failed attempts. Please wait 15 minutes.' });
        const x = await body(req), tk = doLogin(req, x.username, x.password);
        if (!tk) { a.push(now); lfails.set(ip, a); return json(res, 401, { error: 'Wrong user ID or password.' }); }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `mm_session=${tk}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
        return res.end(JSON.stringify({ ok: true }));
      }
      const sess = getSession(req);
      if (url.pathname === '/admin/logout' && req.method === 'POST') {
        const m = /(?:^|; )mm_session=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (m) db.prepare('DELETE FROM sessions WHERE token=?').run(sha(m[1]));
        if (sess) audit(req, sess.user, 'logout', '');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mm_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0' }); return res.end('{"ok":true}');
      }
      if (!sess) { if (url.pathname.startsWith('/admin/api/')) return json(res, 401, { error: 'Please sign in again.' }); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML); }
      if (url.pathname === '/admin' || url.pathname === '/admin/') { const pg = fs.readFileSync(new URL('./admin.html', import.meta.url)); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(pg); }
      if (url.pathname.startsWith('/admin/api/')) return await adminApi(req, res, url, sess);
      if (sess.role !== 'admin') return json(res, 403, { error: 'Admin access required.' });
      if (url.pathname === '/admin/test-email') {
        const to = url.searchParams.get('to') || STAFF_EMAIL;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (!E.RESEND_API_KEY || !E.FROM_EMAIL) return res.end('RESEND_API_KEY or FROM_EMAIL is missing in Render Environment.\nKey set: ' + !!E.RESEND_API_KEY + '\nFrom set: ' + !!E.FROM_EMAIL);
        const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: E.FROM_EMAIL, to: [to], subject: 'Mahjong Madness test email', html: '<p>Test email works.</p>' }) });
        return res.end('To: ' + to + '\nFrom: ' + E.FROM_EMAIL + '\nKey starts with: ' + E.RESEND_API_KEY.slice(0, 3) + '\nResend status: ' + r.status + '\nResend reply: ' + await r.text());
      }
      const rows = db.prepare('SELECT * FROM bookings ORDER BY date DESC,start DESC').all();
      if (url.pathname === '/admin/export.csv') {
        const cols = Object.keys(rows[0] || { id: 1 });
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=bookings.csv' });
        return res.end([cols.join(','), ...rows.map(r => cols.map(c => '"' + String(r[c] ?? '').replace(/"/g, '""') + '"').join(','))].join('\n'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<meta name=viewport content="width=device-width"><body style="font:14px sans-serif;padding:16px"><h2>Mahjong Madness bookings</h2><p><a href="/admin/export.csv">Export CSV</a> · ${rows.length} total</p><div style="overflow-x:auto"><table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>Ref<th>Date<th>Time<th>Guest<th>Mobile<th>Email<th>Players<th>Type<th>Table<th>Sets<th>Total<th>Payment<th>Status<th>Requests<th>Email status</tr>${rows.map(r => `<tr><td>${r.id}<td>${r.date}<td>${rng(r.start)}<td>${esc(r.name)}<td>${r.phone}<td>${esc(r.email)}<td>${r.players}<td>${typeLbl(r.type)}<td>${r.tbl + 1}<td>${r.sets}<td>₹${r.total}<td>${r.pay_method} (${r.pay_status}) ${r.payment_id || ''}<td>${r.status}<td>${esc(r.requests)}<td>${r.email_status || ''}</tr>`).join('')}</table></div>`);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') { const page = fs.readFileSync(new URL('./index.html', import.meta.url)); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page); }
    res.writeHead(404); res.end('Not found');
  } catch (e) { console.error(e); if (res.headersSent) return res.end(); json(res, 500, { error: 'Something went wrong. Please try again.' }); }
}).listen(PORT, () => console.log('Mahjong Madness running on :' + PORT));
