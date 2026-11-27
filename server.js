// Mahjong Madness booking backend. Zero dependencies. Needs Node 22+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const E = process.env;
const PORT = E.PORT || 3000;
const CFG = { tables: 4, cap: 4, fee: 1000, rent: 500, sets: +(E.RENTAL_SETS || 8), open: 720, close: 1200, dur: 180, step: 30 }; // dur = length of a NEW booking in minutes (older bookings keep their own length)
const STAFF_EMAIL = [...new Set([...(E.STAFF_EMAIL || 'murali.dg@shiltonhospitality.com').split(','), ...(E.STAFF_EMAIL_2 || 'alkanagpal@hotmail.com').split(',')].map(x => x.trim()).filter(Boolean))]; // everyone who gets booking alerts
const LOCS = { 'vasanth-nagar': "Watson's Vasanth Nagar", 'ulsoor': "Watson's Ulsoor", 'indiranagar': "Watson's Indiranagar" };
const RETIRED = { 'starlight': 'STAR LIGHT Sahakar Nagar (closed)' }; // closed outlets: no new bookings, old bookings stay saved
const DEFAULT_LOC = 'vasanth-nagar', locName = l => LOCS[l] || RETIRED[l] || LOCS[DEFAULT_LOC];
const db = new DatabaseSync(E.DB_PATH || 'bookings.db');
db.exec(`CREATE TABLE IF NOT EXISTS bookings(
 id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, date TEXT, start INTEGER,
 players INTEGER, type TEXT, tbl INTEGER, sets INTEGER, game_fee INTEGER, rental_fee INTEGER, total INTEGER,
 games INTEGER DEFAULT 1, pay_method TEXT DEFAULT 'Pay at venue', pay_status TEXT DEFAULT 'Pending',
 status TEXT DEFAULT 'confirmed', requests TEXT, cancelled_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, email_status TEXT)`);

for (const c of ['hold_until INTEGER', 'order_id TEXT', 'payment_id TEXT', 'refund_status TEXT', 'refund_ref TEXT', 'refund_note TEXT', 'paid_at TEXT', 'is_test INTEGER DEFAULT 0', "loc TEXT DEFAULT 'vasanth-nagar'", 'cancel_reason TEXT', 'dur INTEGER DEFAULT 120']) { try { db.exec('ALTER TABLE bookings ADD COLUMN ' + c); } catch {} }
const HOLD = +(E.HOLD_MINUTES || 10), PAYU = () => !!(E.PAYU_KEY && E.PAYU_SALT), TESTPAY = () => false; // free test bookings are disabled for go-live: TEST_MODE in Render is ignored
const sha512 = t => crypto.createHash('sha512').update(t).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const formBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { req.destroy(); no(); } }); req.on('end', () => { try { ok((req.headers['content-type'] || '').includes('json') ? JSON.parse(d) : Object.fromEntries(new URLSearchParams(d))); } catch { ok({}); } }); });
db.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY AUTOINCREMENT, tbl INTEGER, date TEXT, start INTEGER, end INTEGER, reason TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, name TEXT, role TEXT, pass TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login TEXT)`);
try { db.exec("ALTER TABLE users ADD COLUMN outlets TEXT DEFAULT ''"); } catch {}
db.exec("UPDATE users SET outlets='vasanth-nagar' WHERE role='staff' AND (outlets IS NULL OR outlets='')"); // older outlet users keep working
db.exec(`CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, username TEXT, expires INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, username TEXT, action TEXT, detail TEXT, ip TEXT)`);
try { db.exec("ALTER TABLE blocks ADD COLUMN loc TEXT DEFAULT 'vasanth-nagar'"); } catch {}
const getSet = (k, d) => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? +r.v : d; };
const getStr = (k, d = '') => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? r.v : d; };
const setSet = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const skey = (k, l) => !l || l === DEFAULT_LOC ? k : k + ':' + l;
const tablesOf = l => { const n = Math.round(getSet(skey('tables', l), CFG.tables)); return n >= 1 && n <= 12 ? n : CFG.tables; };
const validEmail = x => /^\S+@\S+\.\S+$/.test(x);
const outletEmails = l => getStr(skey('alert_emails', l)).split(/[,;\s]+/).map(x => x.trim()).filter(validEmail);
// Booking alerts go to the outlet's own addresses (plus head office unless switched off). With none set, head office gets them.
const outletRecipients = l => { const own = outletEmails(l), head = getStr(skey('alert_head', l), '1') !== '0'; return [...new Set(own.length ? [...own, ...(head ? STAFF_EMAIL : [])] : STAFF_EMAIL)]; };
const setsAvail = l => Math.max(0, getSet(skey('sets_total', l), CFG.sets) - getSet(skey('sets_damaged', l), 0));
function blockOcc() { // table closures shown to the booking page as occupied tables
  const out = [];
  for (const k of db.prepare('SELECT * FROM blocks WHERE date>=?').all(istNow().d)) {
    for (let x = k.start; x <= Math.max(k.start, k.end - CFG.dur); x += CFG.step) out.push({ id: 'blk' + k.id, date: k.date, start: x, players: CFG.cap, type: 'private', table: k.tbl, sets: 0, status: 'confirmed', loc: k.loc || DEFAULT_LOC, dur: CFG.dur });
  }
  return out;
}
const pad = n => String(n).padStart(2, '0');
const fmt = m => { const h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + (mm ? ':' + pad(mm) : '') + ' ' + (h < 12 ? 'AM' : 'PM'); };
const rng = (s, d) => fmt(s) + ' – ' + fmt(s + (d || CFG.dur));
const istNow = () => { const p = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }); return { d: p.slice(0, 10), m: +p.slice(11, 13) * 60 + +p.slice(14, 16), t: Date.parse(p.replace(' ', 'T') + 'Z') }; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function overlapping(date, s, ignore, loc, dur) {
  return db.prepare(`SELECT * FROM bookings WHERE (status='confirmed' OR (status='held' AND hold_until>?)) AND date=? AND id<>? AND start<? AND start+COALESCE(dur,120)>? AND loc=?`).all(Date.now(), date, ignore || '', s + (dur || CFG.dur), s, loc || DEFAULT_LOC);
}
function allocate(date, s, type, n, sets, ignore, only, loc, dur) {
  const ex = overlapping(date, s, ignore, loc, dur);
  if (setsAvail(loc) - ex.reduce((a, b) => a + b.sets, 0) < sets) return -1;
  const bl = db.prepare('SELECT tbl FROM blocks WHERE date=? AND start<? AND end>? AND loc=?').all(date, s + (dur || CFG.dur), s, loc || DEFAULT_LOC).map(r => r.tbl);
  for (let t = 0; t < tablesOf(loc); t++) {
    if (bl.includes(t) || (only != null && t !== only)) continue;
    const on = ex.filter(b => b.tbl === t);
    if (type === 'private' ? !on.length : !on.some(b => b.type === 'private') && on.reduce((a, b) => a + b.players, 0) + n <= CFG.cap) return t;
  }
  return -1;
}
function refId() { return 'MM-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }

async function sendOne(to, subject, html, text, replyTo) {
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: E.FROM_EMAIL, to: [to], reply_to: replyTo || E.REPLY_TO || STAFF_EMAIL, subject, html, ...(text ? { text } : {}) }) });
    return r.ok ? 'sent' : 'failed:' + r.status + ' ' + (await r.text()).slice(0, 160);
  } catch (e) { return 'failed'; }
}
// One separate email per recipient, so one blocked address can never stop the others from being delivered.
async function sendMail(to, subject, html, text, replyTo) {
  if (!E.RESEND_API_KEY || !E.FROM_EMAIL) { console.log('[email NOT sent, RESEND_API_KEY/FROM_EMAIL missing]', to, subject); return 'not_configured'; }
  const list = [...new Set([].concat(to).filter(Boolean))], res = await Promise.all(list.map(x => sendOne(x, subject, html, text, replyTo)));
  const ok = res.filter(x => x === 'sent').length;
  if (ok === res.length) return 'sent';
  return (ok ? 'partial: ' : '') + res.map((x, i) => list[i] + '=' + x).join(' | ');
}
const typeLbl = t => t === 'private' ? 'Whole table' : 'Individual seats';
const VENUE_LINES = ["Watson's Vasanth Nagar", '1st Floor, Kodava Samaja Building', 'Vasanth Nagar, Bengaluru, Karnataka 560001'];
const MAPS = 'https://www.google.com/maps/search/?api=1&query=Kodava+Samaja+Vasanth+Nagar+Bengaluru+560001';
const inr2 = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const payText = b => b.is_test ? 'Paid online (TEST: no money taken)' : b.pay_status === 'Paid' ? 'Paid online' : b.pay_method === 'Online' ? 'Online payment: ' + b.pay_status : b.pay_method + ' (' + b.pay_status + ')';
const stripTags = v => String(v).replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
// Builds a clean, mobile-friendly HTML email (tables + inline styles work in Gmail/Outlook) and a plain-text copy.
function mailDoc({ title, badge, intro, sections = [], outro, button }) {
  const F = 'font-family:Arial,Helvetica,sans-serif;';
  const tbl = rows => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3ddca;border-radius:10px;border-collapse:separate;overflow:hidden;background:#ffffff">${rows.map(([l, v, bold], i) => `<tr><td style="padding:10px 14px;width:38%;${F}font-size:13px;font-weight:bold;color:#5b6270;${i ? 'border-top:1px solid #eee9da;' : ''}vertical-align:top">${l}</td><td style="padding:10px 14px;${F}font-size:15px;color:#22252D;${bold ? 'font-weight:bold;' : ''}${i ? 'border-top:1px solid #eee9da;' : ''}vertical-align:top">${v}</td></tr>`).join('')}</table>`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="margin:0;padding:0;background:#F7F3E9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F3E9"><tr><td align="center" style="padding:20px 10px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#F7F3E9">
