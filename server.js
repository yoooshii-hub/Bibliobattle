const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// 全角/半角・大文字/小文字・前後の空白の違いを吸収して比べる
const norm = (v) => String(v ?? '').normalize('NFKC').trim();
const normCode = (v) => norm(v).replace(/\s+/g, '').toLowerCase();
const SIGNUP_CODE = normCode(process.env.SIGNUP_CODE); // 設定すると管理者登録に招待コードが必要
const CHOICES = 3;

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));
const server = http.createServer(app);
const io = new Server(server);

// ---------- ユーティリティ ----------
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const now = () => new Date().toISOString();
const zeros = () => [0, 0, 0];

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function hashPassword(pw, salt = rid(16)) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}

function adminFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader).bv_token;
  const id = token && store.db.tokens[token];
  return id ? store.db.admins[id] : null;
}

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function nextNo(ev) {
  const nos = ev.saved.map((s) => s.no);
  if (ev.current) nos.push(ev.current.no);
  return (nos.length ? Math.max(...nos) : 0) + 1;
}

function newSession(ev, state) {
  ev.current = { id: rid(8), no: nextNo(ev), label: '', counts: zeros(), votes: {}, state, startedAt: now() };
  return ev.current;
}

// ---------- 状態の送信 ----------
function guestState(ev) {
  return {
    name: ev.name,
    status: ev.status,
    session: ev.current ? { id: ev.current.id, no: ev.current.no, state: ev.current.state } : null,
  };
}

function roomSize(room) {
  return io.sockets.adapter.rooms.get(room)?.size || 0;
}

// 参加者ごとの選択（votes）は管理画面に送らず、人数だけ渡す
function publicSession(s) {
  const { votes, ...rest } = s;
  return { ...rest, voters: Object.keys(votes || {}).length };
}

function adminState(ev, base) {
  const out = {
    id: ev.id, name: ev.name, slug: ev.slug, status: ev.status, autoStart: ev.autoStart,
    current: ev.current ? publicSession(ev.current) : null,
    saved: ev.saved.map(publicSession), display: ev.display, createdAt: ev.createdAt,
    online: roomSize('g:' + ev.slug),
  };
  if (base) {
    out.guestUrl = `${base}/e/${ev.slug}`;
    out.displayUrl = `${base}/display/${ev.slug}?k=${ev.displayKey}`;
  }
  return out;
}

function displayState(ev) {
  return {
    name: ev.name, status: ev.status, display: ev.display,
    session: ev.current ? { no: ev.current.no, state: ev.current.state, label: ev.current.label } : null,
  };
}

// 状態が変わったら全員に通知
function broadcast(ev) {
  store.save();
  io.to('g:' + ev.slug).emit('state', guestState(ev));
  io.to('a:' + ev.id).emit('state', adminState(ev));
  io.to('d:' + ev.slug).emit('state', displayState(ev));
}

// 投票は 80ms ごとにまとめて管理画面・表示画面へ送る
const pending = new Map(); // eventId -> [n1,n2,n3]
setInterval(() => {
  for (const [eventId, pulses] of pending) {
    const ev = store.db.events[eventId];
    pending.delete(eventId);
    if (!ev) continue;
    const payload = { sessionId: ev.current?.id, counts: ev.current?.counts || zeros(), voters: Object.keys(ev.current?.votes || {}).length, display: ev.display, pulses };
    io.to('a:' + ev.id).emit('tick', payload);
    io.to('d:' + ev.slug).emit('tick', payload);
  }
}, 80);

