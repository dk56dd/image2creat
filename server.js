const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fsSync = require("fs");
const { promises: fs } = fsSync;

const ROOT_DIR = __dirname;

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const raw = fsSync.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT_DIR, ".env"));

const store = require("./src/mysql-store");

const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, "data"));
const GENERATED_DIR = path.join(DATA_DIR, "generated");
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MODEL = "GPT-IMAGE-2";
const CHECKIN_CREDIT = Number.parseInt(process.env.CHECKIN_CREDIT || "1", 10) || 1;

const generationWindows = new Map();

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ico", "image/x-icon"]
]);

function httpError(message, status = 400, details) {
  return Object.assign(new Error(message), { status, details });
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = "") {
  return `${prefix}${crypto.randomBytes(12).toString("hex")}`;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        if (index === -1) return [pair, ""];
        return [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      })
  );
}

async function createSession(userId) {
  const token = randomId("sess_");
  await store.createSession(hashSessionToken(token), userId, new Date(Date.now() + SESSION_TTL_MS));
  return token;
}

async function destroySession(token) {
  if (!token) return;
  await store.deleteSession(hashSessionToken(token)).catch(() => null);
}

async function getCurrentUser(req) {
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const user = await store.getSessionUser(tokenHash);
  if (!user) {
    await store.deleteSession(tokenHash).catch(() => null);
    return null;
  }

  await store.touchSession(tokenHash, new Date(Date.now() + SESSION_TTL_MS));
  return { user };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const iterations = 210000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return { salt, iterations, hash };
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash?.salt || !passwordHash?.hash || !passwordHash?.iterations) return false;
  const hash = crypto
    .pbkdf2Sync(password, passwordHash.salt, passwordHash.iterations, 32, "sha256")
    .toString("hex");
  return timingSafeEqual(hash, passwordHash.hash);
}

function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    credits: user.credits,
    createdAt: user.createdAt
  };
}

function getOpenAIApiKey(settings) {
  return settings.openaiApiKey || process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
}

function getOpenAIBaseUrl(settings = {}) {
  return String(settings.apiBaseUrl || process.env.AI_API_BASE_URL || process.env.OPENAI_BASE_URL || "").trim().replace(/\/+$/, "");
}

function getOpenAIImageEndpoint(settings = {}) {
  const cleanBase = getOpenAIBaseUrl(settings);
  if (!cleanBase) throw httpError("AI API base URL is not configured", 400);
  if (cleanBase.endsWith("/images/generations")) return cleanBase;
  if (cleanBase.endsWith("/v1")) return `${cleanBase}/images/generations`;
  return `${cleanBase}/v1/images/generations`;
}

function getOpenAIResponsesEndpoint(settings = {}) {
  const cleanBase = getOpenAIBaseUrl(settings);
  if (!cleanBase) throw httpError("AI API base URL is not configured", 400);
  if (cleanBase.endsWith("/responses")) return cleanBase;
  if (cleanBase.endsWith("/images/generations")) return cleanBase.replace(/\/images\/generations$/, "/responses");
  if (cleanBase.endsWith("/v1")) return `${cleanBase}/responses`;
  return `${cleanBase}/v1/responses`;
}

function getOpenAIEditEndpoint(settings = {}) {
  const cleanBase = getOpenAIBaseUrl(settings);
  if (!cleanBase) throw httpError("AI API base URL is not configured", 400);
  if (cleanBase.endsWith("/images/edits")) return cleanBase;
  if (cleanBase.endsWith("/images/generations")) return cleanBase.replace(/\/images\/generations$/, "/images/edits");
  if (cleanBase.endsWith("/v1")) return `${cleanBase}/images/edits`;
  return `${cleanBase}/v1/images/edits`;
}

function publicSettings(settings) {
  return {
    hasApiKey: Boolean(getOpenAIApiKey(settings) && getOpenAIBaseUrl(settings)),
    model: settings.model || DEFAULT_MODEL,
    allowRegistration: Boolean(settings.allowRegistration),
    requireApproval: Boolean(settings.requireApproval),
    defaultCredits: Number(settings.defaultCredits || 0),
    generationCreditCost: Number(settings.generationCreditCost ?? 1),
    checkinCredit: CHECKIN_CREDIT,
    maxImagesPerRequest: Number(settings.maxImagesPerRequest || 1)
  };
}