<tr><td style="background:#101F46;padding:20px 24px;border-radius:12px 12px 0 0"><span style="${F}font-size:20px;font-weight:bold;letter-spacing:2px;color:#F5D442">MAHJONG MADNESS</span>${badge ? `<span style="${F}font-size:12px;font-weight:bold;color:#ffffff;background:#c0392b;padding:3px 9px;border-radius:99px;margin-left:10px">${badge}</span>` : ''}</td></tr>
<tr><td style="background:#ffffff;padding:26px 24px 8px;border-left:1px solid #e3ddca;border-right:1px solid #e3ddca"><h1 style="margin:0 0 12px;${F}font-size:24px;line-height:1.2;color:#101F46">${title}</h1>${intro ? `<p style="margin:0 0 16px;${F}font-size:15px;line-height:1.6;color:#22252D">${intro}</p>` : ''}</td></tr>
<tr><td style="background:#ffffff;padding:0 24px 22px;border-left:1px solid #e3ddca;border-right:1px solid #e3ddca">${sections.map(x => `${x.heading ? `<p style="margin:18px 0 8px;${F}font-size:12px;font-weight:bold;letter-spacing:1.5px;color:#101F46;text-transform:uppercase">${x.heading}</p>` : '<div style="height:4px"></div>'}${tbl(x.rows)}`).join('')}${button ? `<p style="margin:22px 0 0"><a href="${button[1]}" style="display:inline-block;background:#F5D442;color:#101F46;${F}font-size:15px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:8px">${button[0]}</a></p>` : ''}${outro ? `<p style="margin:22px 0 0;${F}font-size:15px;line-height:1.6;color:#22252D">${outro}</p>` : ''}</td></tr>
<tr><td style="background:#101F46;padding:16px 24px;border-radius:0 0 12px 12px;${F}font-size:12px;line-height:1.6;color:#dcdff0">Mahjong Madness<br>Exclusively curated by Watson's Cantina.</td></tr></table></td></tr></table></body></html>`;
  const text = [title, '', intro ? stripTags(intro) : '', ...sections.flatMap(x => [x.heading ? '\n' + x.heading.toUpperCase() : '', ...x.rows.map(([l, v]) => l + ': ' + stripTags(v))]), button ? '\n' + button[0] + ': ' + button[1] : '', outro ? '\n' + stripTags(outro) : '', '\nMahjong Madness. Exclusively curated by Watson\'s Cantina.'].filter(x => x !== '').join('\n');
  return { html, text };
}
const adminUrl = () => E.PUBLIC_URL ? ['Open the admin dashboard', E.PUBLIC_URL.replace(/\/$/, '') + '/admin'] : null;
const bookingRows = (b, staff) => [['Booking ID', b.id, true], ['Location', esc(locName(b.loc))], ['Date', fmtDate(b.date)], ['Time', rng(b.start, b.dur)], ...(staff ? [['Assigned table', 'Table ' + (b.tbl + 1)]] : []), ['People', b.players], ['Game', 'Three rounds'], ['Booking', 'One whole table'], ['Complimentary', 'One soft beverage'], ['Mahjong sets rented', b.sets]];
const moneyRows = b => [['Table fee', inr2(b.game_fee)], ['Set rental', inr2(b.rental_fee)], ['Total amount', inr2(b.total), true], ['Payment', payText(b)]];
async function notifyBooked(b) {
  const T = b.is_test ? '[TEST] ' : '', tag = b.is_test ? 'TEST' : '';
  const g = mailDoc({ title: "You're booked!", badge: tag, intro: `Hey ${esc(b.name)},<br>Your Mahjong Madness game at ${esc(locName(b.loc))} is confirmed.<br>Here are your booking details:`,
    sections: [{ rows: [...bookingRows(b), ...moneyRows(b)] }, { heading: 'Venue', rows: (b.loc || DEFAULT_LOC) === DEFAULT_LOC ? [['Address', VENUE_LINES.join('<br>')], ['Directions', `<a href="${MAPS}" style="color:#101F46">Open in Google Maps</a>`]] : [['Location', esc(locName(b.loc))]] }],
    outro: 'Get your crew together and get ready for some Mahjong madness!<br>See you at the table.' });
  const guest = !b.email ? 'no_email' : await sendMail(b.email, T + 'Your Mahjong Madness booking is confirmed!', g.html, g.text, outletEmails(b.loc)[0]);
  const st = mailDoc({ title: 'New Mahjong Madness booking', badge: tag, intro: b.is_test ? 'This is a TEST booking: no money was taken.' : '',
    sections: [{ heading: 'Booking', rows: bookingRows(b, true) }, { heading: 'Payment', rows: [...moneyRows(b), ...(b.payment_id ? [['Payment ID', esc(b.payment_id)]] : [])] },
      { heading: 'Guest', rows: [['Name', esc(b.name)], ['Mobile', `<a href="tel:+91${String(b.phone).slice(-10)}" style="color:#101F46">${esc(b.phone)}</a>`], ['Email', b.email ? `<a href="mailto:${esc(b.email)}" style="color:#101F46">${esc(b.email)}</a>` : 'Not given'], ['Special requests', esc(b.requests) || 'None']] }], button: adminUrl() });
  const staff = await sendMail(outletRecipients(b.loc), `${T}NEW BOOKING ${b.id} (${locName(b.loc)}): ${b.date} ${rng(b.start, b.dur)} (${b.players} people)`, st.html, st.text);
  db.prepare('UPDATE bookings SET email_status=? WHERE id=?').run(`guest:${guest}; staff:${staff}`, b.id);
}
async function notifyCancelled(b) {
  const T = b.is_test ? '[TEST] ' : '', tag = b.is_test ? 'TEST' : '', refund = b.pay_method === 'Online' && b.pay_status === 'Paid' && !b.is_test;
  if (b.email) { const g = mailDoc({ title: 'Your booking has been cancelled', badge: tag, intro: `Hey ${esc(b.name)},<br>Your Mahjong Madness booking has been cancelled.`, sections: [{ rows: [['Booking ID', b.id, true], ['Location', esc(locName(b.loc))], ['Date', fmtDate(b.date)], ['Time', rng(b.start, b.dur)]] }],
    outro: 'If your booking was paid online and is eligible for a refund, the applicable refund information will be shared through the configured payment process.<br><br>Hope to see you at the table another time!' });
    await sendMail(b.email, T + 'Your Mahjong Madness booking has been cancelled.', g.html, g.text, outletEmails(b.loc)[0]); }
  const st = mailDoc({ title: 'Booking cancelled', badge: tag, intro: refund ? '<b>A refund is due for this booking.</b> Open the admin dashboard to refund it.' : 'This booking was cancelled.',
    sections: [{ heading: 'Booking', rows: bookingRows(b, true) }, { heading: 'Payment', rows: moneyRows(b) }, { heading: 'Guest', rows: [['Name', esc(b.name)], ['Mobile', esc(b.phone)], ['Email', esc(b.email) || 'Not given']] }], button: adminUrl() });
  await sendMail(outletRecipients(b.loc), `${T}CANCELLED ${b.id} (${locName(b.loc)}): ${b.date} ${rng(b.start, b.dur)}`, st.html, st.text);
}
function alertMail(subject, title, intro, b, extraRows = []) {
  const m = mailDoc({ title, intro, sections: [{ rows: [['Booking ID', b.id, true], ['Date', fmtDate(b.date)], ['Time', rng(b.start, b.dur)], ['Guest', esc(b.name)], ['Mobile', esc(b.phone)], ['Total amount', inr2(b.total), true], ...extraRows] }], button: adminUrl() });
  return sendMail(outletRecipients(b.loc), subject, m.html, m.text);
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
  const reopen = unpaidCx(b); // the hold ran out and the booking was cancelled, but the guest's payment still arrived
  if (b.status !== 'held' && !reopen) return { ...b, problem: true };
  if (reopen || b.hold_until < Date.now()) { // only confirm if the table is still free
    const t = allocate(b.date, b.start, b.type, b.players, b.sets, b.id, undefined, b.loc, b.dur);
    if (t < 0) {
      db.prepare(`UPDATE bookings SET status='cancelled',pay_status='Paid',payment_id=?,paid_at=?,cancelled_at=?,cancel_reason='Paid after the hold expired and the table was taken',refund_status='Refund due' WHERE id=?`).run(paymentId, new Date().toISOString(), new Date().toISOString(), b.id);
      audit(null, 'system', 'paid_no_table', b.id + ' ₹' + b.total + ' ' + paymentId + ': refund due');
      alertMail('ACTION NEEDED: paid booking ' + b.id + ' has no free table', 'Action needed: paid booking, no free table', 'The guest paid after the table hold expired and the slot was taken. A refund is due: open the admin dashboard, find this booking and use the Refund button. Please also contact the guest.', b, [['Payment ID', esc(paymentId)]]);
      return { ...b, problem: true };
    }
    db.prepare('UPDATE bookings SET tbl=? WHERE id=?').run(t, b.id);
  }
  db.prepare(`UPDATE bookings SET status='confirmed',pay_status='Paid',payment_id=?,hold_until=NULL,paid_at=?,cancelled_at=NULL,cancel_reason=NULL WHERE id=?`).run(paymentId, new Date().toISOString(), b.id);
  audit(null, 'system', 'payment_confirmed', b.id + ' ₹' + b.total + ' ' + paymentId + (reopen ? ' (paid after hold expired, booking reopened)' : ''));
  const nb = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  notifyBooked(nb);
  return nb;
}
const ADMIN_ONLY = new Set(['users', 'audit', 'report', 'settings', 'refund', 'markrefunded', 'markpaid', 'user/create', 'user/update', 'user/password', 'delete-tests', 'system', 'payu-check', 'backup', 'backup-db', 'outlet/settings', 'outlet/test-email']);
async function adminApi(req, res, url, sess) {
  const p = url.pathname.slice('/admin/api/'.length), j = (c, o) => json(res, c, o), now = istNow();
  if (ADMIN_ONLY.has(p) && sess.role !== 'admin') return j(403, { error: 'Admin access required.' });
  const g = k => url.searchParams.get(k) || '';
  const okLoc = l => sess.outlets.includes(l), act = sess.outlets.filter(l => LOCS[l]), myLocs = Object.fromEntries(act.map(l => [l, LOCS[l]])), pickLoc = l => okLoc(l) && LOCS[l] ? l : act[0];
  if (p === 'system') {
    const out = [], add = (name, status, detail) => out.push({ name, status, detail }), dbp = path.resolve(E.DB_PATH || 'bookings.db'), onRender = !!E.RENDER;
    try { db.prepare("INSERT INTO settings(k,v) VALUES('write_test',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(Date.now())); add('Database saves data', getSet('write_test', 0) > 0 ? 'ok' : 'fail', 'Write and read test passed. File: ' + dbp); } catch (e) { add('Database saves data', 'fail', 'Write test failed: ' + e.message); }
    let sameDisk = null; try { sameDisk = fs.statSync(path.dirname(dbp)).dev === fs.statSync(process.cwd()).dev; } catch {}
    if (!onRender) add('Permanent storage', 'ok', 'Not running on Render. Make sure this machine keeps the file ' + dbp + '.');
    else if (sameDisk === false) add('Permanent storage', 'ok', 'The database is on a separate disk (' + dbp + '), so bookings survive restarts and redeploys.');
    else add('Permanent storage', 'fail', 'The database is inside the app folder (' + dbp + '). Render erases it on every restart and redeploy, so bookings WILL be lost. Add a Render Disk mounted at /data (paid plan) and set DB_PATH=/data/bookings.db.');
    const cnt = q => db.prepare(q).get().c, boots = getSet('boot_count', 0);
    let bf = []; try { bf = fs.readdirSync(BACKUP_DIR()).filter(x => /\.db$/.test(x)).sort(); } catch {}
    add('Automatic backups', bf.length ? 'ok' : 'warn', bf.length ? bf.length + ' backup file(s) in ' + BACKUP_DIR() + ', newest ' + bf[bf.length - 1] + ' (made ' + (getStr('last_backup', '') || 'recently') + '). A new copy is made every 6 hours and 30 days are kept.' : 'No backup file yet. One is made when the server starts and every 6 hours.');
    add('Database history', 'info', 'First created ' + (db.prepare("SELECT v FROM settings WHERE k='db_created'").get() || {}).v + '. Server started ' + boots + ' time(s) since then. If this creation date is always very recent after a redeploy, your data is being wiped.');
    const tests = cnt('SELECT COUNT(*) c FROM bookings WHERE is_test=1');
    add('Bookings saved', 'info', cnt("SELECT COUNT(*) c FROM bookings WHERE is_test=0 AND status='confirmed'") + ' real confirmed booking(s), ' + cnt("SELECT COUNT(*) c FROM bookings WHERE is_test=0 AND status='cancelled'") + ' cancelled, ' + cnt('SELECT COUNT(*) c FROM users') + ' staff user(s).');
    add('Test bookings removed', tests ? 'warn' : 'ok', tests ? tests + ' test booking(s) are still saved. Delete them from the Bookings tab (Delete test bookings) before launch.' : 'No test bookings in the database.');
    add('Free test mode', E.TEST_MODE ? 'warn' : 'ok', E.TEST_MODE ? 'TEST_MODE is still set in Render. It is ignored now, but please delete that row.' : 'Test mode is off: every booking needs a verified payment.');
    add('PayU key and salt', E.PAYU_KEY && E.PAYU_SALT ? 'ok' : 'fail', E.PAYU_KEY && E.PAYU_SALT ? 'Key starts with ' + E.PAYU_KEY.slice(0, 3) + '…, salt is set.' : 'PAYU_KEY or PAYU_SALT is missing in Render, so guests cannot book.');
    add('PayU mode', E.PAYU_ENV === 'test' ? 'fail' : 'ok', E.PAYU_ENV === 'test' ? 'PAYU_ENV is "test": payments go to PayU\'s test system and no real money is collected. Set it to live.' : 'Live payments (PAYU_ENV is ' + (E.PAYU_ENV || 'not set, so live') + ').');
    const base = (E.PUBLIC_URL || '').replace(/\/$/, '');
    add('Website address', /^https:\/\//.test(base) && !/onrender\.com/.test(base) ? 'ok' : 'warn', base ? 'PUBLIC_URL is ' + base + (/onrender\.com/.test(base) ? ' (a Render address: set your own domain when ready)' : '') : 'PUBLIC_URL is not set. Set it to https://mahjongmadness.co.in so PayU returns guests to the right place.');
    add('PayU webhook address', 'info', 'Register this in the PayU dashboard: ' + (base || 'https://YOUR-DOMAIN') + '/api/payu/webhook');
    add('Email sending', E.RESEND_API_KEY && E.FROM_EMAIL ? (/onboarding@resend\.dev/.test(E.FROM_EMAIL) ? 'fail' : 'ok') : 'fail', E.RESEND_API_KEY && E.FROM_EMAIL ? 'From: ' + E.FROM_EMAIL + (/onboarding@resend\.dev/.test(E.FROM_EMAIL) ? " (Resend's testing sender: only your own address receives emails. Use your verified domain.)" : '') : 'RESEND_API_KEY or FROM_EMAIL is missing: no confirmation emails will be sent.');
    add('Booking alert recipients', 'info', STAFF_EMAIL.join(', ') + (E.REPLY_TO ? '. Guest replies go to ' + E.REPLY_TO : ''));
    const recent = db.prepare("SELECT email_status FROM bookings WHERE is_test=0 AND email_status IS NOT NULL ORDER BY created_at DESC LIMIT 20").all(), bad = recent.filter(r => /failed|not_configured/.test(r.email_status)).length;
    add('Recent email delivery', bad ? 'warn' : 'ok', recent.length ? (bad ? bad + ' of the last ' + recent.length + ' bookings had an email that Resend did not accept. Open those bookings and read Email status.' : 'All of the last ' + recent.length + ' bookings had their emails accepted by Resend.') : 'No bookings yet.');
    const aw = cnt("SELECT COUNT(*) c FROM bookings WHERE status='held' AND is_test=0"), nu = cnt("SELECT COUNT(*) c FROM bookings WHERE cancel_reason LIKE 'Payment not received%' AND is_test=0 AND cancelled_at>?".replace('?', "'" + new Date(Date.now() - 7 * 864e5).toISOString() + "'"));
    add('Unpaid bookings', 'info', aw + ' booking(s) are waiting for payment right now and ' + nu + ' were cancelled automatically in the last 7 days because payment did not arrive. A booking that is not paid within ' + HOLD + ' minutes is cancelled and its table is released.');
    add('Admin password', (E.ADMIN_PASS || '').length >= 10 ? 'ok' : 'warn', (E.ADMIN_PASS || '').length >= 10 ? 'ADMIN_PASS is long enough.' : 'ADMIN_PASS is short. Use at least 10 characters.');
    return j(200, { checks: out, onRender });
  }
  if (p === 'backup-db') { // a fresh copy of the database file itself
    const f = backupNow(); if (!f) return j(500, { error: 'Could not create the backup file.' });
    audit(req, sess.user, 'backup_db_downloaded', path.basename(f));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=' + path.basename(f) }); return fs.createReadStream(f).pipe(res);
  }
  if (p === 'backup') {
    const dump = { exported_at: new Date().toISOString(), bookings: db.prepare('SELECT * FROM bookings ORDER BY created_at').all(), blocks: db.prepare('SELECT * FROM blocks').all(), settings: db.prepare("SELECT * FROM settings WHERE k<>'write_test'").all(), users: db.prepare('SELECT id,username,name,role,outlets,active,created_at,last_login FROM users').all(), audit: db.prepare('SELECT * FROM audit ORDER BY id').all() };
    audit(req, sess.user, 'backup_downloaded', dump.bookings.length + ' bookings');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename=mahjong-backup-' + now.d + '.json' }); return res.end(JSON.stringify(dump, null, 1));
  }
  if (p === 'me') return j(200, { user: sess.user, role: sess.role, owner: sess.user === OWNER(), test_mode: TESTPAY(), locs: myLocs, retired: sess.role === 'admin' ? RETIRED : {}, outlets: sess.outlets });
  if (!act.length && p !== 'me/password' && p !== 'export-log') return j(403, { error: 'No outlet is assigned to your account. Please ask an admin.' });
  if (p === 'users') return j(200, { owner: OWNER(), users: db.prepare('SELECT id,username,name,role,outlets,active,created_at,last_login FROM users ORDER BY username').all() });
  if (p === 'audit') {
    const from = g('from'), to = g('to'), usr = g('user'), act = g('action'), q = g('q').toLowerCase();
    const all = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 5000').all();
    const rows = all.filter(a => { const d = toIstDate(a.at); return (!from || d >= from) && (!to || d <= to) && (!usr || a.username === usr) && (!act || a.action === act) && (!q || (a.detail + ' ' + a.action).toLowerCase().includes(q)); });
    return j(200, { rows: rows.slice(0, 1000), users: [...new Set(all.map(a => a.username))].sort(), actions: [...new Set(all.map(a => a.action))].sort() });
  }
  if (p === 'guests') {
    const q = g('q').toLowerCase().trim(), m = new Map();
    for (const b of db.prepare(`SELECT * FROM bookings WHERE status IN ('confirmed','cancelled') ORDER BY date,start`).all().filter(b => okLoc(b.loc))) {
      const k = String(b.phone).slice(-10); let a = m.get(k);
      if (!a) m.set(k, a = { phone: k, name: b.name, email: '', bookings: 0, cancelled: 0, paid: 0, refunded: 0, first: b.date, last: b.date, last_id: b.id });
      a.name = b.name; if (b.email) a.email = b.email; a.last = b.date; a.last_id = b.id;
      if (b.status === 'confirmed') { a.bookings++; if (b.pay_status === 'Paid') a.paid += b.total; } else { a.cancelled++; if (b.refund_status === 'Refunded') a.refunded += b.total; }
    }
    let list = [...m.values()].filter(a => !q || [a.name, a.phone, a.email].join(' ').toLowerCase().includes(q)).sort((a, b) => b.last.localeCompare(a.last));
    return j(200, { guests: list.slice(0, 500), count: list.length });
  }
  if (p === 'report') {
    expireHolds();
    const lc = g('loc'), from = g('from'), to = g('to'), grp = ['month', 'outlet'].includes(g('group')) ? g('group') : 'day', basis = g('basis') === 'paid' ? 'paid' : 'play';
    const dateOf = b => basis === 'paid' ? toIstDate(b.paid_at || b.created_at) : b.date;
    const sel = db.prepare(`SELECT * FROM bookings WHERE status IN ('confirmed','cancelled','held')`).all().filter(b => { const d = dateOf(b); return !b.is_test && okLoc(b.loc) && (!lc || b.loc === lc) && (!from || d >= from) && (!to || d <= to); });
    const blank = k => ({ period: k, bookings: 0, people: 0, table_fees: 0, rental_fees: 0, gross: 0, collected: 0, refunded: 0, refund_pending: 0, awaiting: 0, awaiting_amt: 0, unpaid_cancelled: 0, unpaid_amt: 0, cancelled: 0, net: 0 });
    const add = (a, b) => {
      if (b.status === 'held') { a.awaiting++; a.awaiting_amt += b.total; return; }
      if (unpaidCx(b)) { a.unpaid_cancelled++; a.unpaid_amt += b.total; return; }
      if (b.status === 'confirmed') { a.bookings++; a.people += b.players; a.table_fees += b.game_fee; a.rental_fees += b.rental_fee; a.gross += b.total; } else a.cancelled++;
      if (b.pay_status === 'Paid') a.collected += b.total;
      if (b.refund_status === 'Refunded') a.refunded += b.total; else if (String(b.refund_status || '').startsWith('Refund')) a.refund_pending += b.total;
    };
    const groups = new Map(), byOut = new Map(act.filter(l => !lc || l === lc).map(l => [l, blank(locName(l))]));
    for (const b of sel) {
      const d = dateOf(b), k = grp === 'month' ? d.slice(0, 7) : grp === 'outlet' ? locName(b.loc) : d; let a = groups.get(k); if (!a) groups.set(k, a = blank(k));
      if (!byOut.has(b.loc)) byOut.set(b.loc, blank(locName(b.loc)));
      add(a, b); add(byOut.get(b.loc), b);
    }
    const fin = a => { a.net = a.collected - a.refunded - a.refund_pending; return a; };
    const list = [...groups.values()].map(fin).sort((a, b) => a.period.localeCompare(b.period)), outlets = [...byOut.values()].map(fin);
    const tot = blank('Total'); list.forEach(a => { for (const k of Object.keys(tot)) if (k !== 'period') tot[k] += a[k]; });
    const pay = { paid: { count: 0, amount: 0 }, refunded: { count: 0, amount: 0 }, refund_pending: { count: 0, amount: 0 }, awaiting: { count: 0, amount: 0 }, not_paid: { count: 0, amount: 0 } };
    const bump = (k, b) => { pay[k].count++; pay[k].amount += b.total; };
    for (const b of sel) { if (b.status === 'held') bump('awaiting', b); else if (unpaidCx(b)) bump('not_paid', b); else if (b.pay_status === 'Paid') { if (b.refund_status === 'Refunded') bump('refunded', b); else if (String(b.refund_status || '').startsWith('Refund')) bump('refund_pending', b); else if (b.status === 'confirmed') bump('paid', b); } }
    const payments = sel.filter(b => b.pay_status === 'Paid' || b.refund_status || b.status === 'held' || unpaidCx(b)).map(b => ({ location: locName(b.loc), date: dateOf(b), play_date: b.date, id: b.id, name: b.name, phone: b.phone, method: b.pay_method, payment_id: b.payment_id || '', txnid: b.order_id || '', amount: b.total, pay_status: b.pay_status, status: b.status, refund_status: b.refund_status || '', state: pstate(b), cancel_reason: b.cancel_reason || '', paid_at: b.paid_at || b.created_at || '' })).sort((a, b) => b.date.localeCompare(a.date));
    return j(200, { groups: list, totals: tot, outlets, by_payment: pay, payments });
  }
  if (p === 'day') {
    expireHolds();
    const d = url.searchParams.get('date') || now.d;
    const loc = pickLoc(g('loc'));
    const b = db.prepare(`SELECT * FROM bookings WHERE date=? AND loc=? AND (status='confirmed' OR (status='held' AND hold_until>?)) ORDER BY start`).all(d, loc, Date.now());
    return j(200, { date: d, loc, tables: tablesOf(loc), bookings: b, blocks: db.prepare('SELECT * FROM blocks WHERE date=? AND loc=? ORDER BY start').all(d, loc), sets: { total: getSet(skey('sets_total', loc), CFG.sets), damaged: getSet(skey('sets_damaged', loc), 0), booked: b.reduce((a, x) => a + x.sets, 0) } });
  }
  if (p === 'bookings') {
    const g = k => url.searchParams.get(k) || '', q = g('q').toLowerCase().trim(), qd = q.replace(/\D/g, ''), pm = g('pm'), ps = g('ps'), st = g('st') || 'active', from = g('from'), to = g('to');
    expireHolds();
    let r = db.prepare('SELECT * FROM bookings ORDER BY date DESC,start DESC').all();
    r = r.filter(b => {
      if (st === 'any' ? false : st === 'active' ? !['confirmed', 'held'].includes(b.status) : st === 'all' ? b.status === 'failed' : st === 'awaiting' ? b.status !== 'held' : st === 'unpaid' ? !unpaidCx(b) : b.status !== st) return false;
      if (!okLoc(b.loc) || (g('loc') && b.loc !== g('loc'))) return false;
      if (pm === 'online' && b.pay_method !== 'Online') return false;
      if (pm === 'venue' && b.pay_method === 'Online') return false;
      if (ps === 'paid' && b.pay_status !== 'Paid') return false;
      if (ps === 'pending' && b.pay_status === 'Paid') return false;
      if (ps === 'refund' && !String(b.refund_status || '').startsWith('Refund')) return false;
      if (ps === 'awaiting' && b.status !== 'held') return false;
      if (ps === 'notpaid' && !unpaidCx(b)) return false;
      if ((from && b.date < from) || (to && b.date > to)) return false;
      if (q && !([b.name, b.id, b.email].join(' ').toLowerCase().includes(q) || (qd.length >= 3 && String(b.phone).includes(qd)))) return false;
      return true;
    });
    const ok = r.filter(b => b.status === 'confirmed'), sum = (a, f) => a.reduce((t, b) => t + (+f(b) || 0), 0);
    return j(200, { bookings: r.slice(0, 500).map(b => ({ ...b, pstate: pstate(b) })), totals: { count: r.length, players: sum(ok, b => b.players), game: sum(ok, b => b.game_fee), rental: sum(ok, b => b.rental_fee), total: sum(ok, b => b.total), paid: sum(ok.filter(b => b.pay_status === 'Paid'), b => b.total), pending: sum(ok.filter(b => b.pay_status !== 'Paid'), b => b.total), online: sum(ok.filter(b => b.pay_method === 'Online'), b => b.total), cancelled: r.filter(b => b.status === 'cancelled').length, refunds: r.filter(b => b.refund_status === 'Refund due' || b.refund_status === 'Refund failed').length } });
  }
  if (p === 'booking') { const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(url.searchParams.get('id') || ''); return b && okLoc(b.loc) ? j(200, { booking: { ...b, pstate: pstate(b) } }) : j(404, { error: 'Not found' }); }
  if (p === 'outlet/settings' && req.method === 'GET') { const l = LOCS[g('loc')] ? g('loc') : DEFAULT_LOC; return j(200, { loc: l, name: locName(l), tables: tablesOf(l), emails: outletEmails(l), head: getStr(skey('alert_head', l), '1') !== '0', head_emails: STAFF_EMAIL }); }
  if (p === 'blocks') return j(200, { blocks: db.prepare('SELECT * FROM blocks WHERE date>=? AND loc=? ORDER BY date,start').all(now.d, pickLoc(g('loc'))) });
  if (req.method !== 'POST') return j(404, { error: 'Not found' });
  const x = await body(req), live = id => { const b = db.prepare(`SELECT * FROM bookings WHERE id=? AND status IN ('confirmed','held')`).get(id || ''); return b && okLoc(b.loc) ? b : undefined; };
  if (p === 'cancel') {
    const b = live(x.id); if (!b) return j(404, { error: 'Booking not found.' });
    const refund = cancelRow(b, 'Cancelled by staff (' + sess.user + ')');
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
    if (!(t >= 0 && t < tablesOf(b.loc))) return j(400, { error: 'Invalid table.' });
    db.exec('BEGIN IMMEDIATE');
    if (allocate(b.date, b.start, b.type, b.players, b.sets, b.id, t, b.loc, b.dur) < 0) { db.exec('ROLLBACK'); return j(409, { error: 'That table is not free (or is blocked) at that time.' }); }
    db.prepare('UPDATE bookings SET tbl=? WHERE id=?').run(t, b.id); db.exec('COMMIT'); audit(req, sess.user, 'move_booking', b.id + ' to table ' + (t + 1));
    return j(200, { ok: true });
  }
  if (p === 'block') {
    const t = +x.tbl, st = +x.start, en = +x.end, loc = x.loc;
    if (!okLoc(loc)) return j(403, { error: 'You do not have access to that outlet.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date || '') || !(t >= -1 && t < tablesOf(loc)) || !(st >= CFG.open && en <= CFG.close && en > st)) return j(400, { error: 'Invalid date, table or time.' });
    let conflicts = 0;
    for (const tt of t === -1 ? Array.from({ length: tablesOf(loc) }, (_, i) => i) : [t]) {
      db.prepare('INSERT INTO blocks(tbl,date,start,end,reason,loc) VALUES(?,?,?,?,?,?)').run(tt, x.date, st, en, String(x.reason || '').slice(0, 100), loc);
      conflicts += db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='confirmed' AND date=? AND tbl=? AND loc=? AND start<? AND start+COALESCE(dur,120)>?`).get(x.date, tt, loc, en, st).c;
    }
    audit(req, sess.user, 'block_table', locName(loc) + ' ' + (t === -1 ? 'all tables' : 'table ' + (t + 1)) + ' ' + x.date + ' ' + st + '-' + en + ' ' + String(x.reason || ''));
    return j(200, { ok: true, conflicts });
  }
  if (p === 'book') { // staff-created (phone / walk-in) booking
    const loc = okLoc(x.loc) && LOCS[x.loc] ? x.loc : act[0], n = +x.players, q = +x.sets || 0, st = +x.start, only = (x.tbl === '' || x.tbl == null || +x.tbl < 0) ? undefined : +x.tbl;
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
    const t = allocate(x.date, st, x.type, n, q, undefined, only, loc);
    if (t < 0) { db.exec('ROLLBACK'); return j(409, { error: 'No table (or not enough rental sets) free for that time.' }); }
    const b = { id: refId(), loc, name: String(x.name).trim(), phone: String(x.phone).replace(/\D/g, ''), email: String(x.email || '').trim(), date: x.date, start: st, players: n, type: x.type, tbl: t, sets: q, game_fee: CFG.fee, rental_fee: q * CFG.rent, total: CFG.fee + q * CFG.rent, pay_method: 'Pay at venue', pay_status: x.paid ? 'Paid' : 'Pending', requests: String(x.requests || '').slice(0, 500) };
    db.prepare(`INSERT INTO bookings(id,name,phone,email,date,start,players,type,tbl,sets,game_fee,rental_fee,total,pay_method,pay_status,requests,status,hold_until,loc,dur) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',NULL,?,?)`).run(b.id, b.name, b.phone, b.email, b.date, b.start, b.players, b.type, b.tbl, b.sets, b.game_fee, b.rental_fee, b.total, b.pay_method, b.pay_status, b.requests, b.loc, CFG.dur);
    db.exec('COMMIT');
    notifyBooked(b);
    return j(201, { ok: true, booking: b });
  }
  if (p === 'delete-tests') { const n = db.prepare('DELETE FROM bookings WHERE is_test=1').run().changes; audit(req, sess.user, 'delete_test_bookings', n + ' removed'); return j(200, { ok: true, deleted: n }); }
  if (p === 'payu-check') {
    if (!PAYU()) return j(400, { error: 'PAYU_KEY or PAYU_SALT is missing in Render.' });
    try { const v = await verifyPayu('MMCHECK' + Date.now().toString(36)); return j(200, { raw: JSON.stringify(v).slice(0, 500) }); } catch (e) { return j(200, { raw: 'Could not reach PayU: ' + e.message }); }
  }
  if (p === 'outlet/settings') {
    const l = LOCS[x.loc] ? x.loc : null, tb = Math.round(+x.tables); if (!l) return j(400, { error: 'Choose an outlet.' });
    if (!(tb >= 1 && tb <= 12)) return j(400, { error: 'Tables must be between 1 and 12.' });
    const used = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE loc=? AND status IN ('confirmed','held') AND date>=? AND tbl>=?`).get(l, now.d, tb).c;
    if (used) return j(409, { error: used + ' upcoming booking(s) are on tables above ' + tb + '. Move or cancel them first.' });
    const list = String(x.emails || '').split(/[,;\s]+/).map(e => e.trim()).filter(Boolean), bad = list.find(e => !validEmail(e));
    if (bad) return j(400, { error: 'That is not a valid email address: ' + bad });
    setSet(skey('tables', l), tb); setSet(skey('alert_emails', l), list.join(',')); setSet(skey('alert_head', l), x.head === false || x.head === '0' ? '0' : '1');
    audit(req, sess.user, 'outlet_settings', locName(l) + ': ' + tb + ' tables, alert emails: ' + (list.join(', ') || 'none (head office only)') + ', head office copy: ' + (x.head === false || x.head === '0' ? 'no' : 'yes'));
    return j(200, { ok: true, recipients: outletRecipients(l) });
  }
  if (p === 'outlet/test-email') {
    const l = LOCS[x.loc] ? x.loc : DEFAULT_LOC; if (!E.RESEND_API_KEY || !E.FROM_EMAIL) return j(400, { error: 'RESEND_API_KEY or FROM_EMAIL is missing in Render.' });
    const rc = outletRecipients(l), m = mailDoc({ title: 'Test alert: ' + locName(l), intro: 'This is a test of the booking alert emails for this outlet. If you can read this, new-booking and cancellation alerts for this outlet will reach you.', sections: [{ rows: [['Outlet', esc(locName(l))], ['Recipients', esc(rc.join(', '))]] }] });
    const results = await Promise.all(rc.map(async to => ({ to, status: await sendOne(to, 'Test alert: ' + locName(l), m.html, m.text, outletEmails(l)[0]) })));
    audit(req, sess.user, 'outlet_test_email', locName(l) + ' -> ' + rc.join(', ')); return j(200, { results });
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
    const outs = x.role === 'admin' ? [] : [].concat(x.outlets || []).filter(l => LOCS[l]);
    if (x.role === 'staff' && !outs.length) return j(400, { error: 'Choose at least one outlet for an outlet user.' });
    db.prepare('INSERT INTO users(username,name,role,pass,outlets) VALUES(?,?,?,?,?)').run(un, String(x.name || '').trim().slice(0, 60), x.role, hashPw(String(x.password)), outs.join(','));
    audit(req, sess.user, 'user_created', un + ' (' + (x.role === 'admin' ? 'admin, all outlets' : 'outlet user: ' + outs.map(locName).join(', ')) + ')'); return j(200, { ok: true });
  }
  if (p === 'user/update') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(+x.id); if (!u) return j(404, { error: 'User not found.' });
    if (u.username === sess.user && (x.active === 0 || x.active === false)) return j(400, { error: 'You cannot disable your own account.' });
    const role = ['admin', 'staff'].includes(x.role) ? x.role : u.role, active = x.active === undefined ? u.active : (x.active ? 1 : 0);
    let outs = role === 'admin' ? [] : (x.outlets === undefined ? String(u.outlets || '').split(',').filter(l => LOCS[l]) : [].concat(x.outlets || []).filter(l => LOCS[l]));
    if (role === 'staff' && !outs.length) return j(400, { error: 'Choose at least one outlet for an outlet user.' });
    const nm = x.name === undefined ? u.name : String(x.name).trim().slice(0, 60);
    db.prepare('UPDATE users SET role=?,active=?,outlets=?,name=? WHERE id=?').run(role, active, outs.join(','), nm, u.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE username=?').run(u.username);
    audit(req, sess.user, 'user_updated', u.username + ' role=' + role + ' active=' + active + ' outlets=' + (role === 'admin' ? 'all' : outs.map(locName).join(', '))); return j(200, { ok: true });
  }
  if (p === 'user/password') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(+x.id); if (!u) return j(404, { error: 'User not found.' });
    if (String(x.password || '').length < 8) return j(400, { error: 'Password must be at least 8 characters.' });
    db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPw(String(x.password)), u.id); db.prepare('DELETE FROM sessions WHERE username=?').run(u.username);
    audit(req, sess.user, 'password_reset', u.username); return j(200, { ok: true });
  }
  if (p === 'unblock') { const bl = db.prepare('SELECT loc FROM blocks WHERE id=?').get(+x.id); if (!bl || !okLoc(bl.loc)) return j(404, { error: 'Block not found.' }); db.prepare('DELETE FROM blocks WHERE id=?').run(+x.id); audit(req, sess.user, 'unblock_table', 'block #' + x.id); return j(200, { ok: true }); }
  if (p === 'settings') {
    const up = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
    const tot = Math.max(0, Math.min(200, +x.sets_total | 0)), dmg = Math.max(0, Math.min(tot, +x.sets_damaged | 0));
    const sl = LOCS[x.loc] ? x.loc : DEFAULT_LOC; up(skey('sets_total', sl), tot); up(skey('sets_damaged', sl), dmg); audit(req, sess.user, 'rental_sets', locName(sl) + ': total ' + tot + ', damaged ' + dmg);
    return j(200, { ok: true, available: tot - dmg });
  }
  return j(404, { error: 'Not found' });
}
// ---------- staff accounts, sessions, activity log ----------
db.prepare("INSERT OR IGNORE INTO settings(k,v) VALUES('db_created',?)").run(new Date().toISOString());
db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('boot_count', String(getSet('boot_count', 0) + 1));
db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('last_start', new Date().toISOString());
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
  if (s.username === OWNER()) return { user: s.username, role: 'admin', outlets: [...Object.keys(LOCS), ...Object.keys(RETIRED)] };
  const u = db.prepare('SELECT active,role,outlets FROM users WHERE username=?').get(s.username);
  if (!u || !u.active) return null;
  return { user: s.username, role: u.role, outlets: u.role === 'admin' ? [...Object.keys(LOCS), ...Object.keys(RETIRED)] : String(u.outlets || '').split(',').filter(l => LOCS[l]) };
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
const unpaidCx = b => b.status === 'cancelled' && /^Payment not received/.test(b.cancel_reason || '');
const pstate = b => b.status === 'held' ? 'Awaiting payment' : unpaidCx(b) ? 'Cancelled: payment not received' : b.refund_status === 'Refunded' ? 'Refunded' : String(b.refund_status || '').startsWith('Refund') ? 'Refund pending' : b.status === 'cancelled' ? 'Cancelled' : b.pay_status === 'Paid' ? 'Paid' : b.pay_status;
// A booking waiting for payment is cancelled automatically when its hold runs out, and its table is released.
function expireHolds() {
  const rows = db.prepare(`SELECT id,total,loc FROM bookings WHERE status='held' AND hold_until<?`).all(Date.now());
  for (const r of rows) {
    db.prepare(`UPDATE bookings SET status='cancelled',pay_status='Not paid',cancelled_at=?,cancel_reason=? WHERE id=? AND status='held'`).run(new Date().toISOString(), 'Payment not received within ' + HOLD + ' minutes', r.id);
    audit(null, 'system', 'payment_not_received', r.id + ' (' + locName(r.loc) + ') ₹' + r.total + ' cancelled: not paid in time, table released');
  }
  return rows.length;
}
function cancelRow(b, reason) {
  const refund = b.pay_method === 'Online' && b.pay_status === 'Paid' && !b.is_test;
  db.prepare(`UPDATE bookings SET status='cancelled',cancelled_at=?,refund_status=?,cancel_reason=?,pay_status=? WHERE id=?`).run(new Date().toISOString(), refund ? 'Refund due' : null, reason || 'Cancelled', b.status === 'held' ? 'Not paid' : b.pay_status, b.id);
  if (refund) alertMail('REFUND DUE: ' + b.id, 'Refund due', 'This booking was cancelled and had been paid online. Open the admin dashboard and use the Refund button.', b, [['Payment ID', esc(b.payment_id || '')]]);
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

// Copy of the whole database every 6 hours, kept 30 days next to the live file (on the permanent disk).
const BACKUP_DIR = () => path.join(path.dirname(path.resolve(E.DB_PATH || 'bookings.db')), 'backups');
function backupNow() {
  try {
    fs.mkdirSync(BACKUP_DIR(), { recursive: true });
    const f = path.join(BACKUP_DIR(), 'mahjong-' + new Date().toISOString().slice(0, 10) + '.db');
    if (fs.existsSync(f)) fs.unlinkSync(f);
    db.exec("VACUUM INTO '" + f.replace(/'/g, "''") + "'");
    fs.readdirSync(BACKUP_DIR()).filter(x => /^mahjong-\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().reverse().slice(30).forEach(x => fs.unlinkSync(path.join(BACKUP_DIR(), x)));
    setSet('last_backup', new Date().toISOString()); return f;
  } catch (e) { console.error('backup failed:', e.message); return null; }
}
backupNow(); setInterval(backupNow, 6 * 36e5).unref();
expireHolds(); setInterval(expireHolds, 60000).unref();
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/occupancy') // anonymised: no guest data
      return json(res, 200, [...blockOcc(), ...db.prepare(`SELECT id,date,start,players,type,tbl AS "table",sets,status,loc,COALESCE(dur,120) AS dur FROM bookings WHERE (status='confirmed' OR (status='held' AND hold_until>${Date.now()})) AND date>=?`).all(istNow().d)]);

    if (url.pathname === '/api/config') return json(res, 200, { enabled: PAYU() || TESTPAY(), test: E.PAYU_ENV === 'test', free: TESTPAY(), sets: setsAvail(), setsByLoc: Object.fromEntries(Object.keys(LOCS).map(l => [l, setsAvail(l)])), tablesByLoc: Object.fromEntries(Object.keys(LOCS).map(l => [l, tablesOf(l)])), locs: LOCS });

    if (url.pathname === '/api/pay/start' && req.method === 'POST') { // retry payment for a held booking
      const x = await body(req);
      expireHolds();
      const any = db.prepare(`SELECT * FROM bookings WHERE id=? AND lower(email)=lower(?)`).get(x.id || '', x.email || '');
      if (any && unpaidCx(any)) return json(res, 410, { error: 'Your table hold has expired and the unpaid booking was cancelled. Please make a new booking.' });
      const b = any && any.status === 'held' ? any : null;
      if (!b || !PAYU()) return json(res, 404, { error: 'Booking not found.' });
      if (b.hold_until < Date.now()) return json(res, 410, { error: 'Your table hold has expired. Please make a new booking.' });
      return json(res, 200, { payu: payuStart(b, req) });
    }

    if (url.pathname === '/api/booking/lookup' && req.method === 'POST') { // guest finds own booking: reference + email must both match
      if (limited(req)) return json(res, 429, TOO_MANY);
      const x = await body(req);
      const b = db.prepare(`SELECT id,name,date,start,players,type,sets,game_fee,rental_fee,total,pay_method,pay_status,status,refund_status,cancel_reason,loc,COALESCE(dur,120) AS dur FROM bookings WHERE upper(id)=upper(?) AND lower(email)=lower(?) AND status IN ('confirmed','cancelled','held')`).get(String(x.id || '').trim(), String(x.email || '').trim());
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
      if (!LOCS[x.loc]) errs.push('Please select a location.');
      if (!(n >= 1 && n <= 4)) errs.push('Players must be 1 to 4.');
      if (!(q >= 0 && q <= 4)) errs.push('Invalid number of sets.');
      if (String(x.name || '').trim().length < 2) errs.push('Name required.');
      if (!/^(91)?[6-9]\d{9}$/.test(String(x.phone || '').replace(/\D/g, ''))) errs.push('Valid mobile required.');
      if (!/^\S+@\S+\.\S+$/.test(x.email || '')) errs.push('Valid email required.');
      if (!x.agreed) errs.push('Terms must be accepted.');
      if (errs.length) return json(res, 400, { error: errs.join(' ') });
      const online = true; // all bookings are paid online
      if (online && !PAYU() && !TESTPAY()) return json(res, 400, { error: 'Online booking is temporarily unavailable. Please contact our booking team: Alka Nagpal +91 99801 36969 or Vedashree +91 98452 71738.' });
      let b;
      db.exec('BEGIN IMMEDIATE'); // atomic: no two guests can take the same capacity
      try {
        const t = allocate(x.date, x.start, x.type, n, q, undefined, undefined, x.loc);
        if (t < 0) { db.exec('ROLLBACK'); return json(res, 409, { error: 'Sorry, that capacity was just taken. Please pick another slot.' }); }
        b = { id: refId(), name: String(x.name).trim(), phone: String(x.phone).replace(/\D/g, ''), email: x.email.trim(), date: x.date, start: x.start, players: n, type: x.type, tbl: t, sets: q, game_fee: CFG.fee, rental_fee: q * CFG.rent, total: CFG.fee + q * CFG.rent, loc: x.loc, pay_method: online ? 'Online' : 'Pay at venue', pay_status: online ? 'Awaiting payment' : 'Pending', requests: String(x.requests || '').slice(0, 500) };
        db.prepare(`INSERT INTO bookings(id,name,phone,email,date,start,players,type,tbl,sets,game_fee,rental_fee,total,pay_method,pay_status,requests,status,hold_until,loc,dur) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(b.id, b.name, b.phone, b.email, b.date, b.start, b.players, b.type, b.tbl, b.sets, b.game_fee, b.rental_fee, b.total, b.pay_method, b.pay_status, b.requests, online ? 'held' : 'confirmed', online ? Date.now() + HOLD * 60000 : null, b.loc, CFG.dur);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (online && TESTPAY()) { // testing: no payment, confirm straight away and mark as TEST
        db.prepare('UPDATE bookings SET is_test=1,order_id=? WHERE id=?').run('TEST' + b.id.replace(/\W/g, ''), b.id);
        const done = await confirmPaid(b.id, 'TEST-' + b.id);
        return json(res, 201, { booking: done && !done.problem ? done : b, test: true });
      }
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
      const refund = cancelRow(b, 'Cancelled by guest');
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
        const tos = [].concat(url.searchParams.get('to') || STAFF_EMAIL);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (!E.RESEND_API_KEY || !E.FROM_EMAIL) return res.end('RESEND_API_KEY or FROM_EMAIL is missing in Render Environment.\nKey set: ' + !!E.RESEND_API_KEY + '\nFrom set: ' + !!E.FROM_EMAIL);
        const out = ['From: ' + E.FROM_EMAIL, 'Key starts with: ' + E.RESEND_API_KEY.slice(0, 3), 'Reply-To: ' + [].concat(E.REPLY_TO || STAFF_EMAIL).join(', '), ''];
        for (const to of tos) {
          const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: E.FROM_EMAIL, to: [to], subject: 'Mahjong Madness test email', html: '<p>Test email works.</p>' }) });
          out.push('To: ' + to, 'Resend status: ' + r.status, 'Resend reply: ' + await r.text(), '');
        }
        return res.end(out.join('\n'));
      }
      const rows = db.prepare('SELECT * FROM bookings ORDER BY date DESC,start DESC').all();
      if (url.pathname === '/admin/export.csv') {
        const cols = Object.keys(rows[0] || { id: 1 });
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=bookings.csv' });
        return res.end([cols.join(','), ...rows.map(r => cols.map(c => '"' + String(r[c] ?? '').replace(/"/g, '""') + '"').join(','))].join('\n'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<meta name=viewport content="width=device-width"><body style="font:14px sans-serif;padding:16px"><h2>Mahjong Madness bookings</h2><p><a href="/admin/export.csv">Export CSV</a> · ${rows.length} total</p><div style="overflow-x:auto"><table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>Ref<th>Date<th>Time<th>Guest<th>Mobile<th>Email<th>Players<th>Type<th>Table<th>Sets<th>Total<th>Payment<th>Status<th>Requests<th>Email status</tr>${rows.map(r => `<tr><td>${r.id}<td>${r.date}<td>${rng(r.start, r.dur)}<td>${esc(r.name)}<td>${r.phone}<td>${esc(r.email)}<td>${r.players}<td>${typeLbl(r.type)}<td>${r.tbl + 1}<td>${r.sets}<td>₹${r.total}<td>${r.pay_method} (${r.pay_status}) ${r.payment_id || ''}<td>${r.status}<td>${esc(r.requests)}<td>${r.email_status || ''}</tr>`).join('')}</table></div>`);
    }

    if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
      const base = E.PUBLIC_URL || ('https://' + req.headers.host);
      res.writeHead(200, { 'Content-Type': url.pathname === '/robots.txt' ? 'text/plain' : 'application/xml' });
      return res.end(url.pathname === '/robots.txt' ? 'User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ' + base + '/sitemap.xml\n' : '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + base + '/</loc></url></urlset>');
    }
    if (url.pathname === '/' || url.pathname === '/index.html') { const page = fs.readFileSync(new URL('./index.html', import.meta.url)); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page); }
    res.writeHead(404); res.end('Not found');
  } catch (e) { console.error(e); if (res.headersSent) return res.end(); json(res, 500, { error: 'Something went wrong. Please try again.' }); }
}).listen(PORT, () => console.log('Mahjong Madness running on :' + PORT));