// ---------- 認証 API ----------
function setTokenCookie(res, token) {
  res.setHeader('Set-Cookie', `bv_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

app.post('/api/signup', (req, res) => {
  const { username, password, code } = req.body || {};
  const name = norm(username);
  if (SIGNUP_CODE && normCode(code) !== SIGNUP_CODE) {
    return res.status(403).json({ error: '招待コードが違います（Render の環境変数 SIGNUP_CODE に設定した文字を入力してください）' });
  }
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'ユーザー名は2〜40文字で入力してください' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
  if (Object.values(store.db.admins).some((a) => a.username.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'このユーザー名は既に使われています' });
  }
  const id = rid(9);
  const { salt, hash } = hashPassword(String(password));
  store.db.admins[id] = { id, username: name, salt, hash, createdAt: now() };
  const token = rid(24);
  store.db.tokens[token] = id;
  store.save();
  setTokenCookie(res, token);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const a = Object.values(store.db.admins).find((x) => x.username.toLowerCase() === norm(username).toLowerCase());
  if (!a) return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  const { hash } = hashPassword(String(password || ''), a.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.hash, 'hex'))) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }
  const token = rid(24);
  store.db.tokens[token] = a.id;
  store.save();
  setTokenCookie(res, token);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).bv_token;
  if (token) { delete store.db.tokens[token]; store.save(); }
  res.setHeader('Set-Cookie', 'bv_token=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => res.json({ signupCode: !!SIGNUP_CODE }));

// ---------- 管理 API（要ログイン） ----------
function auth(req, res, next) {
  const a = adminFromCookie(req.headers.cookie);
  if (!a) return res.status(401).json({ error: 'ログインしてください' });
  req.admin = a;
  next();
}

function ownEvent(req, res, next) {
  const ev = store.db.events[req.params.id];
  if (!ev || ev.adminId !== req.admin.id) return res.status(404).json({ error: 'イベントが見つかりません' });
  req.ev = ev;
  next();
}

app.get('/api/me', auth, (req, res) => res.json({ id: req.admin.id, username: req.admin.username }));

app.get('/api/events', auth, (req, res) => {
  const list = Object.values(store.db.events)
    .filter((e) => e.adminId === req.admin.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((e) => ({
      id: e.id, name: e.name, status: e.status, createdAt: e.createdAt,
      sessions: e.saved.length, online: roomSize('g:' + e.slug),
    }));
  res.json(list);
});

app.post('/api/events', auth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'イベント名を入力してください' });
  const ev = {
    id: rid(9), adminId: req.admin.id, name, slug: rid(6), displayKey: rid(9),
    status: 'draft', autoStart: true, createdAt: now(),
    current: null, saved: [], display: zeros(),
  };
  store.db.events[ev.id] = ev;
  store.save();
  res.json({ id: ev.id });
});

app.get('/api/events/:id', auth, ownEvent, (req, res) => res.json(adminState(req.ev, baseUrl(req))));

app.patch('/api/events/:id', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  if (typeof req.body?.name === 'string' && req.body.name.trim()) ev.name = req.body.name.trim().slice(0, 80);
  if (typeof req.body?.autoStart === 'boolean') ev.autoStart = req.body.autoStart;
  broadcast(ev);
  res.json({ ok: true });
});

app.delete('/api/events/:id', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  delete store.db.events[ev.id];
  io.to('g:' + ev.slug).emit('state', { name: ev.name, status: 'deleted', session: null });
  store.save();
  res.json({ ok: true });
});

app.get('/api/events/:id/qr.svg', auth, ownEvent, async (req, res) => {
  const svg = await QRCode.toString(`${baseUrl(req)}/e/${req.ev.slug}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// イベント開始 → 最初のセッションが開始される
app.post('/api/events/:id/start', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  ev.status = 'running';
  if (!ev.current) newSession(ev, 'open');
  else ev.current.state = 'open';
  broadcast(ev);
  res.json({ ok: true });
});

app.post('/api/events/:id/end', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  ev.status = 'ended';
  if (ev.current) ev.current.state = 'standby';
  broadcast(ev);
  res.json({ ok: true });
});

// 現在のセッションの投票受付を開始/一時停止
app.post('/api/events/:id/session/open', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  if (ev.status !== 'running') return res.status(400).json({ error: '先にイベントを開始してください' });
  if (!ev.current) newSession(ev, 'open');
  else ev.current.state = 'open';
  broadcast(ev);
  res.json({ ok: true });
});

app.post('/api/events/:id/session/pause', auth, ownEvent, (req, res) => {
  if (req.ev.current) req.ev.current.state = 'standby';
  broadcast(req.ev);
  res.json({ ok: true });
});

// 現在のセッションの投票を 0 に戻す（参加者側もリセットされ、再開まで押せない）
app.post('/api/events/:id/session/reset', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  if (ev.current) {
    ev.current.id = rid(8);
    ev.current.counts = zeros();
    ev.current.votes = {};
    ev.current.state = 'standby';
  }
  broadcast(ev);
  res.json({ ok: true });
});

