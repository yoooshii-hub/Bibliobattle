// データ保存：DATABASE_URL があれば PostgreSQL（Neon など）、なければ JSON ファイル
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

let db = { admins: {}, tokens: {}, events: {} };
let pool = null;

function normalize() {
  db.admins = db.admins || {};
  db.tokens = db.tokens || {};
  db.events = db.events || {};
}

async function init() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 3,
    });
    await pool.query('CREATE TABLE IF NOT EXISTS bv_store (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const r = await pool.query('SELECT data FROM bv_store WHERE id = 1');
    if (r.rows[0]) db = r.rows[0].data;
    console.log('💾 保存先: PostgreSQL');
  } else {
    try {
      db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    console.log(`💾 保存先: ${FILE}`);
  }
  normalize();
}

let timer = null;
let writing = Promise.resolve();
function save() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, pool ? 1000 : 400);
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const json = JSON.stringify(db);
  if (pool) {
    writing = writing
      .then(() => pool.query(
        'INSERT INTO bv_store (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
        [json],
      ))
      .catch((e) => console.error('保存に失敗しました:', e.message));
    return writing;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, FILE);
  return Promise.resolve();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await flush(); } catch (e) { console.error(e); }
    process.exit(0);
  });
}

module.exports = { get db() { return db; }, init, save, flush };
