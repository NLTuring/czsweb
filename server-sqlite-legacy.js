// ============================================================
// "创智算"网站服务端（零依赖，Node.js 内置模块实现）
// ------------------------------------------------------------
// 功能：
//   1. 用户数据库：SQLite（Node 内置 node:sqlite），文件 users.db
//      - users 表：用户名/密码哈希(带盐 scrypt)/姓名/学号/学院/头像/缴费状态/管理员标记
//      - sessions 表：登录会话（7 天有效）
//      - payment_proofs 表：缴费凭证（付款截图）审核记录
//   2. 登录鉴权：所有网页内容与资源必须登录后才能访问
//   3. 社费门禁（真实人工核验，无法自行绕过）：
//      - 未缴费用户 → 全屏悬浮窗（money.jpg 收款码）遮盖，只能上传付款截图
//      - 管理员在 /admin.html 核对微信账单后批准 → 服务器写入 paid=1 → 解锁
//      - 用户端不存在任何"确认支付"自解锁接口
//   4. 静态站点服务：本目录下的全部页面与资源
//
// 启动：node server.js   （端口默认 8080，可用环境变量 PORT 覆盖）
// 管理员：首次启动自动生成 admin-config.json（含随机初始密码），
//         控制台会打印一次；也可用环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 指定。
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 会话有效期 7 天
const COOKIE_NAME = 'czs_sid';
const PROOF_MAX_BYTES = 5 * 1024 * 1024; // 付款截图 ≤ 5MB
const BODY_MAX_CHARS = 12 * 1024 * 1024; // 请求体上限（base64 截图）

