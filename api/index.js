// ============================================================
// "创智算"网站 Vercel Serverless API（PostgreSQL + Vercel Blob）
// ------------------------------------------------------------
// 功能：
//   1. 用户数据库：PostgreSQL（Neon），表结构与原 SQLite 一致
//   2. 文件存储：Vercel Blob（头像、付款凭证）
//   3. 登录鉴权：所有网页内容与资源必须登录后才能访问
//   4. 社费门禁、组队、内部竞赛等全部业务逻辑平移
//
// 环境变量：
//   DATABASE_URL        - Neon PostgreSQL 连接字符串（必须）
//   BLOB_READ_WRITE_TOKEN - Vercel Blob 读写 Token（必须，用于文件上传）
//   ADMIN_USERNAME      - 管理员用户名（可选，默认 admin）
//   ADMIN_PASSWORD      - 管理员密码（可选，首次启动自动生成并打印）
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const { put } = require('@vercel/blob');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 会话有效期 7 天
const COOKIE_NAME = 'czs_sid';
const PROOF_MAX_BYTES = 1 * 1024 * 1024; // 付款截图 ≤ 1MB（Vercel Serverless 请求体限制 4.5MB，base64 后约 1.33MB）
const BODY_MAX_CHARS = 12 * 1024 * 1024; // 请求体上限（base64 截图）

/* ---------------- 数据库 ---------------- */
const sql = neon(process.env.DATABASE_URL, {
  fetchConnectionCache: true,
});

async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      student_id TEXT NOT NULL DEFAULT '',
      college TEXT NOT NULL DEFAULT '',
      paid INTEGER NOT NULL DEFAULT 0,
      avatar TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS payment_proofs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      image TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      competition_id TEXT NOT NULL DEFAULT '',
      competition_name TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '',
      need_count INTEGER NOT NULL DEFAULT 1,
      have_count INTEGER NOT NULL DEFAULT 0,
      grade TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      creator_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'recruiting',
      created_at TEXT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS team_applications (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS internal_competitions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'club',
      deadline TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '',
      tech TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    )
  `;

  // 数据库迁移：补充字段（PostgreSQL 版）
  try {
    const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND table_schema = 'public'`;
    const colNames = cols.map(c => c.column_name);
    if (!colNames.includes('paid')) await sql`ALTER TABLE users ADD COLUMN paid INTEGER NOT NULL DEFAULT 0`;
    if (!colNames.includes('avatar')) await sql`ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''`;
    if (!colNames.includes('is_admin')) await sql`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`;
  } catch (e) {
    console.error('迁移 users 表失败:', e);
  }

  try {
    const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'internal_competitions' AND table_schema = 'public'`;
    const colNames = cols.map(c => c.column_name);
    if (!colNames.includes('level')) await sql`ALTER TABLE internal_competitions ADD COLUMN level TEXT NOT NULL DEFAULT 'club'`;
  } catch (e) {
    console.error('迁移 internal_competitions 表失败:', e);
  }
}

/* ---------------- 管理员初始化 ---------------- */
async function bootstrapAdmin() {
  const confPath = path.join(ROOT, 'admin-config.json');
  const envUser = process.env.ADMIN_USERNAME;
  const envPass = process.env.ADMIN_PASSWORD;

  let adminConf = {};
  try {
    if (fs.existsSync(confPath)) {
      try { adminConf = JSON.parse(fs.readFileSync(confPath, 'utf8')); } catch (e) { adminConf = {}; }
    }
  } catch (e) {
    // Vercel 等只读环境忽略
    adminConf = {};
  }

  let username = envUser || adminConf.username || 'admin';
  let password = envPass || adminConf.password;
  if (!password) {
    password = crypto.randomBytes(9).toString('hex');
    try {
      fs.writeFileSync(confPath, JSON.stringify({ username, password }, null, 2), 'utf8');
    } catch (e) {
      // Vercel 只读环境无法持久化密码，仅本次冷启动有效
      console.log('注意：当前环境无法写入 admin-config.json（只读文件系统）');
      console.log('建议：在 Vercel 环境变量中设置 ADMIN_USERNAME / ADMIN_PASSWORD');
    }
    console.log('==============================================================');
    console.log('已生成管理员账号（首次启动）：');
    console.log('  用户名: ' + username);
    console.log('  初始密码: ' + password + '  （请立即登录 /admin.html 使用）');
    console.log('==============================================================');
  }

  const users = await sql`SELECT id, salt, password_hash FROM users WHERE username = ${username}`;
  const exists = users.length > 0 ? users[0] : null;
  if (exists) {
    const newHash = hashPassword(password, exists.salt);
    await sql`UPDATE users SET is_admin = 1, password_hash = ${newHash} WHERE id = ${exists.id}`;
  } else {
    const salt = crypto.randomBytes(16).toString('hex');
    await sql`
      INSERT INTO users (username, password_hash, salt, name, is_admin, created_at)
      VALUES (${username}, ${hashPassword(password, salt)}, ${salt}, '管理员', 1, ${new Date().toISOString()})
    `;
  }

  if (Array.isArray(adminConf.admins)) {
    for (const name of adminConf.admins) {
      const nameStr = String(name).trim();
      if (!nameStr) continue;
      const u = await sql`SELECT id, is_admin FROM users WHERE username = ${nameStr}`;
      const user = u.length > 0 ? u[0] : null;
      if (user) {
        if (!user.is_admin) {
          await sql`UPDATE users SET is_admin = 1 WHERE id = ${user.id}`;
          console.log('已将账号 ' + nameStr + ' 设为管理员');
        }
      } else {
        console.log('提示：admin-config.json 中 admins 指定的账号 ' + nameStr + ' 不存在，已跳过');
      }
    }
  }
}

/* ---------------- 工具函数 ---------------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  // Vercel Pages Functions 已经解析了 req.body
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  }
  // 本地/标准 Node.js 模式
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > BODY_MAX_CHARS) { req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function getCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

async function currentUser(req) {
  const token = getCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.username, u.name, u.student_id, u.college, u.paid, u.avatar, u.is_admin
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > ${Date.now()}
  `;
  return rows.length > 0 ? rows[0] : null;
}

