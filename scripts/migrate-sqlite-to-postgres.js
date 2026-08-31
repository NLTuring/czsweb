// ============================================================
// 数据迁移脚本：SQLite → PostgreSQL（Neon）
// ------------------------------------------------------------
// 使用方式：
//   1. 安装依赖：npm install
//   2. 设置环境变量：DATABASE_URL（Neon 连接字符串）
//   3. 运行：node scripts/migrate-sqlite-to-postgres.js
//
// 说明：
//   - 默认迁移 users、sessions、teams、team_applications、
//     payment_proofs、internal_competitions 六张表
//   - 密码哈希和 salt 直接平移，无需重新加密
//   - 使用 INSERT ... ON CONFLICT DO NOTHING 避免重复导入
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const { neon } = require('@neondatabase/serverless');
const path = require('path');

const SQLITE_DB = path.join(__dirname, '..', 'users.db');
const sql = neon(process.env.DATABASE_URL, { fetchConnectionCache: true });

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('错误：请设置 DATABASE_URL 环境变量（Neon 连接字符串）');
    process.exit(1);
  }

  console.log('读取 SQLite 数据库:', SQLITE_DB);
  const db = new DatabaseSync(SQLITE_DB);

  const tables = [
    'users',
    'sessions',
    'teams',
    'team_applications',
    'payment_proofs',
    'internal_competitions',
  ];

  for (const table of tables) {
    console.log('迁移表:', table);
    const rows = db.prepare('SELECT * FROM ' + table).all();
    console.log('  读取到', rows.length, '条记录');

    if (rows.length === 0) continue;

    if (table === 'users') {
      for (const row of rows) {
        await sql`
          INSERT INTO users (id, username, password_hash, salt, name, student_id, college, paid, avatar, is_admin, created_at)
          VALUES (${row.id}, ${row.username}, ${row.password_hash}, ${row.salt}, ${row.name}, ${row.student_id}, ${row.college}, ${row.paid}, ${row.avatar}, ${row.is_admin}, ${row.created_at})
          ON CONFLICT (username) DO NOTHING
        `;
      }
    } else if (table === 'sessions') {
      for (const row of rows) {
        await sql`
          INSERT INTO sessions (token, user_id, expires_at)
          VALUES (${row.token}, ${row.user_id}, ${row.expires_at})
          ON CONFLICT (token) DO NOTHING
        `;
      }
    } else if (table === 'teams') {
      for (const row of rows) {
        await sql`
          INSERT INTO teams (id, title, competition_id, competition_name, skills, need_count, have_count, grade, contact, description, creator_id, status, created_at)
          VALUES (${row.id}, ${row.title}, ${row.competition_id}, ${row.competition_name}, ${row.skills}, ${row.need_count}, ${row.have_count}, ${row.grade}, ${row.contact}, ${row.description}, ${row.creator_id}, ${row.status}, ${row.created_at})
          ON CONFLICT (id) DO NOTHING
        `;
      }
    } else if (table === 'team_applications') {
      for (const row of rows) {
        await sql`
          INSERT INTO team_applications (id, team_id, user_id, message, status, created_at)
          VALUES (${row.id}, ${row.team_id}, ${row.user_id}, ${row.message}, ${row.status}, ${row.created_at})
          ON CONFLICT (id) DO NOTHING
        `;
      }
    } else if (table === 'payment_proofs') {
      for (const row of rows) {
        await sql`
          INSERT INTO payment_proofs (id, user_id, image, status, note, created_at, reviewed_at)
          VALUES (${row.id}, ${row.user_id}, ${row.image}, ${row.status}, ${row.note}, ${row.created_at}, ${row.reviewed_at})
          ON CONFLICT (id) DO NOTHING
        `;
      }
    } else if (table === 'internal_competitions') {
      for (const row of rows) {
        await sql`
          INSERT INTO internal_competitions (id, name, level, deadline, date, location, description, skills, tech, created_by, created_at)
          VALUES (${row.id}, ${row.name}, ${row.level}, ${row.deadline}, ${row.date}, ${row.location}, ${row.description}, ${row.skills}, ${row.tech}, ${row.created_by}, ${row.created_at})
          ON CONFLICT (id) DO NOTHING
        `;
      }
    }
  }

  // 重置序列（PostgreSQL 自增 ID）
  console.log('重置 PostgreSQL 自增序列...');
  await sql`SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1), false) FROM users`;
  await sql`SELECT setval(pg_get_serial_sequence('payment_proofs', 'id'), COALESCE(MAX(id), 1), false) FROM payment_proofs`;
  await sql`SELECT setval(pg_get_serial_sequence('teams', 'id'), COALESCE(MAX(id), 1), false) FROM teams`;
  await sql`SELECT setval(pg_get_serial_sequence('team_applications', 'id'), COALESCE(MAX(id), 1), false) FROM team_applications`;
  await sql`SELECT setval(pg_get_serial_sequence('internal_competitions', 'id'), COALESCE(MAX(id), 1), false) FROM internal_competitions`;

  console.log('迁移完成！');
}

migrate().catch((err) => {
  console.error('迁移失败:', err);
  process.exit(1);
});
