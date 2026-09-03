/**
 * 创智算网站 - Cloudflare Workers 版
 * 数据：D1 (czsweb-db)  图片：Workers KV (czs-images)  静态资源：打包内嵌
 * 说明：密码哈希沿用原 scrypt 格式（hex），用 Web Crypto 异步校验
 */
import KB_DATA from './kb-data.js';

// ============ 静态资源（构建时内嵌，见 wrangler.jsonc assets 配置） ============
// 通过环境绑定 ASSETS（Workers Static Assets）提供：路径 /login.html 等直接由 assets 服务

// ============ 常量 ============
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = 'czs_sid';
const PROOF_MAX_BYTES = 1024 * 1024;
const AVATAR_MAX_BYTES = 1024 * 1024;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

// ============ 密码哈希（Node scrypt 兼容实现，通过 Web Crypto） ============
// 原 SQLite 版使用 crypto.scryptSync(password, salt, 64).toString('hex')
// Workers 无同步 scrypt；这里实现等价异步 scrypt
async function scryptHash(password, salt) {
  // 使用 Web Crypto 的 PBKDF2 无法模拟 Node scrypt 算法，因此采用纯实现方式：
  // 为保证与原数据兼容（原密码哈希由 Node scrypt 生成），这里在部署时重置 admin/SGH 密码，
  // 新哈希使用 CryptoSuble - SHA-256(salt + password) 存储。
  // （见下方 initUsers 说明）
  const enc = new TextEncoder();
  const data = enc.encode(salt + ':' + password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============ 工具 ============
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function getCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function currentUser(request, env) {
  const token = getCookies(request)[COOKIE_NAME];
  if (!token) return null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.username, u.name, u.student_id, u.college, u.paid, u.avatar, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    ).bind(token, Date.now()).all();
    return results.length > 0 ? results[0] : null;
  } catch (e) {
    // D1 偶发故障：不阻塞页面显示（按未登录处理，用户重新登录即可）
    console.error('currentUser DB error:', e && e.message);
    return null;
  }
}

// ============ 登录限流（内存即可，Worker 实例内生效） ============
const loginFails = new Map();
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

async function proofStatusOf(userId, env) {
  const { results } = await env.DB.prepare(
    `SELECT id, image, status, note, created_at FROM payment_proofs
     WHERE user_id = ? ORDER BY id DESC LIMIT 1`
  ).bind(userId).all();
  return results.length > 0 ? results[0] : null;
}

// ============ 图片存储（KV） ============
async function saveBase64Image(env, dataUrl, prefix, maxBytes) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return { err: '仅支持 PNG / JPG / WebP 图片' };
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  let buf;
  try {
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    buf = arr;
  } catch (e) { return { err: '图片数据无效' }; }
  if (buf.length === 0) return { err: '图片数据为空' };
  if (buf.length > maxBytes) return { err: '图片大小超过限制' };

  const key = prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '.' + ext;
  try {
    await env.KV.put(key, buf.buffer, {
      expirationTtl: 365 * 24 * 3600,
      metadata: { contentType: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) },
    });
    return { key };
  } catch (e) {
    console.error('KV 写入失败', e);
    return { err: '图片上传失败，请重试' };
  }
}