/* ---------------- 登录失败限流 ---------------- */
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // 注意：serverless 环境每个实例独立，冷启动后重置

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isSecureRequest(req) {
  return !!(req.socket && req.socket.encrypted) || (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function loginLockMessage(username, ip) {
  const now = Date.now();
  for (const key of ['u:' + username, 'ip:' + ip]) {
    const rec = loginFails.get(key);
    if (rec && rec.lockUntil > now) {
      const min = Math.max(1, Math.ceil((rec.lockUntil - now) / 60000));
      return '登录尝试次数过多，已锁定，请 ' + min + ' 分钟后再试';
    }
  }
  return null;
}

function loginFail(username, ip) {
  const now = Date.now();
  for (const key of ['u:' + username, 'ip:' + ip]) {
    let rec = loginFails.get(key);
    if (!rec) { rec = { times: [], lockUntil: 0 }; loginFails.set(key, rec); }
    if (rec.lockUntil > now) continue;
    rec.times = rec.times.filter((t) => now - t < LOGIN_LOCK_MS);
    rec.times.push(now);
    if (rec.times.length >= LOGIN_MAX_FAILS) rec.lockUntil = now + LOGIN_LOCK_MS;
  }
}

function loginSuccess(username, ip) {
  loginFails.delete('u:' + username);
  loginFails.delete('ip:' + ip);
}

/* ---------------- 凭证状态 ---------------- */
async function proofStatusOf(userId) {
  const rows = await sql`
    SELECT id, image, status, note, created_at
    FROM payment_proofs
    WHERE user_id = ${userId}
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

/* ---------------- 文件上传（Vercel Blob） ---------------- */
async function saveBase64Image(dataUrl, prefix, maxBytes) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return { err: '仅支持 PNG / JPG / WebP 图片' };
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (e) { return { err: '图片数据无效' }; }
  if (buf.length === 0) return { err: '图片数据为空' };
  if (buf.length > maxBytes) return { err: '图片大小超过限制（' + Math.round(maxBytes / 1024 / 1024) + 'MB）' };

  const filename = prefix + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  const contentType = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);

  try {
    const blob = await put(filename, buf, {
      access: 'public',
      contentType,
    });
    return { url: blob.url };
  } catch (e) {
    console.error('上传到 Vercel Blob 失败:', e);
    return { err: '图片上传失败，请重试' };
  }
}

/* ---------------- API 路由 ---------------- */
async function handleApi(req, res, pathname) {
  // POST /api/register
  if (pathname === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const name = String(b.name || '').trim();
    const studentId = String(b.studentId || '').trim();
    const college = String(b.college || '').trim();

    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
      return json(res, 400, { ok: false, msg: '用户名需为 2–20 位字母、数字、下划线或中文' });
    }
    if (password.length < 6 || password.length > 64) {
      return json(res, 400, { ok: false, msg: '密码长度需为 6–64 位' });
    }
    const dup = await sql`SELECT id FROM users WHERE username = ${username}`;
    if (dup.length > 0) return json(res, 409, { ok: false, msg: '用户名已被注册' });

    const salt = crypto.randomBytes(16).toString('hex');
    await sql`
      INSERT INTO users (username, password_hash, salt, name, student_id, college, created_at)
      VALUES (${username}, ${hashPassword(password, salt)}, ${salt}, ${name}, ${studentId}, ${college}, ${new Date().toISOString()})
    `;
    return json(res, 201, { ok: true, msg: '注册成功，请登录' });
  }

  // POST /api/login
  if (pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const ip = clientIp(req);
    const lockMsg = loginLockMessage(username, ip);
    if (lockMsg) return json(res, 429, { ok: false, msg: lockMsg });

    const users = await sql`SELECT * FROM users WHERE username = ${username}`;
    const user = users.length > 0 ? users[0] : null;
    if (!user || user.password_hash !== hashPassword(password, user.salt)) {
      loginFail(username, ip);
      const after = loginLockMessage(username, ip);
      return json(res, 401, { ok: false, msg: after || '用户名或密码错误' });
    }
    loginSuccess(username, ip);
    const token = crypto.randomBytes(32).toString('hex');
    await sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${token}, ${user.id}, ${Date.now() + SESSION_TTL_MS})`;
    const secure = isSecureRequest(req) ? '; Secure' : '';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${secure}`,
    });
    return res.end(JSON.stringify({ ok: true, msg: '登录成功', username: user.username, name: user.name }));
  }

  // POST /api/logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getCookies(req)[COOKIE_NAME];
    if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /api/me
  if (pathname === '/api/me' && req.method === 'GET') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false });
    const proof = await proofStatusOf(user.id);
    return json(res, 200, {
      ok: true,
      username: user.username,
      name: user.name,
      studentId: user.student_id,
      college: user.college,
      paid: !!user.paid,
      avatar: user.avatar,
      isAdmin: !!user.is_admin,
      proof: proof ? { status: proof.status, image: proof.image, note: proof.note } : null,
    });
  }

  // POST /api/pay/submit-proof
  if (pathname === '/api/pay/submit-proof' && req.method === 'POST') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false, msg: '请先登录' });
    if (user.is_admin) return json(res, 400, { ok: false, msg: '管理员账号无需缴费' });
    if (user.paid) return json(res, 400, { ok: false, msg: '你已缴费，无需再次提交' });
    const b = await readBody(req);
    const r = await saveBase64Image(b.image, 'proof-' + user.id, PROOF_MAX_BYTES);
    if (r.err) return json(res, 400, { ok: false, msg: r.err });
    await sql`UPDATE payment_proofs SET status = 'SUPERSEDED' WHERE user_id = ${user.id} AND status IN ('PENDING', 'REJECTED')`;
    await sql`
      INSERT INTO payment_proofs (user_id, image, status, created_at)
      VALUES (${user.id}, ${r.url}, 'PENDING', ${new Date().toISOString()})
    `;
    return json(res, 200, { ok: true, msg: '凭证已提交，等待管理员审核', status: 'PENDING' });
  }

  // GET /api/pay/status
  if (pathname === '/api/pay/status' && req.method === 'GET') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false });
    const proof = await proofStatusOf(user.id);
    return json(res, 200, {
      ok: true,
      paid: !!user.paid,
      proof: proof ? { status: proof.status, image: proof.image, note: proof.note } : null,
    });
  }

  // GET /api/admin/proofs
  if (pathname === '/api/admin/proofs' && req.method === 'GET') {
    const user = await currentUser(req);
    if (!user || !user.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    const pending = await sql`
      SELECT p.id, p.user_id, p.image, p.status, p.note, p.created_at, u.username, u.name, u.student_id, u.college
      FROM payment_proofs p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'PENDING'
      ORDER BY p.id DESC
    `;
    const history = await sql`
      SELECT p.id, p.user_id, p.image, p.status, p.note, p.created_at, p.reviewed_at, u.username, u.name
      FROM payment_proofs p
      JOIN users u ON u.id = p.user_id
      WHERE p.status IN ('APPROVED', 'REJECTED')
      ORDER BY p.id DESC
      LIMIT 20
    `;
    return json(res, 200, { ok: true, pending, history });
  }

  // POST /api/admin/review
  if (pathname === '/api/admin/review' && req.method === 'POST') {
    const admin = await currentUser(req);
    if (!admin || !admin.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    const b = await readBody(req);
    const proofId = Number(b.proofId);
    const action = String(b.action || '');
    const note = String(b.note || '');
    const proofs = await sql`SELECT * FROM payment_proofs WHERE id = ${proofId}`;
    const proof = proofs.length > 0 ? proofs[0] : null;
    if (!proof) return json(res, 404, { ok: false, msg: '凭证不存在' });
    if (proof.status !== 'PENDING') return json(res, 400, { ok: false, msg: '该凭证已审核过' });

    if (action === 'approve') {
      await sql`UPDATE payment_proofs SET status = 'APPROVED', reviewed_at = ${new Date().toISOString()} WHERE id = ${proofId}`;
      await sql`UPDATE users SET paid = 1 WHERE id = ${proof.user_id}`;
      return json(res, 200, { ok: true, msg: '已通过，用户获得访问权限' });
    }
    if (action === 'reject') {
      await sql`UPDATE payment_proofs SET status = 'REJECTED', note = ${note || '凭证无效，请重新提交'}, reviewed_at = ${new Date().toISOString()} WHERE id = ${proofId}`;
      return json(res, 200, { ok: true, msg: '已驳回' });
    }
    return json(res, 400, { ok: false, msg: 'action 无效' });
  }

  // POST /api/avatar
  if (pathname === '/api/avatar' && req.method === 'POST') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const r = await saveBase64Image(b.avatar, 'avatar-' + user.id, 2 * 1024 * 1024);
    if (r.err) return json(res, 400, { ok: false, msg: r.err });
    await sql`UPDATE users SET avatar = ${r.url} WHERE id = ${user.id}`;
    return json(res, 200, { ok: true, msg: '头像已更新', avatar: r.url });
  }

  // ---------------- 组队 ----------------

  // GET /api/teams
  if (pathname === '/api/teams' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const compId = url.searchParams.get('competition') || '';
    let teams;
    if (compId) {
      teams = await sql`
        SELECT t.*, u.username AS creator_username, u.name AS creator_name
        FROM teams t
        JOIN users u ON u.id = t.creator_id
        WHERE t.competition_id = ${compId}
        ORDER BY t.created_at DESC
      `;
    } else {
      teams = await sql`
        SELECT t.*, u.username AS creator_username, u.name AS creator_name
        FROM teams t
        JOIN users u ON u.id = t.creator_id
        ORDER BY t.created_at DESC
      `;
    }
    return json(res, 200, { ok: true, teams });
  }

  // GET /api/team
  if (pathname === '/api/team' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const id = Number(url.searchParams.get('id'));
    const teamRows = await sql`
      SELECT t.*, u.username AS creator_username, u.name AS creator_name
      FROM teams t
      JOIN users u ON u.id = t.creator_id
      WHERE t.id = ${id}
    `;
    const team = teamRows.length > 0 ? teamRows[0] : null;
    if (!team) return json(res, 404, { ok: false, msg: '组队不存在' });
    const appRows = await sql`SELECT COUNT(*) AS c FROM team_applications WHERE team_id = ${id} AND status = 'pending'`;
    const applyCount = appRows.length > 0 ? Number(appRows[0].c) : 0;
    return json(res, 200, { ok: true, team, applyCount });
  }

  // POST /api/team/create
  if (pathname === '/api/team/create' && req.method === 'POST') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    const need = Math.max(1, Math.min(50, Number(b.needCount) || 1));
    const have = Math.max(0, Math.min(50, Number(b.haveCount) || 0));
    if (!title) return json(res, 400, { ok: false, msg: '请填写队伍名称' });
    if (have + need > 60) return json(res, 400, { ok: false, msg: '人数不合理' });
    const skills = (Array.isArray(b.skills) ? b.skills : []).slice(0, 8).join(', ');
    if (skills.length > 200) return json(res, 400, { ok: false, msg: '标签过多' });

    const [ins] = await sql`
      INSERT INTO teams (title, competition_id, competition_name, skills, need_count, have_count, grade, contact, description, creator_id, status, created_at)
      VALUES (${title}, ${String(b.competitionId || '')}, ${String(b.competitionName || '').slice(0, 120)}, ${skills}, ${need}, ${have}, ${String(b.grade || '').slice(0, 40)}, ${String(b.contact || '').slice(0, 80)}, ${String(b.description || '').slice(0, 2000)}, ${user.id}, 'recruiting', ${new Date().toISOString()})
      RETURNING id
    `;
    return json(res, 201, { ok: true, msg: '组队公告已发布', id: ins.id });
  }

  // POST /api/team/apply
  if (pathname === '/api/team/apply' && req.method === 'POST') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const teamId = Number(b.teamId);
    const teamRows = await sql`SELECT * FROM teams WHERE id = ${teamId}`;
    const team = teamRows.length > 0 ? teamRows[0] : null;
    if (!team) return json(res, 404, { ok: false, msg: '组队不存在' });
    if (team.creator_id === user.id) return json(res, 400, { ok: false, msg: '不能申请自己发布的队伍' });
    const dup = await sql`SELECT id FROM team_applications WHERE team_id = ${teamId} AND user_id = ${user.id} AND status = 'pending'`;
    if (dup.length > 0) return json(res, 409, { ok: false, msg: '你已申请过这支队伍，等待对方处理' });
    await sql`
      INSERT INTO team_applications (team_id, user_id, message, created_at)
      VALUES (${teamId}, ${user.id}, ${String(b.message || '').slice(0, 500)}, ${new Date().toISOString()})
    `;
    return json(res, 201, { ok: true, msg: '申请已提交，等待队长确认' });
  }

  // GET /api/team/applications
  if (pathname === '/api/team/applications' && req.method === 'GET') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false });
    const url = new URL(req.url, 'http://localhost');
    const teamId = Number(url.searchParams.get('teamId'));
    const teamRows = await sql`SELECT * FROM teams WHERE id = ${teamId}`;
    const team = teamRows.length > 0 ? teamRows[0] : null;
    if (!team) return json(res, 404, { ok: false });
    if (team.creator_id !== user.id && !user.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    const apps = await sql`
      SELECT a.id, a.message, a.status, a.created_at, u.username, u.name, u.student_id, u.college
      FROM team_applications a
      JOIN users u ON u.id = a.user_id
      WHERE a.team_id = ${teamId}
      ORDER BY a.id DESC
    `;
    return json(res, 200, { ok: true, applications: apps });
  }

  // POST /api/team/accept
  if (pathname === '/api/team/accept' && req.method === 'POST') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const appId = Number(b.applicationId);
    const appRows = await sql`SELECT * FROM team_applications WHERE id = ${appId}`;
    const app = appRows.length > 0 ? appRows[0] : null;
    if (!app) return json(res, 404, { ok: false, msg: '申请不存在' });
    const teamRows = await sql`SELECT * FROM teams WHERE id = ${app.team_id}`;
    const team = teamRows.length > 0 ? teamRows[0] : null;
    if (!team) return json(res, 404, { ok: false, msg: '队伍不存在' });
    if (team.creator_id !== user.id && !user.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    if (app.status !== 'pending') return json(res, 400, { ok: false, msg: '该申请已处理' });
    const newNeed = Math.max(0, (Number(team.need_count) || 0) - 1);
    const newStatus = newNeed === 0 ? 'full' : 'recruiting';
    await sql`UPDATE team_applications SET status = 'APPROVED' WHERE id = ${appId}`;
    await sql`UPDATE teams SET have_count = have_count + 1, need_count = ${newNeed}, status = ${newStatus} WHERE id = ${team.id}`;
    return json(res, 200, { ok: true, msg: '已接受申请' });
  }

  // POST /api/team/delete
  if (pathname === '/api/team/delete' && req.method === 'POST') {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const teamId = Number(b.teamId);
    const teamRows = await sql`SELECT * FROM teams WHERE id = ${teamId}`;
    const team = teamRows.length > 0 ? teamRows[0] : null;
    if (!team) return json(res, 404, { ok: false, msg: '组队不存在' });
    if (team.creator_id !== user.id && !user.is_admin) return json(res, 403, { ok: false, msg: '仅队长或管理员可撤销该公告' });
    await sql`DELETE FROM team_applications WHERE team_id = ${teamId}`;
    await sql`DELETE FROM teams WHERE id = ${teamId}`;
    return json(res, 200, { ok: true, msg: '公告已撤销' });
  }

  // ---------------- 协会内部竞赛 ----------------

  // GET /api/competitions/internal
  if (pathname === '/api/competitions/internal' && req.method === 'GET') {
    const rows = await sql`
      SELECT i.*, u.username AS creator_username
      FROM internal_competitions i
      JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC
    `;
    return json(res, 200, { ok: true, competitions: rows });
  }

  // POST /api/admin/competition
  if (pathname === '/api/admin/competition' && req.method === 'POST') {
    const user = await currentUser(req);
    if (!user || !user.is_admin) return json(res, 403, { ok: false, msg: '仅管理员可发布协会内部竞赛通知' });
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    if (!name) return json(res, 400, { ok: false, msg: '请填写竞赛名称' });
    if (name.length > 120) return json(res, 400, { ok: false, msg: '竞赛名称过长' });
    const level = b.level === 'school' ? 'school' : 'club';
    const [ins] = await sql`
      INSERT INTO internal_competitions (name, level, deadline, date, location, description, skills, tech, created_by, created_at)
      VALUES (${name}, ${level}, ${String(b.deadline || '')}, ${String(b.date || '')}, ${String(b.location || '').slice(0, 80)}, ${String(b.description || '').slice(0, 2000)}, ${String(b.skills || '').slice(0, 200)}, ${String(b.tech || '')}, ${user.id}, ${new Date().toISOString()})
      RETURNING id
    `;
    return json(res, 201, { ok: true, msg: '竞赛通知已发布', id: ins.id });
  }

  // DELETE /api/admin/competition
  if (pathname === '/api/admin/competition' && req.method === 'DELETE') {
    const user = await currentUser(req);
    if (!user || !user.is_admin) return json(res, 403, { ok: false, msg: '仅管理员可删除协会内部竞赛通知' });
    const url = new URL(req.url, 'http://localhost');
    const id = Number(url.searchParams.get('id'));
    await sql`DELETE FROM internal_competitions WHERE id = ${id}`;
    return json(res, 200, { ok: true, msg: '已删除' });
  }

  return json(res, 404, { ok: false, msg: 'not found' });
}

/* ---------------- 静态文件服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.md': 'text/plain; charset=utf-8',
};

function serveFile(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 Not Found</h1>');
    }
    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 Not Found</h1>');
  }
}

/* ---------------- 主入口 ---------------- */
const PUBLIC_PATHS = new Set(['/login.html', '/register.html', '/favicon.ico']);

async function handler(req, res) {
  await initDb();
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // API 路由
  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname);
  }

  const user = await currentUser(req);

  // 公开页面
  if (PUBLIC_PATHS.has(pathname)) {
    return serveFile(req, res, pathname);
  }

  // 未登录：页面跳转登录页；其他资源返回 403
  if (!user) {
    if (pathname.endsWith('.html') || pathname === '/' || pathname === '') {
      const next = encodeURIComponent(pathname + url.search);
      res.writeHead(302, { 'Location': '/login.html?next=' + next });
      return res.end();
    }
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>403</h1><p>请先<a href="/login.html">登录</a>后访问。</p>');
  }

  // 登录用户：正常提供页面
  serveFile(req, res, pathname);
}

// Vercel Pages Functions 导出
module.exports = async (req, res) => {
  try {
    await bootstrapAdmin();
    await handler(req, res);
  } catch (e) {
    console.error('Server error:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '服务器内部错误' }));
    }
  }
};

// 本地开发模式支持
if (require.main === module) {
  const server = http.createServer(async (req, res) => {
    try {
      await bootstrapAdmin();
      await handler(req, res);
    } catch (e) {
      console.error('Server error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, msg: '服务器内部错误' }));
      }
    }
  });
  server.listen(PORT, () => {
    const proto = isSecureRequest({ socket: { encrypted: false } }) ? 'https' : 'http';
    console.log('创智算网站服务已启动: ' + proto + '://localhost:' + PORT);
    console.log('用户数据库: PostgreSQL (DATABASE_URL)');
    console.log('文件存储: Vercel Blob (BLOB_READ_WRITE_TOKEN)');
    console.log('社费核验：用户上传付款截图 → 管理员在 /admin.html 审核通过后解锁');
    console.log('登录限流：同 IP / 同用户名连续失败 5 次锁定 15 分钟');
  });
}
