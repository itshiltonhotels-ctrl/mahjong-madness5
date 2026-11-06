// Mahjong Madness booking backend. Zero dependencies. Needs Node 22+.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const E = process.env;
const PORT = E.PORT || 3000;
const CFG = { tables: 4, cap: 4, fee: 250, rent: 500, sets: +(E.RENTAL_SETS || 8), open: 720, close: 1080, dur: 120, step: 30 };
const STAFF_EMAIL = E.STAFF_EMAIL || 'murali.dg@shiltonhospitality.com';
const db = new DatabaseSync(E.DB_PATH || 'bookings.db');
db.exec(`CREATE TABLE IF NOT EXISTS bookings(
 id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, date TEXT, start INTEGER,
 players INTEGER, type TEXT, tbl INTEGER, sets INTEGER, game_fee INTEGER, rental_fee INTEGER, total INTEGER,
 games INTEGER DEFAULT 1, pay_method TEXT DEFAULT 'Pay at venue', pay_status TEXT DEFAULT 'Pending',
 status TEXT DEFAULT 'confirmed', requests TEXT, cancelled_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, email_status TEXT)`);

for (const c of ['hold_until INTEGER', 'order_id TEXT', 'payment_id TEXT']) { try { db.exec('ALTER TABLE bookings ADD COLUMN ' + c); } catch {} }
const HOLD = +(E.HOLD_MINUTES || 10), PAYU = () => !!(E.PAYU_KEY && E.PAYU_SALT);
const sha512 = t => crypto.createHash('sha512').update(t).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const formBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { req.destroy(); no(); } }); req.on('end', () => { try { ok((req.headers['content-type'] || '').includes('json') ? JSON.parse(d) : Object.fromEntries(new URLSearchParams(d))); } catch { ok({}); } }); });
const pad = n => String(n).padStart(2, '0');
const fmt = m => { const h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + (mm ? ':' + pad(mm) : '') + ' ' + (h < 12 ? 'AM' : 'PM'); };
const rng = s => fmt(s) + ' – ' + fmt(s + CFG.dur);
const istNow = () => { const p = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }); return { d: p.slice(0, 10), m: +p.slice(11, 13) * 60 + +p.slice(14, 16), t: Date.parse(p.replace(' ', 'T') + 'Z') }; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function overlapping(date, s, ignore) {
  return db.prepare(`SELECT * FROM bookings WHERE (status='confirmed' OR (status='held' AND hold_until>?)) AND date=? AND id<>? AND ABS(start-?)<?`).all(Date.now(), date, ignore || '', s, CFG.dur);
}
function allocate(date, s, type, n, sets, ignore) {
  const ex = overlapping(date, s, ignore);
  if (CFG.sets - ex.reduce((a, b) => a + b.sets, 0) < sets) return -1;
  for (let t = 0; t < CFG.tables; t++) {
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
  return `Booking ID: ${b.id}<br>Date: ${b.date}<br>Time: ${rng(b.start)}<br>Players: ${b.players}<br>Game: Three rounds<br>Booking Type: ${typeLbl(b.type)}<br>Game Fee: ₹${b.game_fee}<br>Mahjong Sets Rented: ${b.sets}<br>Set Rental: ₹${b.rental_fee}<br>Total Amount: ₹${b.total}<br>Payment: ${b.pay_method} (${b.pay_status})`;
}
async function notifyBooked(b) {
  const guest = await sendMail(b.email, 'Your Mahjong Madness booking is confirmed!',
    `<p>Hey ${esc(b.name)},</p><p>You're booked!<br>Your Mahjong Madness game at Watson's Vasanth Nagar is confirmed.</p><p>Here are your booking details:<br>${details(b)}</p><p>Venue:<br>${VENUE}</p><p>Get your crew together and get ready for some Mahjong madness!<br>See you at the table.</p><p>Exclusively curated by Watson's Cantina.</p>`);
  const staff = await sendMail(STAFF_EMAIL, `NEW BOOKING ${b.id}: ${b.date} ${rng(b.start)} (${b.players} players)`,
    `<p><b>New Mahjong Madness booking</b></p><p>${details(b)}</p><p>Guest: ${esc(b.name)}<br>Mobile: ${esc(b.phone)}<br>Email: ${esc(b.email)}<br>Assigned table: ${b.tbl + 1}<br>Special requests: ${esc(b.requests) || 'None'}</p>`);
  db.prepare('UPDATE bookings SET email_status=? WHERE id=?').run(`guest:${guest}; staff:${staff}`, b.id);
}
async function notifyCancelled(b) {
  await sendMail(b.email, 'Your Mahjong Madness booking has been cancelled.', `<p>Hey ${esc(b.name)},</p><p>Your Mahjong Madness booking has been cancelled.</p><p>Booking ID: ${b.id}<br>Date: ${b.date}<br>Time: ${rng(b.start)}</p><p>If your booking was paid online and is eligible for a refund, the applicable refund information will be shared through the configured payment process.</p><p>Hope to see you at the table another time!</p>`);
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
  db.prepare(`UPDATE bookings SET status='confirmed',pay_status='Paid',payment_id=?,hold_until=NULL WHERE id=?`).run(paymentId, b.id);
  const nb = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  notifyBooked(nb);
  return nb;
}
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
const body = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e4) { req.destroy(); no(); } }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { no(); } }); });
function authed(req) {
  const [u, p] = Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString().split(':');
  return E.ADMIN_PASS && u === (E.ADMIN_USER || 'admin') && p === E.ADMIN_PASS;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/occupancy') // anonymised: no guest data
      return json(res, 200, db.prepare(`SELECT id,date,start,players,type,tbl AS "table",sets,status FROM bookings WHERE (status='confirmed' OR (status='held' AND hold_until>${Date.now()})) AND date>=?`).all(istNow().d));

    if (url.pathname === '/api/config') return json(res, 200, { enabled: PAYU(), test: E.PAYU_ENV === 'test' });

    if (url.pathname === '/api/pay/start' && req.method === 'POST') { // retry payment for a held booking
      const x = await body(req);
      const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(email)=lower(?) AND status='held'`).get(x.id || '', x.email || '');
      if (!b || !PAYU()) return json(res, 404, { error: 'Booking not found.' });
      if (b.hold_until < Date.now()) return json(res, 410, { error: 'Your table hold has expired. Please make a new booking.' });
      return json(res, 200, { payu: payuStart(b, req) });
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
      if (!['seat', 'private'].includes(x.type)) errs.push('Invalid booking type.');
      if (!(n >= 1 && n <= 4)) errs.push('Players must be 1 to 4.');
      if (!(q >= 0 && q <= 4)) errs.push('Invalid number of sets.');
      if (String(x.name || '').trim().length < 2) errs.push('Name required.');
      if (!/^(91)?[6-9]\d{9}$/.test(String(x.phone || '').replace(/\D/g, ''))) errs.push('Valid mobile required.');
      if (!/^\S+@\S+\.\S+$/.test(x.email || '')) errs.push('Valid email required.');
      if (!x.agreed) errs.push('Terms must be accepted.');
      if (errs.length) return json(res, 400, { error: errs.join(' ') });
      const online = x.pay === 'online';
      if (online && !PAYU()) return json(res, 400, { error: 'Online payment is not available right now. Please choose pay at venue.' });
      let b;
      db.exec('BEGIN IMMEDIATE'); // atomic: no two guests can take the same capacity
      try {
        const t = allocate(x.date, x.start, x.type, n, q);
        if (t < 0) { db.exec('ROLLBACK'); return json(res, 409, { error: 'Sorry, that capacity was just taken. Please pick another slot.' }); }
        b = { id: refId(), name: String(x.name).trim(), phone: String(x.phone).replace(/\D/g, ''), email: x.email.trim(), date: x.date, start: x.start, players: n, type: x.type, tbl: t, sets: q, game_fee: n * CFG.fee, rental_fee: q * CFG.rent, total: n * CFG.fee + q * CFG.rent, pay_method: online ? 'Online' : 'Pay at venue', pay_status: online ? 'Awaiting payment' : 'Pending', requests: String(x.requests || '').slice(0, 500) };
        db.prepare(`INSERT INTO bookings(id,name,phone,email,date,start,players,type,tbl,sets,game_fee,rental_fee,total,pay_method,pay_status,requests,status,hold_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(b.id, b.name, b.phone, b.email, b.date, b.start, b.players, b.type, b.tbl, b.sets, b.game_fee, b.rental_fee, b.total, b.pay_method, b.pay_status, b.requests, online ? 'held' : 'confirmed', online ? Date.now() + HOLD * 60000 : null);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (online) return json(res, 201, { booking: b, payu: payuStart(b, req), holdMinutes: HOLD });
      notifyBooked(b); // async, booking is already saved
      return json(res, 201, { booking: b });
    }

    if (url.pathname === '/api/cancel' && req.method === 'POST') {
      const x = await body(req);
      const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(email)=lower(?) AND status='confirmed'`).get(x.id || '', x.email || '');
      if (!b) return json(res, 404, { error: 'Booking not found.' });
      if (b.pay_method === 'Online' && b.pay_status === 'Paid') return json(res, 403, { error: 'This booking was paid online. Please contact our booking team to cancel and arrange a refund: Alka Nagpal +91 99801 36969 or Vedashree +91 98452 71738.' });
      const bt = Date.parse(b.date + 'T' + pad(Math.floor(b.start / 60)) + ':' + pad(b.start % 60) + ':00Z');
      if (bt - istNow().t < 864e5) return json(res, 403, { error: 'Free cancellation closes 24 hours before your booking. Please contact our booking team: Alka Nagpal +91 99801 36969 or Vedashree +91 98452 71738.' });
      db.prepare(`UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id=?`).run(new Date().toISOString(), b.id);
      notifyCancelled(b);
      return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/admin')) {
      if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Mahjong Madness admin"' }); return res.end('Login required (set ADMIN_PASS).'); }
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