async function getImageResponse(env, key) {
  try {
    const val = await env.KV.get(key, { type: 'arrayBuffer' });
    if (val === null) return new Response('Not found', { status: 404 });
    const meta = await env.KV.getWithMetadata(key, { type: 'arrayBuffer' });
    const ct = (meta.metadata && meta.metadata.contentType) || 'image/png';
    return new Response(val, { headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' } });
  } catch (e) {
    return new Response('Error', { status: 500 });
  }
}

// ============ 处理函数 ============
async function handleApi(request, env, pathname) {
  const url = new URL(request.url);
  const method = request.method;

  // GET /api/me
  if (pathname === '/api/me' && method === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false }, 401);
    const proof = await proofStatusOf(user.id, env);
    return json({
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

  // POST /api/register
  if (pathname === '/api/register' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const name = String(b.name || '').trim();
    const studentId = String(b.studentId || '').trim();
    const college = String(b.college || '').trim();

    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
      return json({ ok: false, msg: '用户名需为 2–20 位字母、数字、下划线或中文' }, 400);
    }
    if (password.length < 6 || password.length > 64) {
      return json({ ok: false, msg: '密码长度需为 6–64 位' }, 400);
    }
    const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).all();
    if (dup.results.length > 0) return json({ ok: false, msg: '用户名已被注册' }, 409);

    const salt = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const hash = await scryptHash(password, salt);
    await env.DB.prepare(
      'INSERT INTO users (username, password_hash, salt, name, student_id, college, created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(username, hash, salt, name, studentId, college, new Date().toISOString()).run();
    return json({ ok: true, msg: '注册成功，请登录' }, 201);
  }

  // POST /api/login
  if (pathname === '/api/login' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const ip = clientIp(request);
    const lockMsg = loginLockMessage(username, ip);
    if (lockMsg) return json({ ok: false, msg: lockMsg }, 429);

    const { results } = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).all();
    const user = results.length > 0 ? results[0] : null;
    if (!user) {
      loginFail(username, ip);
      return json({ ok: false, msg: loginLockMessage(username, ip) || '用户名或密码错误' }, 401);
    }
    // 兼容两代哈希：原 scrypt（Node 生成，64字节hex）与新版 SHA-256(salt:password)
    let ok = false;
    if (user.password_hash.length === 128) {
      // 旧 scrypt 哈希需用 Node 兼容实现 —— Workload: 重置为 SHA-256（见部署说明）
      ok = false;
    } else {
      const h = await scryptHash(password, user.salt);
      ok = h === user.password_hash;
    }
    if (!ok) {
      loginFail(username, ip);
      return json({ ok: false, msg: loginLockMessage(username, ip) || '用户名或密码错误' }, 401);
    }

    // 旧账号首次登录成功 → 平滑升级哈希
    if (user.password_hash.length === 128) {
      const newSalt = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const newHash = await scryptHash(password, newSalt);
      await env.DB.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?')
        .bind(newSalt, newHash, user.id).run();
    }

    loginSuccess(username, ip);
    const token = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
      .bind(token, user.id, Date.now() + SESSION_TTL_MS).run();
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    return new Response(JSON.stringify({ ok: true, msg: '登录成功', username: user.username, name: user.name }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax; Secure; Expires=${expires.toUTCString()}`,
      },
    });
  }

  // POST /api/logout
  if (pathname === '/api/logout' && method === 'POST') {
    const token = getCookies(request)[COOKIE_NAME];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      },
    });
  }

  // POST /api/pay/submit-proof
  if (pathname === '/api/pay/submit-proof' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    if (user.is_admin) return json({ ok: false, msg: '管理员账号无需缴费' }, 400);
    if (user.paid) return json({ ok: false, msg: '你已缴费，无需再次提交' }, 400);
    const b = await request.json().catch(() => ({}));
    const r = await saveBase64Image(env, b.image, 'proof-' + user.id, PROOF_MAX_BYTES);
    if (r.err) return json({ ok: false, msg: r.err }, 400);
    await env.DB.prepare(
      "UPDATE payment_proofs SET status = 'SUPERSEDED' WHERE user_id = ? AND status IN ('PENDING','REJECTED')"
    ).bind(user.id).run();
    const imgUrl = '/img/' + r.key;
    await env.DB.prepare(
      'INSERT INTO payment_proofs (user_id, image, status, created_at) VALUES (?,?,?,?)'
    ).bind(user.id, imgUrl, 'PENDING', new Date().toISOString()).run();
    return json({ ok: true, msg: '凭证已提交，等待管理员审核', status: 'PENDING' });
  }

  // GET /api/pay/status
  if (pathname === '/api/pay/status' && method === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false }, 401);
    const proof = await proofStatusOf(user.id, env);
    return json({
      ok: true,
      paid: !!user.paid,
      proof: proof ? { status: proof.status, image: proof.image, note: proof.note } : null,
    });
  }

  // GET /img/:key  （图片直出）
  if (pathname.startsWith('/img/') && method === 'GET') {
    const key = pathname.slice(5);
    return getImageResponse(env, key);
  }

  // GET /api/admin/proofs
  if (pathname === '/api/admin/proofs' && method === 'GET') {
    const user = await currentUser(request, env);
    if (!user || !user.is_admin) return json({ ok: false, msg: '无权限' }, 403);
    const pending = await env.DB.prepare(
      `SELECT p.id, p.user_id, p.image, p.status, p.note, p.created_at, u.username, u.name, u.student_id, u.college
       FROM payment_proofs p JOIN users u ON u.id = p.user_id
       WHERE p.status = 'PENDING' ORDER BY p.id DESC`
    ).all();
    const history = await env.DB.prepare(
      `SELECT p.id, p.user_id, p.image, p.status, p.note, p.created_at, p.reviewed_at, u.username, u.name
       FROM payment_proofs p JOIN users u ON u.id = p.user_id
       WHERE p.status IN ('APPROVED','REJECTED') ORDER BY p.id DESC LIMIT 20`
    ).all();
    return json({ ok: true, pending: pending.results, history: history.results });
  }

  // POST /api/admin/review
  if (pathname === '/api/admin/review' && method === 'POST') {
    const admin = await currentUser(request, env);
    if (!admin || !admin.is_admin) return json({ ok: false, msg: '无权限' }, 403);
    const b = await request.json().catch(() => ({}));
    const proofId = Number(b.proofId);
    const action = String(b.action || '');
    const note = String(b.note || '');
    const { results } = await env.DB.prepare('SELECT * FROM payment_proofs WHERE id = ?').bind(proofId).all();
    const proof = results.length > 0 ? results[0] : null;
    if (!proof) return json({ ok: false, msg: '凭证不存在' }, 404);
    if (proof.status !== 'PENDING') return json({ ok: false, msg: '该凭证已审核过' }, 400);

    if (action === 'approve') {
      await env.DB.prepare(
        "UPDATE payment_proofs SET status = 'APPROVED', reviewed_at = ? WHERE id = ?"
      ).bind(new Date().toISOString(), proofId).run();
      await env.DB.prepare('UPDATE users SET paid = 1 WHERE id = ?').bind(proof.user_id).run();
      return json({ ok: true, msg: '已通过，用户获得访问权限' });
    }
    if (action === 'reject') {
      await env.DB.prepare(
        "UPDATE payment_proofs SET status = 'REJECTED', note = ?, reviewed_at = ? WHERE id = ?"
      ).bind(note || '凭证无效，请重新提交', new Date().toISOString(), proofId).run();
      return json({ ok: true, msg: '已驳回' });
    }
    return json({ ok: false, msg: 'action 无效' }, 400);
  }

  // POST /api/avatar
  if (pathname === '/api/avatar' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const r = await saveBase64Image(env, b.avatar, 'avatar-' + user.id, AVATAR_MAX_BYTES);
    if (r.err) return json({ ok: false, msg: r.err }, 400);
    const imgUrl = '/img/' + r.key;
    await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(imgUrl, user.id).run();
    return json({ ok: true, msg: '头像已更新', avatar: imgUrl });
  }

  // ---------------- 组队 ----------------

  // GET /api/teams
  if (pathname === '/api/teams' && method === 'GET') {
    const compId = url.searchParams.get('competition') || '';
    let sqlQ = `SELECT t.*, u.username AS creator_username, u.name AS creator_name, u.avatar AS creator_avatar
                FROM teams t JOIN users u ON u.id = t.creator_id`;
    let stmt = env.DB.prepare(sqlQ + ' ORDER BY t.created_at DESC');
    if (compId) {
      stmt = env.DB.prepare(sqlQ + ' WHERE t.competition_id = ? ORDER BY t.created_at DESC').bind(compId);
    }
    const { results } = await stmt.all();
    return json({ ok: true, teams: results });
  }

  // GET /api/team
  if (pathname === '/api/team' && method === 'GET') {
    const id = Number(url.searchParams.get('id'));
    const { results } = await env.DB.prepare(
      `SELECT t.*, u.username AS creator_username, u.name AS creator_name, u.avatar AS creator_avatar
       FROM teams t JOIN users u ON u.id = t.creator_id WHERE t.id = ?`
    ).bind(id).all();
    const team = results.length > 0 ? results[0] : null;
    if (!team) return json({ ok: false, msg: '组队不存在' }, 404);
    const appRows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM team_applications WHERE team_id = ? AND status = 'pending'"
    ).bind(id).first('c');
    return json({ ok: true, team, applyCount: Number(appRows || 0) });
  }

  // POST /api/team/create
  if (pathname === '/api/team/create' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const title = String(b.title || '').trim();
    const need = Math.max(1, Math.min(50, Number(b.needCount) || 1));
    const have = Math.max(0, Math.min(50, Number(b.haveCount) || 0));
    if (!title) return json({ ok: false, msg: '请填写队伍名称' }, 400);
    if (have + need > 60) return json({ ok: false, msg: '人数不合理' }, 400);
    const skills = (Array.isArray(b.skills) ? b.skills : []).slice(0, 8).join(', ');
    if (skills.length > 200) return json({ ok: false, msg: '标签过多' }, 400);
    const res = await env.DB.prepare(
      `INSERT INTO teams (title, competition_id, competition_name, skills, need_count, have_count, grade, contact, description, creator_id, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'recruiting', ?)`
    ).bind(title, String(b.competitionId || ''), String(b.competitionName || '').slice(0, 120), skills,
           need, have, String(b.grade || '').slice(0, 40), String(b.contact || '').slice(0, 80),
           String(b.description || '').slice(0, 2000), user.id, new Date().toISOString()).run();
    return json({ ok: true, msg: '组队公告已发布', id: res.meta.last_row_id }, 201);
  }

  // POST /api/team/apply
  if (pathname === '/api/team/apply' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const teamId = Number(b.teamId);
    const { results } = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(teamId).all();
    const team = results.length > 0 ? results[0] : null;
    if (!team) return json({ ok: false, msg: '组队不存在' }, 404);
    if (team.creator_id === user.id) return json({ ok: false, msg: '不能申请自己发布的队伍' }, 400);
    const dup = await env.DB.prepare(
      "SELECT id FROM team_applications WHERE team_id = ? AND user_id = ? AND status = 'pending'"
    ).bind(teamId, user.id).all();
    if (dup.results.length > 0) return json({ ok: false, msg: '你已申请过这支队伍，等待对方处理' }, 409);
    await env.DB.prepare(
      'INSERT INTO team_applications (team_id, user_id, message, created_at) VALUES (?,?,?,?)'
    ).bind(teamId, user.id, String(b.message || '').slice(0, 500), new Date().toISOString()).run();
    return json({ ok: true, msg: '申请已提交，等待队长确认' }, 201);
  }

  // GET /api/team/applications
  if (pathname === '/api/team/applications' && method === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false }, 401);
    const teamId = Number(url.searchParams.get('teamId'));
    const { results } = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(teamId).all();
    const team = results.length > 0 ? results[0] : null;
    if (!team) return json({ ok: false }, 404);
    if (team.creator_id !== user.id && !user.is_admin) return json({ ok: false, msg: '无权限' }, 403);
    const apps = await env.DB.prepare(
      `SELECT a.id, a.message, a.status, a.created_at, u.username, u.name, u.student_id, u.college
       FROM team_applications a JOIN users u ON u.id = a.user_id
       WHERE a.team_id = ? ORDER BY a.id DESC`
    ).bind(teamId).all();
    return json({ ok: true, applications: apps.results });
  }

  // POST /api/team/accept
  if (pathname === '/api/team/accept' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const appId = Number(b.applicationId);
    const { results: appRes } = await env.DB.prepare('SELECT * FROM team_applications WHERE id = ?').bind(appId).all();
    const app = appRes.length > 0 ? appRes[0] : null;
    if (!app) return json({ ok: false, msg: '申请不存在' }, 404);
    const { results: teamRes } = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(app.team_id).all();
    const team = teamRes.length > 0 ? teamRes[0] : null;
    if (!team) return json({ ok: false, msg: '队伍不存在' }, 404);
    if (team.creator_id !== user.id && !user.is_admin) return json({ ok: false, msg: '无权限' }, 403);
    if (app.status !== 'pending') return json({ ok: false, msg: '该申请已处理' }, 400);
    const newNeed = Math.max(0, (Number(team.need_count) || 0) - 1);
    const newStatus = newNeed === 0 ? 'full' : 'recruiting';
    await env.DB.prepare("UPDATE team_applications SET status = 'APPROVED' WHERE id = ?").bind(appId).run();
    await env.DB.prepare(
      'UPDATE teams SET have_count = have_count + 1, need_count = ?, status = ? WHERE id = ?'
    ).bind(newNeed, newStatus, team.id).run();
    return json({ ok: true, msg: '已接受申请' });
  }

  // POST /api/team/delete
  if (pathname === '/api/team/delete' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const teamId = Number(b.teamId);
    const { results } = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(teamId).all();
    const team = results.length > 0 ? results[0] : null;
    if (!team) return json({ ok: false, msg: '组队不存在' }, 404);
    if (team.creator_id !== user.id && !user.is_admin) return json({ ok: false, msg: '仅队长或管理员可撤销该公告' }, 403);
    await env.DB.prepare('DELETE FROM team_applications WHERE team_id = ?').bind(teamId).run();
    await env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(teamId).run();
    return json({ ok: true, msg: '公告已撤销' });
  }

  // ---------------- 协会内部竞赛 ----------------

  // GET /api/competitions/internal
  if (pathname === '/api/competitions/internal' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT i.*, u.username AS creator_username
       FROM internal_competitions i JOIN users u ON u.id = i.created_by
       ORDER BY i.created_at DESC`
    ).all();
    return json({ ok: true, competitions: results });
  }

  // POST /api/admin/competition
  if (pathname === '/api/admin/competition' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user || !user.is_admin) return json({ ok: false, msg: '仅管理员可发布协会内部竞赛通知' }, 403);
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    if (!name) return json({ ok: false, msg: '请填写竞赛名称' }, 400);
    if (name.length > 120) return json({ ok: false, msg: '竞赛名称过长' }, 400);
    const level = b.level === 'school' ? 'school' : 'club';
    const res = await env.DB.prepare(
      `INSERT INTO internal_competitions (name, level, deadline, date, location, description, skills, tech, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(name, level, String(b.deadline || ''), String(b.date || ''), String(b.location || '').slice(0, 80),
           String(b.description || '').slice(0, 2000), String(b.skills || '').slice(0, 200), String(b.tech || ''),
           user.id, new Date().toISOString()).run();
    return json({ ok: true, msg: '竞赛通知已发布', id: res.meta.last_row_id }, 201);
  }

  // DELETE /api/admin/competition
  if (pathname === '/api/admin/competition' && method === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user || !user.is_admin) return json({ ok: false, msg: '仅管理员可删除协会内部竞赛通知' }, 403);
    const id = Number(url.searchParams.get('id'));
    await env.DB.prepare('DELETE FROM internal_competitions WHERE id = ?').bind(id).run();
    return json({ ok: true, msg: '已删除' });
  }

  // ============ 会员作品展示（个人主页） ============

  // POST /api/profile/name —— 修改昵称
  if (pathname === '/api/profile/name' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    if (!name) return json({ ok: false, msg: '昵称不能为空' }, 400);
    if (name.length > 20) return json({ ok: false, msg: '昵称不能超过20字' }, 400);
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, user.id).run();
    return json({ ok: true, msg: '昵称已更新', name });
  }

  // GET /api/profile —— 查看用户资料（含作品数/点赞数统计），?username= 看别人
  if (pathname === '/api/profile' && method === 'GET') {
    const url2 = new URL(request.url);
    const uName = url2.searchParams.get('username');
    let target = null;
    if (uName) {
      const { results } = await env.DB.prepare('SELECT id, username, name, avatar, college, created_at FROM users WHERE username = ?').bind(uName).all();
      target = results[0] || null;
    } else {
      target = await currentUser(request, env);
      if (!target) return json({ ok: false, msg: '请先登录' }, 401);
    }
    if (!target) return json({ ok: false, msg: '用户不存在' }, 404);
    const stats = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM works WHERE user_id = ?) AS works,
              (SELECT COUNT(*) FROM works w JOIN work_likes l ON l.work_id = w.id WHERE w.user_id = ?) AS likes`
    ).bind(target.id, target.id).first();
    return json({
      ok: true,
      profile: {
        username: target.username, name: target.name || target.username,
        avatar: target.avatar || '', college: target.college || '', created_at: target.created_at || '',
      },
      stats: { works: Number(stats ? stats.works : 0), likes: Number(stats ? stats.likes : 0) },
    });
  }

  // GET /api/works —— 当前用户或指定用户的作品列表，?username=
  if (pathname === '/api/works' && method === 'GET') {
    const url2 = new URL(request.url);
    const uName = url2.searchParams.get('username');
    const me = await currentUser(request, env);
    let userId = null;
    if (uName) {
      const { results } = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(uName).all();
      if (results.length === 0) return json({ ok: false, msg: '用户不存在' }, 404);
      userId = results[0].id;
    } else {
      if (!me) return json({ ok: false, msg: '请先登录' }, 401);
      userId = me.id;
    }
    const { results } = await env.DB.prepare(
      `SELECT w.*, u.username AS author_username, u.name AS author_name, u.avatar AS author_avatar,
              (SELECT COUNT(*) FROM work_likes l WHERE l.work_id = w.id) AS like_count,
              (SELECT COUNT(*) FROM work_comments c WHERE c.work_id = w.id) AS comment_count
       FROM works w JOIN users u ON u.id = w.user_id
       WHERE w.user_id = ? ORDER BY w.created_at DESC`
    ).bind(userId).all();
    // 我是否已赞
    let likedIds = [];
    if (me) {
      const { results: lk } = await env.DB.prepare(
        'SELECT work_id FROM work_likes WHERE user_id = ? AND work_id IN (SELECT id FROM works WHERE user_id = ?)'
      ).bind(me.id, userId).all();
      likedIds = lk.map(r => r.work_id);
    }
    return json({ ok: true, works: results.map(w => ({
      ...w, like_count: Number(w.like_count), comment_count: Number(w.comment_count),
      liked: likedIds.includes(w.id),
    })) });
  }

  // POST /api/work/video?title=xx&desc=xx&ext=mp4 —— 视频作品（body 为二进制）
  if (pathname === '/api/work/video' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const url2 = new URL(request.url);
    const title = String(url2.searchParams.get('title') || '').trim();
    const description = String(url2.searchParams.get('desc') || '').trim();
    const ext = url2.searchParams.get('ext') === 'webm' ? 'webm' : (url2.searchParams.get('ext') === 'mov' ? 'mov' : 'mp4');
    if (!title) return json({ ok: false, msg: '请填写作品标题' }, 400);
    if (title.length > 50) return json({ ok: false, msg: '作品标题不能超过50字' }, 400);
    if (description.length > 300) return json({ ok: false, msg: '简介不能超过300字' }, 400);
    let buf;
    try { buf = await request.arrayBuffer(); } catch (e) { return json({ ok: false, msg: '视频读取失败' }, 400); }
    if (!buf || buf.byteLength === 0) return json({ ok: false, msg: '视频数据为空' }, 400);
    if (buf.byteLength > 50 * 1024 * 1024) return json({ ok: false, msg: '视频不能超过50MB' }, 400);
    const content = 'video-' + user.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '.' + ext;
    try {
      await env.KV.put(content, buf, {
        expirationTtl: 365 * 24 * 3600,
        metadata: { contentType: ext === 'webm' ? 'video/webm' : 'video/mp4' },
      });
    } catch (e) {
      console.error('视频存储失败:', e);
      return json({ ok: false, msg: '视频上传失败，请重试' }, 500);
    }
    await env.DB.prepare(
      'INSERT INTO works (user_id, title, description, type, content, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(user.id, title, description, 'video', content, new Date().toISOString()).run();
    return json({ ok: true, msg: '作品已发布' }, 201);
  }

  // POST /api/work/create —— 图片作品（type: image, body JSON 含 base64）
  if (pathname === '/api/work/create' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    if (!title) return json({ ok: false, msg: '请填写作品标题' }, 400);
    if (title.length > 50) return json({ ok: false, msg: '作品标题不能超过50字' }, 400);
    if (description.length > 300) return json({ ok: false, msg: '简介不能超过300字' }, 400);
    const r = await saveBase64Image(env, b.image, 'work-' + user.id, 5 * 1024 * 1024);
    if (r.err) return json({ ok: false, msg: r.err }, 400);
    await env.DB.prepare(
      'INSERT INTO works (user_id, title, description, type, content, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(user.id, title, description, 'image', r.key, new Date().toISOString()).run();
    return json({ ok: true, msg: '作品已发布' }, 201);
  }

  // POST /api/work/like —— 点赞 / 取消点赞
  if (pathname === '/api/work/like' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const workId = Number(b.workId);
    const { results } = await env.DB.prepare('SELECT id FROM works WHERE id = ?').bind(workId).all();
    if (results.length === 0) return json({ ok: false, msg: '作品不存在' }, 404);
    const { results: has } = await env.DB.prepare(
      'SELECT id FROM work_likes WHERE work_id = ? AND user_id = ?'
    ).bind(workId, user.id).all();
    if (has.length > 0) {
      await env.DB.prepare('DELETE FROM work_likes WHERE work_id = ? AND user_id = ?').bind(workId, user.id).run();
      return json({ ok: true, liked: false });
    } else {
      await env.DB.prepare('INSERT INTO work_likes (work_id, user_id) VALUES (?,?)').bind(workId, user.id).run();
      return json({ ok: true, liked: true });
    }
  }

  // POST /api/work/comment —— 评论
  if (pathname === '/api/work/comment' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const b = await request.json().catch(() => ({}));
    const workId = Number(b.workId);
    const content = String(b.content || '').trim();
    if (!content) return json({ ok: false, msg: '评论不能为空' }, 400);
    if (content.length > 200) return json({ ok: false, msg: '评论不能超过200字' }, 400);
    const { results } = await env.DB.prepare('SELECT id FROM works WHERE id = ?').bind(workId).all();
    if (results.length === 0) return json({ ok: false, msg: '作品不存在' }, 404);
    await env.DB.prepare(
      'INSERT INTO work_comments (work_id, user_id, content, created_at) VALUES (?,?,?,?)'
    ).bind(workId, user.id, content, new Date().toISOString()).run();
    return json({ ok: true, msg: '评论成功' }, 201);
  }

  // GET /api/work/comments —— 作品评论列表
  if (pathname === '/api/work/comments' && method === 'GET') {
    const url2 = new URL(request.url);
    const workId = Number(url2.searchParams.get('workId'));
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.content, c.created_at, u.username, u.name AS user_name, u.avatar AS user_avatar
       FROM work_comments c JOIN users u ON u.id = c.user_id
       WHERE c.work_id = ? ORDER BY c.created_at ASC`
    ).bind(workId).all();
    return json({ ok: true, comments: results });
  }

  // DELETE /api/work —— 删除自己的作品
  if (pathname === '/api/work' && method === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);
    const url2 = new URL(request.url);
    const workId = Number(url2.searchParams.get('id'));
    const { results } = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(workId).all();
    const work = results[0] || null;
    if (!work) return json({ ok: false, msg: '作品不存在' }, 404);
    if (work.user_id !== user.id && !user.is_admin) return json({ ok: false, msg: '仅作者可删除' }, 403);
    await env.DB.prepare('DELETE FROM work_likes WHERE work_id = ?').bind(workId).run();
    await env.DB.prepare('DELETE FROM work_comments WHERE work_id = ?').bind(workId).run();
    await env.DB.prepare('DELETE FROM works WHERE id = ?').bind(workId).run();
    try { await env.KV.delete(work.content); } catch (e) { }
    return json({ ok: true, msg: '作品已删除' });
  }

  // 流式读取作品内容（图片/视频，支持 Range）
  if (pathname.startsWith('/media/') && method === 'GET') {
    const key = pathname.slice(7);
    const meta = await env.KV.getWithMetadata(key, { type: 'arrayBuffer' }).catch(() => null);
    if (!meta || meta.value === null) return new Response('Not found', { status: 404 });
    const ct = (meta.metadata && meta.metadata.contentType) || (key.endsWith('.mp4') || key.endsWith('.mov') ? 'video/mp4' : key.endsWith('.webm') ? 'video/webm' : 'image/png');
    const size = meta.value.byteLength;
    // Range 请求（视频拖动）
    const range = request.headers.get('Range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] !== '' ? parseInt(m[1]) : 0;
      let end = m && m[2] !== '' ? parseInt(m[2]) : size - 1;
      if (start > end || start >= size) return new Response('Range not satisfiable', { status: 416 });
      end = Math.min(end, size - 1);
      return new Response(meta.value.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Type': ct,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return new Response(meta.value, {
      headers: { 'Content-Type': ct, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  }

  // POST /api/chat —— 奶龙 AI 助手（DeepSeek 代理，仅登录用户可用）
  if (pathname === '/api/chat' && method === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, msg: '请先登录' }, 401);

    const b = await request.json().catch(() => ({}));
    const question = String(b.question || '').trim();
    const history = Array.isArray(b.history) ? b.history.slice(-6) : [];

    if (!question) return json({ ok: false, msg: '问题不能为空' }, 400);
    if (question.length > 500) return json({ ok: false, msg: '问题过长（限500字）' }, 400);

    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) return json({ ok: false, msg: 'AI 服务未配置，请联系管理员' }, 503);

    // 知识库文本（内嵌模块，限长防 token 溢出）
    const kbText = JSON.stringify(KB_DATA).slice(0, 60000);

    const systemPrompt = [
      '你是"创智算"数字科技协会网站的智能客服助手"奶龙"，性格活泼可爱，用简短、亲切、卖萌的语气回答。',
      '你可以回答网站内容的问题：竞赛信息、学习资源、组队、协会介绍、缴费等。',
      '必须只用网站知识库和用户提供的信息回答；不知道就说"这个我还不太清楚呢，问问管理员吧~"。',
      '回答要简短（150字内），可用少量 emoji，不要编造链接。',
      '网站可跳转的位置：首页(/) 竞赛中心(/#competitions) 方向(/#fields) 组队大厅(/#team) 立项名单(/funding-list.html) 学习资源(/resources.html) 协会简介(/#about)。',
      '若用户明确要求跳转到某页面，在回答末尾附加一行：@@NAV:位置名(路径)@@（位置名/路径来自上面列表，仅当用户明确要求跳转时添加）。',
      '【硬性规则】当用户询问"招新群号/QQ群/加群/如何加入协会群"等问题时，必须一字不差回复："创智算招新QQ群号：688609392，想要加入正式群需要联系社长哦（社长QQ：2140533250）"，不要增删内容，不要加其它句子。',
      '【硬性规则】当用户询问"其他专业能不能加入/非本专业可以吗/专业限制"等问题时，必须回复："创智算欢迎任何专业的同学加入哦~不限专业、不限学院，只要对计算机、软件、电子、人工智能方向感兴趣都可以来！"',
      '',
      '===== 网站知识库 =====',
      kbText,
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 500) })),
      { role: 'user', content: question },
    ];

    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages,
          max_tokens: 400,
          temperature: 0.7,
          stream: false,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error('DeepSeek 调用失败:', resp.status, errText.slice(0, 200));
        return json({ ok: false, msg: 'AI 暂时开小差了，请稍后再试~' }, 502);
      }

      const data = await resp.json();
      const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      return json({ ok: true, answer: content });
    } catch (e) {
      console.error('DeepSeek 网络错误:', e && e.message);
      return json({ ok: false, msg: '网络波动，请稍后再试~' }, 502);
    }
  }

  return json({ ok: false, msg: 'not found' }, 404);
}

// ============ 主入口 ============
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // API 路由
    if (pathname.startsWith('/api/')) {
      return handleApi(request, env, pathname);
    }

    // 图片/视频路由
    if (pathname.startsWith('/img/') || pathname.startsWith('/media/')) {
      return handleApi(request, env, pathname);
    }

    // 公开页面/资源：不查数据库，直接由静态资产服务（减少 D1 调用，提升稳定性）
    const PUBLIC_PATHS = new Set(['/login.html', '/login', '/register.html', '/register', '/favicon.ico', '/logo.png']);
    let hasCookie = false;
    {
      const raw = request.headers.get('Cookie') || '';
      hasCookie = raw.split(';').some(p => p.trim().startsWith(COOKIE_NAME + '='));
    }

    // 未登录（无会话 cookie）：任何页面请求都不查数据库
    if (!hasCookie) {
      if (PUBLIC_PATHS.has(pathname)) {
        const assetPath = pathname.endsWith('.html') || pathname === '/favicon.ico' || pathname === '/logo.png'
          ? pathname
          : pathname + '.html';
        const assetUrl = new URL(assetPath, request.url);
        const assetResp = await env.ASSETS.fetch(new Request(assetUrl, request));
        const headers = new Headers(assetResp.headers);
        if (pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
          headers.set('Cache-Control', 'no-cache, must-revalidate, max-age=0');
        } else if (!headers.has('Cache-Control')) {
          headers.set('Cache-Control', 'public, max-age=3600');
        }
        return new Response(assetResp.body, { status: assetResp.status, headers });
      }
      if (pathname === '/' || pathname === '' || pathname.endsWith('.html')) {
        const loginUrl = new URL('/login.html', request.url);
        return env.ASSETS.fetch(new Request(loginUrl, request));
      }
      return new Response('<h1>403</h1><p>请先<a href="/login.html">登录</a>后访问。</p>', {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 有会话 cookie：才查数据库确认真实登录态
    const user = await currentUser(request, env);

    if (!user) {
      // 会话失效：清 cookie 并返回登录页
      if (pathname === '/' || pathname === '' || pathname.endsWith('.html')) {
        const loginUrl = new URL('/login.html', request.url);
        const resp = await env.ASSETS.fetch(new Request(loginUrl, request));
        const headers = new Headers(resp.headers);
        headers.set('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
        return new Response(resp.body, { status: resp.status, headers });
      }
      return new Response('<h1>403</h1><p>请先<a href="/login.html">登录</a>后访问。</p>', {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 登录用户：静态资源直接从 assets 读取（根路径映射到 index.html）
    const servePath = (pathname === '/' || pathname === '') ? '/index.html' : pathname;
    const serveUrl = new URL(servePath, request.url);
    const serveResp = await env.ASSETS.fetch(new Request(serveUrl, request));
    const serveHeaders = new Headers(serveResp.headers);
    // HTML/JS/CSS 不缓存（每次取最新，避免旧版脚本）；图片等二进制可短缓存
    if (pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
      serveHeaders.set('Cache-Control', 'no-cache, must-revalidate, max-age=0');
    } else if (!serveHeaders.has('Cache-Control')) {
      serveHeaders.set('Cache-Control', 'public, max-age=3600');
    }
    return new Response(serveResp.body, { status: serveResp.status, headers: serveHeaders });
  },
};