function adminSettings(settings) {
  const key = getOpenAIApiKey(settings);
  return {
    ...publicSettings(settings),
    apiBaseUrl: getOpenAIBaseUrl(settings),
    apiKeyMask: key ? `${key.slice(0, 7)}...${key.slice(-4)}` : ""
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { ...jsonHeaders, ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function sendNoContent(res, extraHeaders = {}) {
  res.writeHead(204, { "Cache-Control": "no-store", ...extraHeaders });
  res.end();
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, details });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError("Request body is too large", 413);
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError("Invalid JSON body", 400);
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function requireEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError("Please enter a valid email", 400);
  }
}

function requirePassword(password) {
  if (String(password || "").length < 8) {
    throw httpError("Password must be at least 8 characters", 400);
  }
}

function cleanPrompt(prompt) {
  const value = String(prompt || "").trim();
  if (value.length < 3) {
    throw httpError("Prompt is too short", 400);
  }
  if (value.length > 4000) {
    throw httpError("Prompt cannot exceed 4000 characters", 400);
  }
  return value;
}

function choose(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function sanitizePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function normalizeImageSize(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "auto") return "auto";
  const match = raw.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) {
    throw httpError("Invalid image size. Use auto or WIDTHxHEIGHT, for example 2048x2048.", 400);
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  const pixels = width * height;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (width > 3840 || height > 3840) {
    throw httpError("Image size cannot exceed 3840x3840.", 400);
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw httpError("Image width and height must be multiples of 16.", 400);
  }
  if (pixels < 655360 || pixels > 8294400) {
    throw httpError("Image pixels must be between 655,360 and 8,294,400.", 400);
  }
  if (longSide / shortSide > 3) {
    throw httpError("Image aspect ratio cannot exceed 3:1.", 400);
  }
  return `${width}x${height}`;
}

function ensureAdmin(current) {
  if (!current?.user || current.user.role !== "admin") {
    throw httpError("Admin permission required", 403);
  }
}

function ensureAuthenticated(current) {
  if (!current?.user) {
    throw httpError("Please sign in first", 401);
  }
}

function canTouchGeneration(user, generation) {
  return user.role === "admin" || generation.userId === user.id;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "";
}

function getUserAgent(req) {
  return String(req.headers["user-agent"] || "").slice(0, 512);
}

function enforceGenerationRate(userId) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxPerWindow = 6;
  const entries = (generationWindows.get(userId) || []).filter((stamp) => now - stamp < windowMs);
  if (entries.length >= maxPerWindow) {
    throw httpError("Too many generation requests. Please try again later", 429);
  }
  entries.push(now);
  generationWindows.set(userId, entries);
}

async function callOpenAIImages(settings, payload) {
  const apiKey = getOpenAIApiKey(settings);
  if (!apiKey) {
    throw httpError("OpenAI API key is not configured", 400);
  }
  if (!getOpenAIBaseUrl(settings)) {
    throw httpError("AI API base URL is not configured", 400);
  }

  const response = await fetch(getOpenAIImageEndpoint(settings), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || "OpenAI image request failed";
    throw httpError(message, response.status, data);
  }

  return data;
}

async function callOpenAIResponses(settings, payload) {
  const apiKey = getOpenAIApiKey(settings);
  if (!apiKey) {
    throw httpError("OpenAI API key is not configured", 400);
  }
  if (!getOpenAIBaseUrl(settings)) {
    throw httpError("AI API base URL is not configured", 400);
  }

  const response = await fetch(getOpenAIResponsesEndpoint(settings), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || "OpenAI image edit request failed";
    throw httpError(message, response.status, data);
  }

  return data;
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw httpError("Invalid image data", 400);
  return new Blob([Buffer.from(match[2], "base64")], { type: match[1] });
}

async function imageSourceToBlob(source) {
  if (String(source).startsWith("data:")) return dataUrlToBlob(source);
  const response = await fetch(source);
  if (!response.ok) throw httpError(`Editable image download failed: ${response.status}`, 400);
  return new Blob([Buffer.from(await response.arrayBuffer())], {
    type: response.headers.get("content-type") || "image/png"
  });
}