// 保存 → 右ペインに格納し、次のセッションへ
app.post('/api/events/:id/session/save', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  const cur = ev.current;
  if (!cur) return res.status(400).json({ error: '保存するセッションがありません' });
  const label = String(req.body?.label ?? cur.label ?? '').trim().slice(0, 80);
  ev.saved.push({ id: cur.restoredFrom || cur.id, no: cur.no, label: label || `セッション ${cur.no}`, counts: [...cur.counts], votes: { ...(cur.votes || {}) }, savedAt: now() });
  ev.saved.sort((a, b) => a.no - b.no);
  ev.current = null;
  newSession(ev, ev.status === 'running' && ev.autoStart ? 'open' : 'standby');
  broadcast(ev);
  res.json({ ok: true });
});

app.patch('/api/events/:id/session', auth, ownEvent, (req, res) => {
  if (req.ev.current && typeof req.body?.label === 'string') {
    req.ev.current.label = req.body.label.trim().slice(0, 80);
    broadcast(req.ev);
  }
  res.json({ ok: true });
});

// 保存済みセッションの名前変更
app.patch('/api/events/:id/saved/:sid', auth, ownEvent, (req, res) => {
  const s = req.ev.saved.find((x) => x.id === req.params.sid);
  if (!s) return res.status(404).json({ error: '見つかりません' });
  if (typeof req.body?.label === 'string' && req.body.label.trim()) s.label = req.body.label.trim().slice(0, 80);
  broadcast(req.ev);
  res.json({ ok: true });
});

app.delete('/api/events/:id/saved/:sid', auth, ownEvent, (req, res) => {
  req.ev.saved = req.ev.saved.filter((x) => x.id !== req.params.sid);
  broadcast(req.ev);
  res.json({ ok: true });
});

// セッション復元：保存済みセッションを現在のセッションに戻して修正・追加投票できるようにする
app.post('/api/events/:id/saved/:sid/restore', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  const s = ev.saved.find((x) => x.id === req.params.sid);
  if (!s) return res.status(404).json({ error: '見つかりません' });
  const cur = ev.current;
  if (cur && cur.counts.some((n) => n > 0) && !req.body?.discardCurrent) {
    return res.status(409).json({ error: '現在のセッションに未保存の投票があります', needDiscard: true });
  }
  ev.saved = ev.saved.filter((x) => x.id !== s.id);
  ev.current = {
    id: rid(8), restoredFrom: s.id, no: s.no, label: s.label, counts: [...s.counts], votes: { ...(s.votes || {}) },
    state: 'standby', startedAt: now(),
  };
  broadcast(ev);
  res.json({ ok: true });
});

// 合計表示ページの数をリセット
app.post('/api/events/:id/display/reset', auth, ownEvent, (req, res) => {
  req.ev.display = zeros();
  broadcast(req.ev);
  io.to('a:' + req.ev.id).emit('tick', { sessionId: req.ev.current?.id, counts: req.ev.current?.counts || zeros(), voters: Object.keys(req.ev.current?.votes || {}).length, display: req.ev.display, pulses: zeros() });
  io.to('d:' + req.ev.slug).emit('tick', { display: req.ev.display, pulses: zeros(), reset: true });
  res.json({ ok: true });
});

