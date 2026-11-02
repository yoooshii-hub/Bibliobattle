// 共通：ボタン定義・アイコン・API ヘルパー
const INK = '#3b2a20';

const BV_ICONS = [
  // 1: 大きく開いた本
  `<svg viewBox="0 0 100 100" aria-hidden="true">
    <path d="M50 4l3.2 8.3 8.3 3.2-8.3 3.2L50 27l-3.2-8.3-8.3-3.2 8.3-3.2z" fill="#ffd54a" class="spark"/>
    <circle cx="20" cy="20" r="3.5" fill="#ffd54a" class="spark"/><circle cx="82" cy="18" r="4" fill="#ffd54a" class="spark"/>
    <path d="M4 38Q27 31 50 42Q73 31 96 38V88Q73 81 50 92Q27 81 4 88Z" fill="#a8341a" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M9 33Q30 26 50 37V85Q30 76 9 81Z" fill="#fffaf0" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M91 33Q70 26 50 37V85Q70 76 91 81Z" fill="#fffaf0" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M17 45Q30 40 42 47M17 54Q30 49 42 56M17 63Q30 58 42 65M17 72Q30 67 42 74M83 45Q70 40 58 47M83 54Q70 49 58 56M83 63Q70 58 58 65M83 72Q70 67 58 74" stroke="#cdbba5" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  </svg>`,
  // 2: 閉じて立っている本
  `<svg viewBox="0 0 100 100" aria-hidden="true">
    <rect x="31" y="13" width="44" height="77" rx="4" fill="#f6eedc" stroke="${INK}" stroke-width="2.5"/>
    <path d="M70 19v66M66 17v70" stroke="#d8cbb2" stroke-width="1.5"/>
    <rect x="23" y="9" width="45" height="80" rx="4" fill="#f2a900" stroke="${INK}" stroke-width="2.5"/>
    <rect x="23" y="9" width="10" height="80" rx="3" fill="#cf8f00" stroke="${INK}" stroke-width="2.5"/>
    <rect x="39" y="25" width="22" height="13" rx="2" fill="#fff5d6" stroke="${INK}" stroke-width="2"/>
    <path d="M42 46h16M42 52h12" stroke="#fff5d6" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M56 88v9l4-3 4 3v-9" fill="#d6452b" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="82" cy="20" r="13" fill="#fff" stroke="${INK}" stroke-width="2.5"/>
    <text x="82" y="27.5" text-anchor="middle" font-size="20" font-weight="900" fill="${INK}" font-family="sans-serif">?</text>
  </svg>`,
  // 3: 手を×にしている人
  `<svg viewBox="0 0 100 100" aria-hidden="true">
    <path d="M22 98V74Q22 46 50 44Q78 46 78 74V98Z" fill="#6b84a8" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="50" cy="25" r="15" fill="#f6d2b4" stroke="${INK}" stroke-width="2.5"/>
    <path d="M36 21Q38 8 50 9Q63 8 64 21Q57 14 50 16Q42 14 36 21Z" fill="${INK}"/>
    <path d="M43 26l3 2M57 26l-3 2" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M45 34q5-3 10 0" stroke="${INK}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path d="M27 55L73 91M73 55L27 91" stroke="${INK}" stroke-width="15" stroke-linecap="round"/>
    <path d="M27 55L73 91M73 55L27 91" stroke="#4a6690" stroke-width="10" stroke-linecap="round"/>
    <circle cx="27" cy="55" r="6" fill="#f6d2b4" stroke="${INK}" stroke-width="2.5"/>
    <circle cx="73" cy="55" r="6" fill="#f6d2b4" stroke="${INK}" stroke-width="2.5"/>
  </svg>`,
];

const BV_CHOICES = [
  { label: '読んでみたい！', short: '読んでみたい', color: '#ff6b4a', soft: '#ffe3da' },
  { label: '興味はあるけど・・購入要検討！', short: '購入要検討', color: '#f2a900', soft: '#fff1c7' },
  { label: 'あんまり興味ない・・買いません！', short: '興味なし', color: '#6b84a8', soft: '#e1e8f2' },
];

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login';
    throw new Error('ログインしてください');
  }
  if (!res.ok) {
    const err = new Error(data.error || `エラー (${res.status})`);
    Object.assign(err, data, { status: res.status });
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2400);
  setTimeout(() => el.remove(), 2800);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