async function callOpenAIImageEdits(settings, payload) {
  const apiKey = getOpenAIApiKey(settings);
  if (!apiKey) {
    throw httpError("OpenAI API key is not configured", 400);
  }
  if (!getOpenAIBaseUrl(settings)) {
    throw httpError("AI API base URL is not configured", 400);
  }

  const form = new FormData();
  form.set("model", payload.model);
  form.set("prompt", payload.prompt);
  form.set("n", String(payload.n || 1));
  form.set("size", payload.size || "auto");
  form.set("response_format", "url");
  form.set("image", await imageSourceToBlob(payload.imageData), "image.png");
  if (payload.maskData?.startsWith("data:image/")) {
    form.set("mask", dataUrlToBlob(payload.maskData), "mask.png");
  }

  const response = await fetch(getOpenAIEditEndpoint(settings), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || "OpenAI image edit request failed";
    throw httpError(message, response.status, data);
  }

  return data;
}

function extractImageItems(openaiResult) {
  const directItems = Array.isArray(openaiResult.data) ? openaiResult.data : [];
  const items = directItems.filter((item) => item?.b64_json || item?.url);
  const outputs = Array.isArray(openaiResult.output) ? openaiResult.output : [];

  for (const output of outputs) {
    if (output?.type === "image_generation_call" && output.result) {
      const result = String(output.result);
      items.push(result.startsWith("http") ? { url: result } : { b64_json: result.replace(/^data:image\/\w+;base64,/, "") });
    }
    const content = Array.isArray(output?.content) ? output.content : [];
    for (const part of content) {
      if (part?.type === "output_image" && part.image_base64) {
        items.push({ b64_json: String(part.image_base64).replace(/^data:image\/\w+;base64,/, "") });
      }
      if (part?.type === "output_image" && part.image_url) {
        items.push({ url: String(part.image_url) });
      }
    }
  }

  const toolCalls = openaiResult.choices?.[0]?.message?.tool_calls || [];
  for (const call of toolCalls) {
    if (call?.result) items.push({ b64_json: String(call.result).replace(/^data:image\/\w+;base64,/, "") });
    try {
      const args = JSON.parse(call?.function?.arguments || "{}");
      if (args.result || args.image) {
        const result = String(args.result || args.image);
        items.push(result.startsWith("http") ? { url: result } : { b64_json: result.replace(/^data:image\/\w+;base64,/, "") });
      }
    } catch {
      // Ignore unknown proxy formats.
    }
  }

  return items;
}

function extensionFromContentType(contentType, fallback) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("image/jpeg") || normalized.includes("image/jpg")) return "jpg";
  if (normalized.includes("image/webp")) return "webp";
  if (normalized.includes("image/png")) return "png";
  return fallback === "jpeg" ? "jpg" : fallback;
}

async function imageItemToBuffer(item, request) {
  const fallbackExtension = request.output_format === "jpeg" ? "jpg" : request.output_format;
  if (item.b64_json) {
    const value = String(item.b64_json);
    const match = value.match(/^data:(image\/[^;]+);base64,(.+)$/);
    return {
      buffer: Buffer.from(match ? match[2] : value, "base64"),
      extension: match ? extensionFromContentType(match[1], fallbackExtension) : fallbackExtension
    };
  }
  if (item.url) {
    const response = await fetch(item.url);
    if (!response.ok) {
      throw httpError(`Image URL download failed: ${response.status}`, 502);
    }
    const contentType = response.headers.get("content-type") || "";
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      extension: extensionFromContentType(contentType, fallbackExtension)
    };
  }
  return null;
}