app.get('/api/events/:id/export.csv', auth, ownEvent, (req, res) => {
  const ev = req.ev;
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['No', '名前', '読んでみたい！', '購入要検討', '興味ない', '合計', '保存日時']];
  for (const s of ev.saved) {
    rows.push([s.no, s.label, ...s.counts, s.counts.reduce((a, b) => a + b, 0), new Date(s.savedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })]);
  }
  const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(ev.name)}.csv`);
  res.type('text/csv').send(csv);
});

// ---------- ページ ----------
const pub = path.join(__dirname, 'public');
app.get('/', (req, res) => res.redirect(adminFromCookie(req.headers.cookie) ? '/room' : '/login'));
app.get('/login', (req, res) => res.sendFile(path.join(pub, 'login.html')));
app.get('/room', (req, res) => res.sendFile(path.join(pub, 'room.html')));
app.get('/admin/event/:id', (req, res) => res.sendFile(path.join(pub, 'event.html')));
app.get('/e/:slug', (req, res) => res.sendFile(path.join(pub, 'guest.html')));
app.get('/display/:slug', (req, res) => res.sendFile(path.join(pub, 'display.html')));
app.use(express.static(pub, { index: false }));

// ---------- リアルタイム通信 ----------
const findBySlug = (slug) => Object.values(store.db.events).find((e) => e.slug === slug);

io.on('connection', (socket) => {
  let guestEv = null;
  let voterId = null;
  let lastSec = 0;
  let inSec = 0;

  // 参加者
  socket.on('guest:join', (msg) => {
    const slug = typeof msg === 'string' ? msg : msg?.slug;
    const vid = typeof msg === 'object' ? String(msg?.voterId || '') : '';
    voterId = /^[A-Za-z0-9_-]{8,40}$/.test(vid) ? vid : 'anon-' + socket.id;
    const ev = findBySlug(String(slug));
    if (!ev) return socket.emit('state', { status: 'notfound' });
    guestEv = ev.id;
    socket.join('g:' + ev.slug);
    socket.emit('state', guestState(ev));
    io.to('a:' + ev.id).emit('online', roomSize('g:' + ev.slug));
  });

  // この端末が現在のセッションで選んでいるボタン（無ければ null）
  socket.on('mychoice', (sessionId, ack) => {
    if (typeof ack !== 'function') return;
    const ev = guestEv && store.db.events[guestEv];
    const cur = ev?.current;
    if (!cur || cur.id !== sessionId) return ack({ choice: null });
    const c = cur.votes?.[voterId];
    ack({ choice: Number.isInteger(c) ? c : null });
  });

  // 投票：1端末につき1つだけ選べる。保存されるまで選び直せる
  socket.on('vote', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ev = guestEv && store.db.events[guestEv];
    const choice = Number(msg?.choice);
    if (!ev || !voterId || !Number.isInteger(choice) || choice < 0 || choice >= CHOICES) return reply({ ok: false });
    const cur = ev.current;
    if (ev.status !== 'running' || !cur || cur.state !== 'open' || cur.id !== msg.sessionId) {
      return reply({ ok: false, state: guestState(ev) });
    }
    // 連打対策：1台あたり毎秒 8 回まで
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== lastSec) { lastSec = sec; inSec = 0; }
    if (++inSec > 8) return reply({ ok: false, limited: true });

    cur.votes = cur.votes || {};
    const prev = cur.votes[voterId];
    if (prev === choice) return reply({ ok: true, choice });
    if (Number.isInteger(prev)) {
      cur.counts[prev] = Math.max(0, cur.counts[prev] - 1);
      ev.display[prev] = Math.max(0, ev.display[prev] - 1);
    }
    cur.votes[voterId] = choice;
    cur.counts[choice]++;
    ev.display[choice]++;
    const p = pending.get(ev.id) || zeros();
    p[choice]++;
    pending.set(ev.id, p);
    store.save();
    reply({ ok: true, choice });
  });

  // 管理者
  socket.on('admin:join', (eventId) => {
    const a = adminFromCookie(socket.handshake.headers.cookie);
    const ev = store.db.events[String(eventId)];
    if (!a || !ev || ev.adminId !== a.id) return socket.emit('denied');
    socket.join('a:' + ev.id);
    socket.emit('state', adminState(ev));
  });

  // 合計表示ページ
  socket.on('display:join', ({ slug, key } = {}) => {
    const ev = findBySlug(String(slug));
    if (!ev || ev.displayKey !== key) return socket.emit('denied');
    socket.join('d:' + ev.slug);
    socket.emit('state', displayState(ev));
  });

  socket.on('disconnect', () => {
    const ev = guestEv && store.db.events[guestEv];
    if (ev) io.to('a:' + ev.id).emit('online', roomSize('g:' + ev.slug));
  });
});

app.get('/healthz', (req, res) => res.send('ok'));

store.init().then(() => server.listen(PORT, () => {
  console.log(`📚 ビブリオバトル投票アプリ起動: http://localhost:${PORT}`);
  if (!PUBLIC_URL) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`   同じWi-Fiの端末からは: http://${n.address}:${PORT}`);
      }
    }
  }
})).catch((e) => {
  console.error('起動に失敗しました:', e.message);
  process.exit(1);
});
