let mysql;
try {
  mysql = require("mysql2/promise");
} catch (error) {
  throw new Error("Missing dependency mysql2. Run: npm.cmd install");
}

let pool;
let defaultModel = "GPT-IMAGE-2";

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(process.env[name]).toLowerCase());
}

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replaceAll("`", "``")}\``;
}

function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: intEnv("MYSQL_PORT", 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "gpt_image_studio",
    connectionLimit: intEnv("MYSQL_CONNECTION_LIMIT", 10)
  };
}

function getPool() {
  if (!pool) {
    throw new Error("Database has not been initialized");
  }
  return pool;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function mapSettings(row = {}) {
  return {
    openaiApiKey: row.openai_api_key || "",
    apiBaseUrl: row.api_base_url || process.env.AI_API_BASE_URL || process.env.OPENAI_BASE_URL || "",
    model: row.model || defaultModel,
    defaultCredits: Number(row.default_credits ?? 10),
    generationCreditCost: Number(row.generation_credit_cost ?? 1),
    allowRegistration: Boolean(row.allow_registration ?? 1),
    requireApproval: Boolean(row.require_approval ?? 0),
    maxImagesPerRequest: Number(row.max_images_per_request ?? 1)
  };
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: {
      salt: row.password_salt,
      iterations: Number(row.password_iterations),
      hash: row.password_hash
    },
    role: row.role,
    status: row.status,
    credits: Number(row.credits || 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapGeneration(row) {
  if (!row) return null;
  let usage = null;
  if (row.usage_json) {
    try {
      usage = JSON.parse(row.usage_json);
    } catch {
      usage = null;
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    prompt: row.prompt,
    model: row.model,
    size: row.size,
    quality: row.quality,
    background: row.background,
    outputFormat: row.output_format,
    filename: row.filename,
    isPublic: Boolean(row.is_public ?? 0),
    revisedPrompt: row.revised_prompt || "",
    usage,
    createdAt: toIso(row.created_at)
  };
}

function mapGenerationRequest(row) {
  if (!row) return null;
  let generationIds = [];
  if (row.generation_ids) {
    try {
      generationIds = JSON.parse(row.generation_ids);
    } catch {
      generationIds = [];
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || "",
    userEmail: row.user_email || "",
    prompt: row.prompt,
    ipAddress: row.ip_address || "",
    userAgent: row.user_agent || "",
    isPublic: Boolean(row.is_public ?? 0),
    status: row.status,
    errorMessage: row.error_message || "",
    firstGenerationId: row.first_generation_id || "",
    generationIds,
    model: row.model || "",
    filename: row.filename || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

async function createDatabaseIfNeeded(config) {
  if (process.env.MYSQL_CREATE_DATABASE === "false") return;
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: false
  });
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await connection.end();
  }
}

async function runMigrations() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      openai_api_key TEXT NULL,
      api_base_url VARCHAR(255) NOT NULL DEFAULT '',
      model VARCHAR(80) NOT NULL,
      default_credits INT UNSIGNED NOT NULL DEFAULT 10,
      generation_credit_cost INT UNSIGNED NOT NULL DEFAULT 1,
      allow_registration TINYINT(1) NOT NULL DEFAULT 1,
      require_approval TINYINT(1) NOT NULL DEFAULT 0,
      max_images_per_request TINYINT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [settingsApiBaseColumns] = await db.execute("SHOW COLUMNS FROM app_settings LIKE 'api_base_url'");
  if (!settingsApiBaseColumns.length) {
    await db.query("ALTER TABLE app_settings ADD COLUMN api_base_url VARCHAR(255) NOT NULL DEFAULT '' AFTER openai_api_key");
  }

  const [settingsCostColumns] = await db.execute("SHOW COLUMNS FROM app_settings LIKE 'generation_credit_cost'");
  if (!settingsCostColumns.length) {
    await db.query("ALTER TABLE app_settings ADD COLUMN generation_credit_cost INT UNSIGNED NOT NULL DEFAULT 1 AFTER default_credits");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      name VARCHAR(60) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_salt VARCHAR(64) NOT NULL,
      password_iterations INT UNSIGNED NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      role VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      credits INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      INDEX idx_users_status (status),
      INDEX idx_users_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      user_id VARCHAR(32) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_sessions_user_id (user_id),
      INDEX idx_sessions_expires_at (expires_at),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS generations (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      user_id VARCHAR(32) NOT NULL,
      prompt TEXT NOT NULL,
      model VARCHAR(80) NOT NULL,
      size VARCHAR(20) NOT NULL,
      quality VARCHAR(20) NOT NULL,
      background VARCHAR(20) NOT NULL,
      output_format VARCHAR(20) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 0,
      revised_prompt TEXT NULL,
      usage_json LONGTEXT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_generations_user_created (user_id, created_at),
      INDEX idx_generations_created_at (created_at),
      CONSTRAINT fk_generations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [generationColumns] = await db.execute("SHOW COLUMNS FROM generations LIKE 'is_public'");
  if (!generationColumns.length) {
    await db.query("ALTER TABLE generations ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 0 AFTER filename");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_daily_usage (
      user_id VARCHAR(32) NOT NULL,
      usage_date DATE NOT NULL,
      free_used INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (user_id, usage_date),
      CONSTRAINT fk_daily_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_checkins (
      user_id VARCHAR(32) NOT NULL,
      checkin_date DATE NOT NULL,
      credits_awarded INT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (user_id, checkin_date),
      CONSTRAINT fk_user_checkins_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS generation_requests (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      user_id VARCHAR(32) NOT NULL,
      prompt TEXT NOT NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(512) NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL,
      error_message TEXT NULL,
      first_generation_id VARCHAR(32) NULL,
      generation_ids TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      INDEX idx_generation_requests_created (created_at),
      INDEX idx_generation_requests_user_created (user_id, created_at),
      INDEX idx_generation_requests_status (status),
      CONSTRAINT fk_generation_requests_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.execute(
    `INSERT IGNORE INTO app_settings
      (id, openai_api_key, api_base_url, model, default_credits, generation_credit_cost, allow_registration, require_approval, max_images_per_request)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "",
      process.env.AI_API_BASE_URL || process.env.OPENAI_BASE_URL || "",
      process.env.IMAGE_MODEL || defaultModel,
      intEnv("DEFAULT_CREDITS", 10),
      intEnv("GENERATION_CREDIT_COST", 1),
      boolEnv("ALLOW_REGISTRATION", true) ? 1 : 0,
      boolEnv("REQUIRE_APPROVAL", false) ? 1 : 0,
      intEnv("MAX_IMAGES_PER_REQUEST", 1)
    ]
  );

  const envApiBaseUrl = process.env.AI_API_BASE_URL || process.env.OPENAI_BASE_URL || "";
  if (envApiBaseUrl) {
    await db.execute(
      "UPDATE app_settings SET api_base_url = ? WHERE id = 1 AND api_base_url = ''",
      [envApiBaseUrl.replace(/\/+$/, "")]
    );
  }
}

async function initializeDatabase(options = {}) {
  defaultModel = options.defaultModel || defaultModel;
  const config = mysqlConfig();
  await createDatabaseIfNeeded(config);
  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    charset: "utf8mb4"
  });
  await runMigrations();
  await deleteExpiredSessions();
}

async function getSettings() {
  const [rows] = await getPool().execute("SELECT * FROM app_settings WHERE id = 1 LIMIT 1");
  return mapSettings(rows[0]);
}

async function updateSettings(patch) {
  const columns = [];
  const values = [];
  const mapping = {
    openaiApiKey: "openai_api_key",
    apiBaseUrl: "api_base_url",
    model: "model",
    defaultCredits: "default_credits",
    generationCreditCost: "generation_credit_cost",
    allowRegistration: "allow_registration",
    requireApproval: "require_approval",
    maxImagesPerRequest: "max_images_per_request"
  };

  for (const [key, column] of Object.entries(mapping)) {
    if (Object.hasOwn(patch, key)) {
      columns.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }

  if (columns.length) {
    values.push(1);
    await getPool().execute(`UPDATE app_settings SET ${columns.join(", ")} WHERE id = ?`, values);
  }
  return getSettings();
}

async function countUsers() {
  const [rows] = await getPool().execute("SELECT COUNT(*) AS count FROM users");
  return Number(rows[0]?.count || 0);
}

async function countAdmins() {
  const [rows] = await getPool().execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
  return Number(rows[0]?.count || 0);
}

async function getUserByEmail(email) {
  const [rows] = await getPool().execute("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
  return mapUser(rows[0]);
}

async function getUserById(id) {
  const [rows] = await getPool().execute("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
  return mapUser(rows[0]);
}

async function createUser(user) {
  const createdAt = new Date();
  await getPool().execute(
    `INSERT INTO users
      (id, name, email, password_salt, password_iterations, password_hash, role, status, credits, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      user.name,
      user.email,
      user.passwordHash.salt,
      user.passwordHash.iterations,
      user.passwordHash.hash,
      user.role,
      user.status,
      user.credits,
      createdAt,
      createdAt
    ]
  );
  return getUserById(user.id);
}

async function listUsers() {
  const [rows] = await getPool().execute("SELECT * FROM users ORDER BY created_at DESC");
  return rows.map(mapUser);
}

async function updateUser(id, patch) {
  const columns = [];
  const values = [];
  const mapping = {
    name: "name",
    role: "role",
    status: "status",
    credits: "credits"
  };

  for (const [key, column] of Object.entries(mapping)) {
    if (Object.hasOwn(patch, key)) {
      columns.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }

  if (columns.length) {
    columns.push("updated_at = ?");
    values.push(new Date(), id);
    await getPool().execute(`UPDATE users SET ${columns.join(", ")} WHERE id = ?`, values);
  }
  return getUserById(id);
}

async function reserveCredits(userId, amount) {
  const [result] = await getPool().execute(
    "UPDATE users SET credits = credits - ?, updated_at = ? WHERE id = ? AND credits >= ?",
    [amount, new Date(), userId, amount]
  );
  return result.affectedRows === 1;
}

async function addCredits(userId, amount) {
  if (amount <= 0) return;
  await getPool().execute("UPDATE users SET credits = credits + ?, updated_at = ? WHERE id = ?", [
    amount,
    new Date(),
    userId
  ]);
}

async function adjustCredits(userId, delta) {
  const amount = Number(delta) || 0;
  if (!amount) return getUserById(userId);
  if (amount > 0) {
    await addCredits(userId, amount);
  } else {
    const deduction = Math.abs(amount);
    await getPool().execute(
      "UPDATE users SET credits = IF(credits < ?, 0, credits - ?), updated_at = ? WHERE id = ?",
      [deduction, deduction, new Date(), userId]
    );
  }
  return getUserById(userId);
}

async function hasCheckedInToday(userId) {
  const [rows] = await getPool().execute(
    "SELECT user_id FROM user_checkins WHERE user_id = ? AND checkin_date = CURRENT_DATE() LIMIT 1",
    [userId]
  );
  return rows.length > 0;
}

async function checkInToday(userId, creditAmount = 1) {
  const amount = Math.max(1, Number(creditAmount) || 1);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [insertResult] = await connection.execute(
      "INSERT IGNORE INTO user_checkins (user_id, checkin_date, credits_awarded) VALUES (?, CURRENT_DATE(), ?)",
      [userId, amount]
    );
    if (insertResult.affectedRows === 0) {
      const [rows] = await connection.execute("SELECT credits FROM users WHERE id = ? LIMIT 1", [userId]);
      await connection.rollback();
      return { checkedIn: false, credits: Number(rows[0]?.credits || 0) };
    }
    await connection.execute("UPDATE users SET credits = credits + ?, updated_at = ? WHERE id = ?", [
      amount,
      new Date(),
      userId
    ]);
    const [rows] = await connection.execute("SELECT credits FROM users WHERE id = ? LIMIT 1", [userId]);
    await connection.commit();
    return { checkedIn: true, credits: Number(rows[0]?.credits || 0) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function reserveDailyFreeGeneration(userId, freeLimit) {
  const limit = Math.max(0, Number(freeLimit) || 0);
  if (!limit) return false;
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT free_used FROM user_daily_usage WHERE user_id = ? AND usage_date = CURRENT_DATE() FOR UPDATE",
      [userId]
    );
    const used = Number(rows[0]?.free_used || 0);
    if (!rows.length) {
      await connection.execute(
        "INSERT INTO user_daily_usage (user_id, usage_date, free_used) VALUES (?, CURRENT_DATE(), 1)",
        [userId]
      );
      await connection.commit();
      return true;
    }
    if (used >= limit) {
      await connection.rollback();
      return false;
    }
    await connection.execute(
      "UPDATE user_daily_usage SET free_used = free_used + 1 WHERE user_id = ? AND usage_date = CURRENT_DATE()",
      [userId]
    );
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function refundDailyFreeGeneration(userId) {
  await getPool().execute(
    "UPDATE user_daily_usage SET free_used = GREATEST(free_used - 1, 0) WHERE user_id = ? AND usage_date = CURRENT_DATE()",
    [userId]
  );
}

async function getDailyFreeUsed(userId) {
  const [rows] = await getPool().execute(
    "SELECT free_used FROM user_daily_usage WHERE user_id = ? AND usage_date = CURRENT_DATE() LIMIT 1",
    [userId]
  );
  return Number(rows[0]?.free_used || 0);
}

async function getUserCredits(userId) {
  const [rows] = await getPool().execute("SELECT credits FROM users WHERE id = ? LIMIT 1", [userId]);
  return Number(rows[0]?.credits || 0);
}

async function createSession(tokenHash, userId, expiresAt) {
  await getPool().execute(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [tokenHash, userId, expiresAt, new Date()]
  );
}

async function deleteSession(tokenHash) {
  if (!tokenHash) return;
  await getPool().execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
}

async function touchSession(tokenHash, expiresAt) {
  await getPool().execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", [expiresAt, tokenHash]);
}

async function getSessionUser(tokenHash) {
  const [rows] = await getPool().execute(
    `SELECT u.*
       FROM sessions s
       INNER JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'
      LIMIT 1`,
    [tokenHash, new Date()]
  );
  return mapUser(rows[0]);
}

async function deleteExpiredSessions() {
  await getPool().execute("DELETE FROM sessions WHERE expires_at <= ?", [new Date()]);
}

async function insertGenerations(generations) {
  if (!generations.length) return;
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    for (const generation of generations) {
      await connection.execute(
        `INSERT INTO generations
          (id, user_id, prompt, model, size, quality, background, output_format, filename, is_public, revised_prompt, usage_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generation.id,
          generation.userId,
          generation.prompt,
          generation.model,
          generation.size,
          generation.quality,
          generation.background,
          generation.outputFormat,
          generation.filename,
          generation.isPublic ? 1 : 0,
          generation.revisedPrompt || "",
          generation.usage ? JSON.stringify(generation.usage) : null,
          new Date(generation.createdAt)
        ]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function insertGenerationRequest(request) {
  const createdAt = new Date();
  await getPool().execute(
    `INSERT INTO generation_requests
      (id, user_id, prompt, ip_address, user_agent, is_public, status, error_message, first_generation_id, generation_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      request.userId,
      request.prompt,
      request.ipAddress || "",
      request.userAgent || "",
      request.isPublic ? 1 : 0,
      request.status || "pending",
      request.errorMessage || null,
      request.firstGenerationId || null,
      request.generationIds ? JSON.stringify(request.generationIds) : null,
      createdAt,
      createdAt
    ]
  );
}

async function updateGenerationRequest(id, patch) {
  const columns = [];
  const values = [];
  const mapping = {
    status: "status",
    errorMessage: "error_message",
    firstGenerationId: "first_generation_id"
  };

  for (const [key, column] of Object.entries(mapping)) {
    if (Object.hasOwn(patch, key)) {
      columns.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }
  if (Object.hasOwn(patch, "generationIds")) {
    columns.push("generation_ids = ?");
    values.push(JSON.stringify(patch.generationIds || []));
  }
  if (!columns.length) return;
  columns.push("updated_at = ?");
  values.push(new Date(), id);
  await getPool().execute(`UPDATE generation_requests SET ${columns.join(", ")} WHERE id = ?`, values);
}

async function listGenerationRequests(limit = 100) {
  const normalizedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await getPool().execute(
    `SELECT gr.*, u.name AS user_name, u.email AS user_email, g.model, g.filename
       FROM generation_requests gr
       LEFT JOIN users u ON u.id = gr.user_id
       LEFT JOIN generations g ON g.id = gr.first_generation_id
      ORDER BY gr.created_at DESC
      LIMIT ${normalizedLimit}`
  );
  return rows.map(mapGenerationRequest);
}

async function listGenerationsForUser(user, limit = 60) {
  const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 60));
  const sql =
    user.role === "admin"
      ? `SELECT * FROM generations ORDER BY created_at DESC LIMIT ${normalizedLimit}`
      : `SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ${normalizedLimit}`;
  const params = user.role === "admin" ? [] : [user.id];
  const [rows] = await getPool().execute(sql, params);
  return rows.map(mapGeneration);
}

async function listPublicGenerations(limit = 60) {
  const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 60));
  const [rows] = await getPool().execute(
    `SELECT * FROM generations WHERE is_public = 1 ORDER BY created_at DESC LIMIT ${normalizedLimit}`
  );
  return rows.map(mapGeneration);
}

async function getGenerationById(id) {
  const [rows] = await getPool().execute("SELECT * FROM generations WHERE id = ? LIMIT 1", [id]);
  return mapGeneration(rows[0]);
}

async function countTodayGenerations() {
  const [rows] = await getPool().execute(
    "SELECT COUNT(*) AS count FROM generations WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)"
  );
  return Number(rows[0]?.count || 0);
}

module.exports = {
  initializeDatabase,
  getSettings,
  updateSettings,
  countUsers,
  countAdmins,
  getUserByEmail,
  getUserById,
  createUser,
  listUsers,
  updateUser,
  reserveCredits,
  addCredits,
  adjustCredits,
  hasCheckedInToday,
  checkInToday,
  reserveDailyFreeGeneration,
  refundDailyFreeGeneration,
  getDailyFreeUsed,
  getUserCredits,
  createSession,
  deleteSession,
  touchSession,
  getSessionUser,
  insertGenerations,
  insertGenerationRequest,
  updateGenerationRequest,
  listGenerationRequests,
  listGenerationsForUser,
  listPublicGenerations,
  getGenerationById,
  countTodayGenerations
};