async function saveGeneratedImages(user, request, openaiResult) {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const items = extractImageItems(openaiResult);
  const saved = [];

  for (const item of items) {
    const imageFile = await imageItemToBuffer(item, request);
    if (!imageFile?.buffer?.length) continue;
    const id = randomId("img_");
    const extension = imageFile.extension;
    const filename = `${id}.${extension}`;
    const absolutePath = path.join(GENERATED_DIR, filename);
    await fs.writeFile(absolutePath, imageFile.buffer);

    const generation = {
      id,
      userId: user.id,
      prompt: request.prompt,
      model: request.model,
      size: request.size,
      quality: request.quality,
      background: request.background,
      outputFormat: request.output_format,
      filename,
      isPublic: Boolean(request.isPublic),
      revisedPrompt: item.revised_prompt || "",
      usage: openaiResult.usage || item.usage || null,
      createdAt: nowIso()
    };
    saved.push({
      ...generation,
      imageUrl: `/api/images/${id}/file`
    });
  }

  return saved;
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const settings = await store.getSettings();
    return sendJson(res, 200, {
      ok: true,
      firstRun: (await store.countUsers()) === 0,
      settings: publicSettings(settings)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const current = await getCurrentUser(req);
    const settings = await store.getSettings();
    return sendJson(res, 200, {
      user: current?.user ? serializeUser(current.user) : null,
      firstRun: (await store.countUsers()) === 0,
      checkin: {
        checkedInToday: current?.user ? await store.hasCheckedInToday(current.user.id) : false,
        credit: CHECKIN_CREDIT
      },
      settings: publicSettings(settings)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const name = String(body.name || "").trim() || email.split("@")[0];
    requireEmail(email);
    requirePassword(password);

    const settings = await store.getSettings();
    if (!settings.allowRegistration) {
      throw httpError("Registration is closed", 403);
    }
    if (await store.getUserByEmail(email)) {
      throw httpError("Email is already registered", 409);
    }

    const user = await store.createUser({
      id: randomId("usr_"),
      name: name.slice(0, 60),
      email,
      passwordHash: hashPassword(password),
      role: "user",
      status: !settings.requireApproval ? "active" : "disabled",
      credits: Math.max(0, Number(settings.defaultCredits ?? 10) || 0)
    });

    if (user.status !== "active") {
      return sendJson(res, 201, { user: serializeUser(user), pendingApproval: true });
    }

    const token = await createSession(user.id);
    return sendJson(res, 201, { user: serializeUser(user) }, {
      "Set-Cookie": `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const user = await store.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw httpError("Email or password is incorrect", 401);
    }
    if (user.status !== "active") {
      throw httpError("Account is disabled", 403);
    }
    const token = await createSession(user.id);
    return sendJson(res, 200, { user: serializeUser(user) }, {
      "Set-Cookie": `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    await destroySession(parseCookies(req.headers.cookie).session);
    return sendNoContent(res, {
      "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    });
  }

  if (req.method === "POST" && url.pathname === "/api/checkin") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    const user = await store.getUserById(current.user.id);
    if (!user || user.status !== "active") {
      throw httpError("Account is not active", 403);
    }
    const result = await store.checkInToday(user.id, CHECKIN_CREDIT);
    const updatedUser = await store.getUserById(user.id);
    return sendJson(res, 200, {
      checkedIn: result.checkedIn,
      awarded: result.checkedIn ? CHECKIN_CREDIT : 0,
      credits: result.credits,
      user: serializeUser(updatedUser),
      checkin: {
        checkedInToday: true,
        credit: CHECKIN_CREDIT
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    return sendJson(res, 200, publicSettings(await store.getSettings()));
  }

  if (req.method === "GET" && url.pathname === "/api/stats/today") {
    const offset = Math.max(0, Number.parseInt(process.env.TODAY_GENERATED_OFFSET || "0", 10) || 0);
    const generatedToday = await store.countTodayGenerations();
    return sendJson(res, 200, {
      todayGenerated: offset + generatedToday
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/settings") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    ensureAdmin(current);
    return sendJson(res, 200, adminSettings(await store.getSettings()));
  }

  if (req.method === "PATCH" && url.pathname === "/api/admin/settings") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    ensureAdmin(current);
    const body = await readJsonBody(req);
    const patch = {};

    if (typeof body.openaiApiKey === "string") {
      const key = body.openaiApiKey.trim();
      if (key) patch.openaiApiKey = key;
    }
    if (body.clearApiKey === true) patch.openaiApiKey = "";
    if (typeof body.apiBaseUrl === "string") {
      patch.apiBaseUrl = body.apiBaseUrl.trim().replace(/\/+$/, "").slice(0, 255);
    }
    if (typeof body.model === "string" && body.model.trim()) {
      patch.model = body.model.trim().slice(0, 80);
    }
    if (body.defaultCredits !== undefined) {
      patch.defaultCredits = Math.max(0, Math.min(10000, Number.parseInt(body.defaultCredits, 10) || 0));
    }
    if (body.generationCreditCost !== undefined) {
      patch.generationCreditCost = Math.max(0, Math.min(10000, Number.parseInt(body.generationCreditCost, 10) || 0));
    }
    if (body.maxImagesPerRequest !== undefined) {
      patch.maxImagesPerRequest = Math.max(1, Math.min(4, Number.parseInt(body.maxImagesPerRequest, 10) || 1));
    }
    if (typeof body.allowRegistration === "boolean") patch.allowRegistration = body.allowRegistration ? 1 : 0;
    if (typeof body.requireApproval === "boolean") patch.requireApproval = body.requireApproval ? 1 : 0;

    const settings = await store.updateSettings(patch);
    return sendJson(res, 200, adminSettings(settings));
  }

  if (req.method === "GET" && url.pathname === "/api/admin/users") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    ensureAdmin(current);
    return sendJson(res, 200, {
      users: (await store.listUsers()).map(serializeUser)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/generations") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    ensureAdmin(current);
    const limit = sanitizePositiveInt(url.searchParams.get("limit"), 100, 500);
    const records = (await store.listGenerationRequests(limit)).map((record) => ({
      ...record,
      imageUrl: record.firstGenerationId ? `/api/images/${record.firstGenerationId}/file` : ""
    }));
    return sendJson(res, 200, { records });
  }

  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch && req.method === "PATCH") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    ensureAdmin(current);
    const target = await store.getUserById(userMatch[1]);
    if (!target) throw httpError("User not found", 404);
    const body = await readJsonBody(req);
    const patch = {};

    if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 60) || target.name;
    if (["admin", "user"].includes(body.role)) patch.role = body.role;
    if (["active", "disabled"].includes(body.status)) patch.status = body.status;
    if (body.credits !== undefined) {
      patch.credits = Math.max(0, Math.min(100000, Number.parseInt(body.credits, 10) || 0));
    }
    if (target.id === current.user.id) {
      patch.role = "admin";
      patch.status = "active";
    }

    let user = await store.updateUser(target.id, patch);
    if (body.creditDelta !== undefined) {
      const delta = Math.max(-100000, Math.min(100000, Number.parseInt(body.creditDelta, 10) || 0));
      user = await store.adjustCredits(target.id, delta);
    }
    return sendJson(res, 200, { user: serializeUser(user) });
  }

  if (req.method === "GET" && url.pathname === "/api/images/history") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    const generations = (await store.listGenerationsForUser(current.user, 60)).map((generation) => ({
      ...generation,
      imageUrl: `/api/images/${generation.id}/file`
    }));
    return sendJson(res, 200, { generations });
  }

  if (req.method === "GET" && url.pathname === "/api/images/public") {
    const limit = sanitizePositiveInt(url.searchParams.get("limit"), 60, 120);
    const generations = (await store.listPublicGenerations(limit)).map((generation) => ({
      ...generation,
      imageUrl: `/api/images/${generation.id}/file`
    }));
    return sendJson(res, 200, { generations });
  }

  if (req.method === "POST" && url.pathname === "/api/images/generate") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    enforceGenerationRate(current.user.id);

    const body = await readJsonBody(req);
    const prompt = cleanPrompt(body.prompt);
    const settings = await store.getSettings();
    if (!getOpenAIApiKey(settings) || !getOpenAIBaseUrl(settings)) {
      throw httpError("AI API is not configured", 400);
    }

    const user = await store.getUserById(current.user.id);
    if (!user || user.status !== "active") {
      throw httpError("Account is not active", 403);
    }

    const maxImages = Number(settings.maxImagesPerRequest || 1);
    const n = sanitizePositiveInt(body.n, 1, maxImages);
    const costPerImage = Math.max(0, Number(settings.generationCreditCost ?? 1) || 0);
    const totalCost = costPerImage * n;
    const request = {
      model: String(settings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      prompt,
      n,
      size: normalizeImageSize(body.size),
      quality: choose(body.quality, ["auto", "low", "medium", "high"], "auto"),
      background: choose(body.background, ["auto", "opaque", "transparent"], "auto"),
      output_format: choose(body.outputFormat, ["png", "webp", "jpeg"], "png"),
      isPublic: body.isPublic === true
    };
    const openaiRequest = {
      model: request.model,
      prompt: request.prompt,
      n: request.n,
      size: request.size,
      quality: request.quality,
      background: request.background,
      output_format: request.output_format
    };
    const auditId = randomId("req_");
    await store.insertGenerationRequest({
      id: auditId,
      userId: user.id,
      prompt,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      isPublic: request.isPublic,
      status: "pending"
    });

    let reservedCredits = false;
    if (totalCost > 0) {
      reservedCredits = await store.reserveCredits(user.id, totalCost);
      if (!reservedCredits) {
        await store.updateGenerationRequest(auditId, {
          status: "failed",
          errorMessage: "Not enough credits"
        });
        throw httpError("Not enough credits", 402);
      }
    }

    try {
      const openaiResult = await callOpenAIImages(settings, openaiRequest);
      const saved = await saveGeneratedImages(user, request, openaiResult);
      if (!saved.length) {
        throw httpError("OpenAI did not return a savable image", 502);
      }
      await store.insertGenerations(saved);
      await store.updateGenerationRequest(auditId, {
        status: "success",
        firstGenerationId: saved[0]?.id || "",
        generationIds: saved.map((generation) => generation.id)
      });
      reservedCredits = false;
      if (costPerImage > 0 && saved.length < n) {
        await store.addCredits(user.id, costPerImage * (n - saved.length)).catch((error) => console.error(error));
      }

      return sendJson(res, 200, {
        generations: saved,
        credits: await store.getUserCredits(user.id),
        generationCost: costPerImage
      });
    } catch (error) {
      if (reservedCredits) await store.addCredits(user.id, totalCost).catch((refundError) => console.error(refundError));
      await store.updateGenerationRequest(auditId, {
        status: "failed",
        errorMessage: String(error.message || error).slice(0, 2000)
      }).catch((auditError) => console.error(auditError));
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/images/edit") {
    const current = await getCurrentUser(req);
    ensureAuthenticated(current);
    enforceGenerationRate(current.user.id);

    const body = await readJsonBody(req);
    const prompt = cleanPrompt(body.prompt);
    const imageData = String(body.imageData || "").trim();
    const maskData = String(body.maskData || "").trim();
    if (!imageData || (!imageData.startsWith("data:image/") && !/^https?:\/\//i.test(imageData))) {
      throw httpError("Please provide an editable image", 400);
    }

    const settings = await store.getSettings();
    if (!getOpenAIApiKey(settings) || !getOpenAIBaseUrl(settings)) {
      throw httpError("AI API is not configured", 400);
    }

    const user = await store.getUserById(current.user.id);
    if (!user || user.status !== "active") {
      throw httpError("Account is not active", 403);
    }

    const costPerImage = Math.max(0, Number(settings.generationCreditCost ?? 1) || 0);
    const request = {
      model: String(settings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      prompt,
      n: 1,
      size: normalizeImageSize(body.size),
      quality: "auto",
      background: "auto",
      output_format: "png",
      isPublic: body.isPublic === true
    };
    const auditId = randomId("req_");
    await store.insertGenerationRequest({
      id: auditId,
      userId: user.id,
      prompt: `[image-edit] ${prompt}`,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      isPublic: request.isPublic,
      status: "pending"
    });

    let reservedCredits = false;
    if (costPerImage > 0) {
      reservedCredits = await store.reserveCredits(user.id, costPerImage);
      if (!reservedCredits) {
        await store.updateGenerationRequest(auditId, {
          status: "failed",
          errorMessage: "Not enough credits"
        });
        throw httpError("Not enough credits", 402);
      }
    }

    const payload = {
      model: request.model,
      prompt: maskData
        ? `${prompt}\nThe uploaded image contains a purple visual annotation. Only modify the purple boxed or purple painted area, keep all unmarked areas unchanged, and remove the purple annotation from the final image.`
        : prompt,
      n: 1,
      size: request.size,
      imageData,
      maskData
    };

    try {
      const openaiResult = await callOpenAIImageEdits(settings, payload);
      const saved = await saveGeneratedImages(user, request, openaiResult);
      if (!saved.length) {
        throw httpError("OpenAI did not return a savable edited image", 502);
      }
      await store.insertGenerations(saved);
      await store.updateGenerationRequest(auditId, {
        status: "success",
        firstGenerationId: saved[0]?.id || "",
        generationIds: saved.map((generation) => generation.id)
      });
      reservedCredits = false;

      return sendJson(res, 200, {
        generations: saved,
        credits: await store.getUserCredits(user.id),
        generationCost: costPerImage
      });
    } catch (error) {
      if (reservedCredits) await store.addCredits(user.id, costPerImage).catch((refundError) => console.error(refundError));
      await store.updateGenerationRequest(auditId, {
        status: "failed",
        errorMessage: String(error.message || error).slice(0, 2000)
      }).catch((auditError) => console.error(auditError));
      throw error;
    }
  }

  const fileMatch = url.pathname.match(/^\/api\/images\/([^/]+)\/file$/);
  if (fileMatch && req.method === "GET") {
    const current = await getCurrentUser(req);
    const generation = await store.getGenerationById(fileMatch[1]);
    if (!generation) {
      throw httpError("Image not found", 404);
    }
    if (!generation.isPublic) {
      ensureAuthenticated(current);
      if (!canTouchGeneration(current.user, generation)) {
        throw httpError("Image not found", 404);
      }
    }
    const absolutePath = path.join(GENERATED_DIR, generation.filename);
    const extension = path.extname(generation.filename).toLowerCase();
    const bytes = await fs.readFile(absolutePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(extension) || "application/octet-stream",
      "Cache-Control": "private, max-age=86400"
    });
    res.end(bytes);
    return;
  }

  sendError(res, 404, "API route not found");
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  const requestedPath = pathname === "/" ? "/index.html" : pathname === "/admin" ? "/admin.html" : pathname;
  const absolutePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (absolutePath !== PUBLIC_DIR && !absolutePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 403, "Forbidden");
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new Error("not a file");
    const extension = path.extname(absolutePath).toLowerCase();
    const bytes = await fs.readFile(absolutePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(extension) || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
    });
    res.end(bytes);
  } catch {
    const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(html);
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    const message = status >= 500 ? "Internal server error" : error.message;
    if (status >= 500) console.error(error);
    sendError(res, status, message, error.details);
  }
}

async function bootstrapAdminAccount() {
  const rawEmail = String(process.env.ADMIN_EMAIL || "").trim();
  const rawPassword = String(process.env.ADMIN_PASSWORD || "");
  if (!rawEmail && !rawPassword) {
    if ((await store.countAdmins()) === 0) {
      console.warn("No admin account found. Set ADMIN_EMAIL and ADMIN_PASSWORD, then restart to create one.");
    }
    return;
  }
  if (!rawEmail || !rawPassword) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set together.");
  }

  const email = normalizeEmail(rawEmail);
  requireEmail(email);
  requirePassword(rawPassword);

  const existing = await store.getUserByEmail(email);
  if (existing) {
    if (existing.role !== "admin" || existing.status !== "active") {
      await store.updateUser(existing.id, { role: "admin", status: "active" });
      console.log(`Admin account activated for ${email}`);
    }
    return;
  }

  const settings = await store.getSettings();
  await store.createUser({
    id: randomId("usr_"),
    name: String(process.env.ADMIN_NAME || "Admin").trim().slice(0, 60) || "Admin",
    email,
    passwordHash: hashPassword(rawPassword),
    role: "admin",
    status: "active",
    credits: Math.max(0, Number(settings.defaultCredits ?? 10) || 0)
  });
  console.log(`Admin account created for ${email}`);
}

async function start() {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await store.initializeDatabase({ defaultModel: DEFAULT_MODEL });
  await bootstrapAdminAccount();
  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });
  server.listen(PORT, () => {
    console.log(`GPT Image Studio running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