/* ---------------- 数据库 ---------------- */
const db = new DatabaseSync(path.join(ROOT, 'users.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    student_id TEXT NOT NULL DEFAULT '',
    college TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    image TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    competition_id TEXT NOT NULL DEFAULT '',
    competition_name TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '',
    need_count INTEGER NOT NULL DEFAULT 1,
    have_count INTEGER NOT NULL DEFAULT 0,
    grade TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    creator_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'recruiting',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS team_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS internal_competitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'club',
    deadline TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '',
    tech TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);
// 数据库迁移：补充 paid / avatar / is_admin 字段
(function migrate(){
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if(!cols.includes('paid')) db.exec('ALTER TABLE users ADD COLUMN paid INTEGER NOT NULL DEFAULT 0');
  if(!cols.includes('avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  if(!cols.includes('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  const icols = db.prepare('PRAGMA table_info(internal_competitions)').all().map(c => c.name);
  if(!icols.includes('level')) db.exec("ALTER TABLE internal_competitions ADD COLUMN level TEXT NOT NULL DEFAULT 'club'");
})();

// 上传目录（需登录后访问）
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(path.join(UPLOAD_DIR, 'proofs'), { recursive: true });

/* ---------------- 管理员初始化 ---------------- */
function bootstrapAdmin(){
  let adminConf = {};
  const confPath = path.join(ROOT, 'admin-config.json');
  const envUser = process.env.ADMIN_USERNAME;
  const envPass = process.env.ADMIN_PASSWORD;

  if(fs.existsSync(confPath)){
    try { adminConf = JSON.parse(fs.readFileSync(confPath, 'utf8')); } catch(e){ adminConf = {}; }
  }
  let username = envUser || adminConf.username || 'admin';
  let password = envPass || adminConf.password;
  if(!password){
    password = crypto.randomBytes(9).toString('hex'); // 18 位随机密码
    fs.writeFileSync(confPath, JSON.stringify({ username, password }, null, 2), 'utf8');
    console.log('==============================================================');
    console.log('已生成管理员账号（首次启动）：');
    console.log('  用户名: ' + username);
    console.log('  初始密码: ' + password + '  （请立即登录 /admin.html 使用，可修改 admin-config.json）');
    console.log('==============================================================');
  }
  const exists = db.prepare('SELECT id, salt, password_hash FROM users WHERE username = ?').get(username);
  if(exists){
    // 幂等同步：确保数据库中的管理员密码与 admin-config.json / 环境变量一致
    const newHash = hashPassword(password, exists.salt);
    db.prepare('UPDATE users SET is_admin = 1, password_hash = ? WHERE id = ?').run(newHash, exists.id);
  } else {
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare(
      'INSERT INTO users (username, password_hash, salt, name, is_admin, created_at) VALUES (?,?,?,?,1,?)'
    ).run(username, hashPassword(password, salt), salt, '管理员', new Date().toISOString());
  }

  // 额外管理员：admin-config.json 的 admins 数组（用已存在账号的用户名，仅提升权限不改密码）
  // 例如：{ "username":"admin", "password":"...", "admins":["SGH"] }
  if(Array.isArray(adminConf.admins)){
    adminConf.admins.forEach(function(name){
      const nameStr = String(name).trim();
      if(!nameStr) return;
      const u = db.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(nameStr);
      if(u){
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
        if(!u.is_admin) console.log('已将账号 ' + nameStr + ' 设为管理员');
      } else {
        console.log('提示：admin-config.json 中 admins 指定的账号 ' + nameStr + ' 不存在，已跳过');
      }
    });
  }
}

/* ---------------- 工具函数 ---------------- */
function hashPassword(password, salt){
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function json(res, code, obj){
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req){
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => {
      data += c;
      if(data.length > BODY_MAX_CHARS){ req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch(e){ resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function getCookies(req){
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if(i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req){
  const token = getCookies(req)[COOKIE_NAME];
  if(!token) return null;
  const row = db.prepare(
    'SELECT u.id, u.username, u.name, u.student_id, u.college, u.paid, u.avatar, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ).get(token, Date.now());
  return row || null;
}

/* ---------------- 登录失败限流：同 IP / 同用户名 连续失败 5 次 → 锁定 15 分钟 ---------------- */
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // key -> { times:[], lockUntil }

function clientIp(req){
  const xff = req.headers['x-forwarded-for'];
  if(xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isSecureRequest(req){
  return !!(req.socket && req.socket.encrypted) || (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

// 返回锁定提示，未锁定返回 null
function loginLockMessage(username, ip){
  const now = Date.now();
  for(const key of ['u:' + username, 'ip:' + ip]){
    const rec = loginFails.get(key);
    if(rec && rec.lockUntil > now){
      const min = Math.max(1, Math.ceil((rec.lockUntil - now) / 60000));
      return '登录尝试次数过多，已锁定，请 ' + min + ' 分钟后再试';
    }
  }
  return null;
}

function loginFail(username, ip){
  const now = Date.now();
  for(const key of ['u:' + username, 'ip:' + ip]){
    let rec = loginFails.get(key);
    if(!rec){ rec = { times: [], lockUntil: 0 }; loginFails.set(key, rec); }
    if(rec.lockUntil > now) continue;
    rec.times = rec.times.filter(t => now - t < LOGIN_LOCK_MS);
    rec.times.push(now);
    if(rec.times.length >= LOGIN_MAX_FAILS) rec.lockUntil = now + LOGIN_LOCK_MS;
  }
}

function loginSuccess(username, ip){
  loginFails.delete('u:' + username);
  loginFails.delete('ip:' + ip);
}

// 用户当前缴费凭证状态
function proofStatusOf(userId){
  const p = db.prepare(
    'SELECT id, image, status, note, created_at FROM payment_proofs WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(userId);
  return p || null;
}

function saveBase64Image(dataUrl, dir, prefix, maxBytes, allowed){
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if(!m) return { err: '仅支持 PNG / JPG / WebP 图片' };
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  if(allowed && !allowed.includes(ext)) return { err: '图片格式不支持' };
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch(e){ return { err: '图片数据无效' }; }
  if(buf.length === 0) return { err: '图片数据为空' };
  if(buf.length > maxBytes) return { err: '图片大小超过限制（' + Math.round(maxBytes / 1024 / 1024) + 'MB）' };
  const filename = prefix + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(dir, filename), buf);
  return { filename };
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname){
  // POST /api/register
  if(pathname === '/api/register' && req.method === 'POST'){
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const name = String(b.name || '').trim();
    const studentId = String(b.studentId || '').trim();
    const college = String(b.college || '').trim();

    if(!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)){
      return json(res, 400, { ok: false, msg: '用户名需为 2–20 位字母、数字、下划线或中文' });
    }
    if(password.length < 6 || password.length > 64){
      return json(res, 400, { ok: false, msg: '密码长度需为 6–64 位' });
    }
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if(exists) return json(res, 409, { ok: false, msg: '用户名已被注册' });

    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare(
      'INSERT INTO users (username, password_hash, salt, name, student_id, college, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(username, hashPassword(password, salt), salt, name, studentId, college, new Date().toISOString());
    return json(res, 201, { ok: true, msg: '注册成功，请登录' });
  }

  // POST /api/login（含失败限流：同 IP / 同用户名 连续 5 次 → 锁 15 分钟）
  if(pathname === '/api/login' && req.method === 'POST'){
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const ip = clientIp(req);
    const lockMsg = loginLockMessage(username, ip);
    if(lockMsg) return json(res, 429, { ok: false, msg: lockMsg });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if(!user || user.password_hash !== hashPassword(password, user.salt)){
      loginFail(username, ip);
      const after = loginLockMessage(username, ip);
      return json(res, 401, { ok: false, msg: after || '用户名或密码错误' });
    }
    loginSuccess(username, ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
      .run(token, user.id, Date.now() + SESSION_TTL_MS);
    const secure = isSecureRequest(req) ? '; Secure' : '';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${secure}`,
    });
    return res.end(JSON.stringify({ ok: true, msg: '登录成功', username: user.username, name: user.name }));
  }

  // POST /api/logout
  if(pathname === '/api/logout' && req.method === 'POST'){
    const token = getCookies(req)[COOKIE_NAME];
    if(token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /api/me —— 含缴费状态、凭证审核状态、管理员标记
  if(pathname === '/api/me' && req.method === 'GET'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false });
    const proof = proofStatusOf(user.id);
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

  // POST /api/pay/submit-proof —— 上传付款截图（仅未缴费用户；不改变缴费状态！）
  if(pathname === '/api/pay/submit-proof' && req.method === 'POST'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false, msg: '请先登录' });
    if(user.is_admin) return json(res, 400, { ok: false, msg: '管理员账号无需缴费' });
    if(user.paid) return json(res, 400, { ok: false, msg: '你已缴费，无需再次提交' });
    const b = await readBody(req);
    const r = saveBase64Image(b.image, path.join(UPLOAD_DIR, 'proofs'), 'proof-' + user.id, PROOF_MAX_BYTES);
    if(r.err) return json(res, 400, { ok: false, msg: r.err });
    // 旧的待审核/已驳回凭证标记为过期
    db.prepare("UPDATE payment_proofs SET status = 'SUPERSEDED' WHERE user_id = ? AND status IN ('PENDING','REJECTED')").run(user.id);
    db.prepare(
      'INSERT INTO payment_proofs (user_id, image, status, created_at) VALUES (?,?,?,?)'
    ).run(user.id, '/uploads/proofs/' + r.filename, 'PENDING', new Date().toISOString());
    return json(res, 200, { ok: true, msg: '凭证已提交，等待管理员审核', status: 'PENDING' });
  }

  // GET /api/pay/status —— 前端轮询：只有管理员批准后 paid 才会变 true
  if(pathname === '/api/pay/status' && req.method === 'GET'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false });
    const proof = proofStatusOf(user.id);
    return json(res, 200, {
      ok: true,
      paid: !!user.paid,
      proof: proof ? { status: proof.status, image: proof.image, note: proof.note } : null,
    });
  }

  // GET /api/admin/proofs —— 管理员：待审核 + 最近审核记录
  if(pathname === '/api/admin/proofs' && req.method === 'GET'){
    const user = currentUser(req);
    if(!user || !user.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    const pending = db.prepare(`
      SELECT p.id, p.user_id, p.image, p.status, p.note, p.created_at, u.username, u.name, u.student_id, u.college
      FROM payment_proofs p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'PENDING' ORDER BY p.id DESC
    `).all();
    const history = db.prepare(`
      SELECT p.id, p.user_id, p.image, p.status, p.note, p.created_at, p.reviewed_at, u.username, u.name
      FROM payment_proofs p JOIN users u ON u.id = p.user_id
      WHERE p.status IN ('APPROVED','REJECTED') ORDER BY p.id DESC LIMIT 20
    `).all();
    return json(res, 200, { ok: true, pending, history });
  }

  // POST /api/admin/review —— 管理员审核：approve 通过（置 paid=1）/ reject 驳回
  if(pathname === '/api/admin/review' && req.method === 'POST'){
    const admin = currentUser(req);
    if(!admin || !admin.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    const b = await readBody(req);
    const proofId = Number(b.proofId);
    const action = String(b.action || '');
    const note = String(b.note || '');
    const proof = db.prepare('SELECT * FROM payment_proofs WHERE id = ?').get(proofId);
    if(!proof) return json(res, 404, { ok: false, msg: '凭证不存在' });
    if(proof.status !== 'PENDING') return json(res, 400, { ok: false, msg: '该凭证已审核过' });

    if(action === 'approve'){
      db.prepare("UPDATE payment_proofs SET status = 'APPROVED', reviewed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), proofId);
      db.prepare('UPDATE users SET paid = 1 WHERE id = ?').run(proof.user_id);
      return json(res, 200, { ok: true, msg: '已通过，用户获得访问权限' });
    }
    if(action === 'reject'){
      db.prepare("UPDATE payment_proofs SET status = 'REJECTED', note = ?, reviewed_at = ? WHERE id = ?")
        .run(note || '凭证无效，请重新提交', new Date().toISOString(), proofId);
      return json(res, 200, { ok: true, msg: '已驳回' });
    }
    return json(res, 400, { ok: false, msg: 'action 无效' });
  }

  // POST /api/avatar —— 上传头像（base64 dataURL，png/jpg/webp，≤2MB）
  if(pathname === '/api/avatar' && req.method === 'POST'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const r = saveBase64Image(b.avatar, UPLOAD_DIR, 'avatar-' + user.id, 2 * 1024 * 1024);
    if(r.err) return json(res, 400, { ok: false, msg: r.err });
    const rel = '/uploads/' + r.filename;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(rel, user.id);
    if(user.avatar && user.avatar.startsWith('/uploads/')){
      const old = path.join(ROOT, user.avatar.slice(1));
      if(old !== path.join(UPLOAD_DIR, r.filename)) fs.unlink(old, () => {});
    }
    return json(res, 200, { ok: true, msg: '头像已更新', avatar: rel });
  }

  // ---------------- 组队（任何登录用户可发布/申请） ----------------

  // GET /api/teams?competition=<id> —— 组队列表
  if(pathname === '/api/teams' && req.method === 'GET'){
    const url = new URL(req.url, 'http://localhost');
    const compId = url.searchParams.get('competition') || '';
    const rows = compId
      ? db.prepare('SELECT t.*, u.username AS creator_username, u.name AS creator_name FROM teams t JOIN users u ON u.id = t.creator_id WHERE t.competition_id = ? ORDER BY t.created_at DESC').all(compId)
      : db.prepare('SELECT t.*, u.username AS creator_username, u.name AS creator_name FROM teams t JOIN users u ON u.id = t.creator_id ORDER BY t.created_at DESC').all();
    return json(res, 200, { ok: true, teams: rows });
  }

  // GET /api/team?id=<id> —— 组队详情（含申请人数量）
  if(pathname === '/api/team' && req.method === 'GET'){
    const id = Number(new URL(req.url, 'http://localhost').searchParams.get('id'));
    const team = db.prepare('SELECT t.*, u.username AS creator_username, u.name AS creator_name FROM teams t JOIN users u ON u.id = t.creator_id WHERE t.id = ?').get(id);
    if(!team) return json(res, 404, { ok: false, msg: '组队不存在' });
    const applyCount = db.prepare('SELECT COUNT(*) c FROM team_applications WHERE team_id = ? AND status = ?').get(id, 'pending').c;
    return json(res, 200, { ok: true, team, applyCount });
  }

  // POST /api/team/create —— 发布组队公告（任何登录用户）
  if(pathname === '/api/team/create' && req.method === 'POST'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    const need = Math.max(1, Math.min(50, Number(b.needCount) || 1));
    const have = Math.max(0, Math.min(50, Number(b.haveCount) || 0));
    if(!title) return json(res, 400, { ok: false, msg: '请填写队伍名称' });
    if(have + need > 60) return json(res, 400, { ok: false, msg: '人数不合理' });
    const skills = (Array.isArray(b.skills) ? b.skills : []).slice(0, 8).join(', ');
    if(skills.length > 200) return json(res, 400, { ok: false, msg: '标签过多' });
    const ins = db.prepare(
      'INSERT INTO teams (title, competition_id, competition_name, skills, need_count, have_count, grade, contact, description, creator_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      title,
      String(b.competitionId || '')[0] === '!' ? String(b.competitionId || '') : String(b.competitionId || ''),
      String(b.competitionName || '').slice(0, 120),
      skills,
      need,
      have,
      String(b.grade || '').slice(0, 40),
      String(b.contact || '').slice(0, 80),
      String(b.description || '').slice(0, 2000),
      user.id,
      'recruiting',
      new Date().toISOString()
    );
    return json(res, 201, { ok: true, msg: '组队公告已发布', id: ins.lastInsertRowid });
  }

  // POST /api/team/apply —— 申请加入组队
  if(pathname === '/api/team/apply' && req.method === 'POST'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const teamId = Number(b.teamId);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if(!team) return json(res, 404, { ok: false, msg: '组队不存在' });
    if(team.creator_id === user.id) return json(res, 400, { ok: false, msg: '不能申请自己发布的队伍' });
    const dup = db.prepare('SELECT id FROM team_applications WHERE team_id = ? AND user_id = ? AND status = ?').get(teamId, user.id, 'pending');
    if(dup) return json(res, 409, { ok: false, msg: '你已申请过这支队伍，等待对方处理' });
    db.prepare('INSERT INTO team_applications (team_id, user_id, message, created_at) VALUES (?,?,?,?)')
      .run(teamId, user.id, String(b.message || '').slice(0, 500), new Date().toISOString());
    return json(res, 201, { ok: true, msg: '申请已提交，等待队长确认' });
  }

  // GET /api/team/applications?teamId=<id> —— 查看组队的申请人（队长 / 管理员）
  if(pathname === '/api/team/applications' && req.method === 'GET'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false });
    const teamId = Number(new URL(req.url, 'http://localhost').searchParams.get('teamId'));
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if(!team) return json(res, 404, { ok: false });
    if(team.creator_id !== user.id && !user.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    const apps = db.prepare(`
      SELECT a.id, a.message, a.status, a.created_at, u.username, u.name, u.student_id, u.college
      FROM team_applications a JOIN users u ON u.id = a.user_id
      WHERE a.team_id = ? ORDER BY a.id DESC
    `).all(teamId);
    return json(res, 200, { ok: true, applications: apps });
  }

  // POST /api/team/accept —— 队长接受申请人（入队 +1）
  if(pathname === '/api/team/accept' && req.method === 'POST'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const appId = Number(b.applicationId);
    const app = db.prepare('SELECT * FROM team_applications WHERE id = ?').get(appId);
    if(!app) return json(res, 404, { ok: false, msg: '申请不存在' });
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(app.team_id);
    if(!team) return json(res, 404, { ok: false, msg: '队伍不存在' });
    if(team.creator_id !== user.id && !user.is_admin) return json(res, 403, { ok: false, msg: '无权限' });
    if(app.status !== 'pending') return json(res, 400, { ok: false, msg: '该申请已处理' });
    const newNeed = Math.max(0, (Number(team.need_count) || 0) - 1);
    const newStatus = newNeed === 0 ? 'full' : 'recruiting';
    db.prepare("UPDATE team_applications SET status = 'APPROVED' WHERE id = ?").run(appId);
    db.prepare('UPDATE teams SET have_count = have_count + 1, need_count = ?, status = ? WHERE id = ?').run(newNeed, newStatus, team.id);
    return json(res, 200, { ok: true, msg: '已接受申请' });
  }

  // POST /api/team/delete —— 撤销组队公告（队长本人 / 管理员）
  if(pathname === '/api/team/delete' && req.method === 'POST'){
    const user = currentUser(req);
    if(!user) return json(res, 401, { ok: false, msg: '请先登录' });
    const b = await readBody(req);
    const teamId = Number(b.teamId);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if(!team) return json(res, 404, { ok: false, msg: '组队不存在' });
    if(team.creator_id !== user.id && !user.is_admin) return json(res, 403, { ok: false, msg: '仅队长或管理员可撤销该公告' });
    db.prepare('DELETE FROM team_applications WHERE team_id = ?').run(teamId);
    db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
    return json(res, 200, { ok: true, msg: '公告已撤销' });
  }

  // ---------------- 协会内部竞赛（仅管理员可发布） ----------------

  // GET /api/competitions/internal —— 内部竞赛列表
  if(pathname === '/api/competitions/internal' && req.method === 'GET'){
    const rows = db.prepare('SELECT i.*, u.username AS creator_username FROM internal_competitions i JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC').all();
    return json(res, 200, { ok: true, competitions: rows });
  }

  // POST /api/admin/competition —— 管理员发布协会内部竞赛通知
  if(pathname === '/api/admin/competition' && req.method === 'POST'){
    const user = currentUser(req);
    if(!user || !user.is_admin) return json(res, 403, { ok: false, msg: '仅管理员可发布协会内部竞赛通知' });
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    if(!name) return json(res, 400, { ok: false, msg: '请填写竞赛名称' });
    if(name.length > 120) return json(res, 400, { ok: false, msg: '竞赛名称过长' });
    const level = b.level === 'school' ? 'school' : 'club';
    const ins = db.prepare(
      'INSERT INTO internal_competitions (name, level, deadline, date, location, description, skills, tech, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(
      name,
      level,
      String(b.deadline || ''),
      String(b.date || ''),
      String(b.location || '').slice(0, 80),
      String(b.description || '').slice(0, 2000),
      String(b.skills || '').slice(0, 200),
      String(b.tech || ''),
      user.id,
      new Date().toISOString()
    );
    return json(res, 201, { ok: true, msg: '竞赛通知已发布', id: ins.lastInsertRowid });
  }

  // DELETE /api/admin/competition?id=<id> —— 管理员删除协会内部竞赛通知
  if(pathname === '/api/admin/competition' && req.method === 'DELETE'){
    const user = currentUser(req);
    if(!user || !user.is_admin) return json(res, 403, { ok: false, msg: '仅管理员可删除协会内部竞赛通知' });
    const id = Number(new URL(req.url, 'http://localhost').searchParams.get('id'));
    db.prepare('DELETE FROM internal_competitions WHERE id = ?').run(id);
    return json(res, 200, { ok: true, msg: '已删除' });
  }

  return json(res, 404, { ok: false, msg: 'not found' });
}

/* ---------------- 静态文件 ---------------- */
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

function serveFile(req, res, pathname){
  let rel = decodeURIComponent(pathname);
  if(rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if(!filePath.startsWith(ROOT)){ res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(filePath, (err, st) => {
    if(err || !st.isFile()){
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 Not Found</h1>');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */
const PUBLIC_PATHS = new Set(['/login.html', '/register.html', '/favicon.ico']);

bootstrapAdmin();

// HTTPS 支持：存在 cert/fullchain.pem + cert/privkey.pem（或用环境变量 TLS_CERT / TLS_KEY 指定）时自动以 HTTPS 启动
const TLS_CERT = process.env.TLS_CERT || path.join(ROOT, 'cert', 'fullchain.pem');
const TLS_KEY = process.env.TLS_KEY || path.join(ROOT, 'cert', 'privkey.pem');
const HTTPS_ENABLED = fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if(pathname.startsWith('/api/')) return handleApi(req, res, pathname);

  const user = currentUser(req);

  // 公开页面（登录/注册）
  if(PUBLIC_PATHS.has(pathname)) return serveFile(req, res, pathname);

  // 未登录：页面跳转登录页；静态资源返回 403
  if(!user){
    if(pathname.endsWith('.html') || pathname === '/'){
      const next = encodeURIComponent(pathname + url.search);
      res.writeHead(302, { 'Location': '/login.html?next=' + next });
      return res.end();
    }
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>403</h1><p>请先<a href="/login.html">登录</a>后访问。</p>');
  }

  // 登录用户：正常提供页面
  serveFile(req, res, pathname);
};

const server = HTTPS_ENABLED
  ? require('https').createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler)
  : http.createServer(handler);

const proto = HTTPS_ENABLED ? 'https' : 'http';
server.listen(PORT, () => {
  console.log('创智算网站服务已启动: ' + proto + '://localhost:' + PORT);
  console.log('用户数据库: ' + path.join(ROOT, 'users.db'));
  console.log('社费核验：用户上传付款截图 → 管理员在 /admin.html 审核通过后解锁');
  if(HTTPS_ENABLED){
    console.log('HTTPS 已启用（证书：' + TLS_CERT + '）');
  } else {
    console.log('提示：当前为 HTTP。将证书放到 cert/fullchain.pem 与 cert/privkey.pem 后重启即自动启用 HTTPS。');
  }
  console.log('登录限流：同 IP / 同用户名连续失败 5 次锁定 15 分钟');
});
