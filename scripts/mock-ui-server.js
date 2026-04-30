const http = require("node:http");
const path = require("node:path");
const { promises: fs } = require("node:fs");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3456);
const mockGenerations = [];
const mockRequests = [];
const mockCheckins = new Set();
const mockUsers = [{
  id: "usr_mock_admin",
  name: "Mock Admin",
  email: "admin@example.com",
  password: "admin123456",
  role: "admin",
  status: "active",
  credits: 10,
  createdAt: new Date().toISOString()
}];
const mockSessions = new Map();
let mockSettings = {
  hasApiKey: true,
  model: "GPT-IMAGE-2",
  allowRegistration: true,
  requireApproval: false,
  defaultCredits: 10,
  generationCreditCost: 1,
  checkinCredit: 1,
  maxImagesPerRequest: 1,
  apiBaseUrl: "",
  apiKeyMask: ""
};

const mimes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"]
]);

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return [part, ""];
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).session;
  const userId = mockSessions.get(token);
  return mockUsers.find((user) => user.id === userId && user.status === "active") || null;
}

function publicUser(user) {
  if (!user) return null;
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

function todayKey(userId) {
  return `${userId}:${new Date().toISOString().slice(0, 10)}`;
}

function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user) {
    json(res, 401, { error: "Please sign in first" });
    return null;
  }
  if (user.role !== "admin") {
    json(res, 403, { error: "Admin permission required" });
    return null;
  }
  return user;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function samplePrompts(limit = 12) {
  try {
    const raw = await fs.readFile(path.join(publicDir, "prompts.json"), "utf8");
    const data = JSON.parse(raw);
    return (data.prompts || []).slice(0, limit).map((prompt) => ({
      id: `sample_${prompt.id}`,
      prompt: prompt.prompt,
      model: "GPT-IMAGE-2",
      size: "auto",
      quality: "auto",
      background: "auto",
      outputFormat: "png",
      filename: "",
      isPublic: true,
      createdAt: new Date().toISOString(),
      imageUrl: prompt.image
    }));
  } catch {
    return [];
  }
}

async function serve(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/auth/me") {
    const user = currentUser(req);
    return json(res, 200, {
      user: publicUser(user),
      firstRun: mockUsers.filter((user) => user.role !== "admin").length === 0,
      checkin: {
        checkedInToday: user ? mockCheckins.has(todayKey(user.id)) : false,
        credit: mockSettings.checkinCredit
      },
      settings: mockSettings
    });
  }
  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) return json(res, 400, { error: "Email and password are required" });
    if (mockUsers.some((user) => user.email === email)) return json(res, 409, { error: "Email is already registered" });
    const user = {
      id: `usr_${Date.now()}`,
      name: String(body.name || email.split("@")[0]).trim(),
      email,
      password,
      role: "user",
      status: !mockSettings.requireApproval ? "active" : "disabled",
      credits: Number(mockSettings.defaultCredits || 10),
      createdAt: new Date().toISOString()
    };
    mockUsers.push(user);
    const token = `mock_${Date.now()}_${Math.random()}`;
    mockSessions.set(token, user.id);
    return json(res, 201, { user: publicUser(user) }, {
      "Set-Cookie": `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
    });
  }
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = mockUsers.find((entry) => entry.email === email && entry.password === String(body.password || ""));
    if (!user) return json(res, 401, { error: "Email or password is incorrect" });
    if (user.status !== "active") return json(res, 403, { error: "Account is disabled" });
    const token = `mock_${Date.now()}_${Math.random()}`;
    mockSessions.set(token, user.id);
    return json(res, 200, { user: publicUser(user) }, {
      "Set-Cookie": `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
    });
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = parseCookies(req.headers.cookie).session;
    mockSessions.delete(token);
    return json(res, 200, {}, {
      "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    });
  }
  if (url.pathname === "/api/checkin" && req.method === "POST") {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: "Please sign in first" });
    const key = todayKey(user.id);
    const checkedIn = !mockCheckins.has(key);
    if (checkedIn) {
      mockCheckins.add(key);
      user.credits += Number(mockSettings.checkinCredit || 1);
    }
    return json(res, 200, {
      checkedIn,
      awarded: checkedIn ? Number(mockSettings.checkinCredit || 1) : 0,
      credits: user.credits,
      user: publicUser(user),
      checkin: { checkedInToday: true, credit: Number(mockSettings.checkinCredit || 1) }
    });
  }
  if (url.pathname === "/api/stats/today") return json(res, 200, { todayGenerated: 4200 });
  if (url.pathname === "/api/images/public") {
    const publicItems = mockGenerations.filter((item) => item.isPublic);
    return json(res, 200, { generations: publicItems.length ? publicItems : await samplePrompts(12) });
  }
  if (url.pathname === "/api/images/history") {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: "Please sign in first" });
    return json(res, 200, { generations: mockGenerations.filter((item) => item.userId === user.id) });
  }
  if (url.pathname === "/api/images/generate" && req.method === "POST") {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: "Please sign in first" });
    const body = await readJson(req);
    const cost = Number(mockSettings.generationCreditCost || 1);
    if (cost > 0 && user.credits < cost) {
      return json(res, 402, { error: "Not enough credits" });
    }
    user.credits = Math.max(0, user.credits - cost);
    const generation = {
      id: `mock_${Date.now()}`,
      userId: user.id,
      prompt: body.prompt || "Mock generation",
      model: "GPT-IMAGE-2",
      size: body.size || "auto",
      quality: body.quality || "auto",
      background: body.background || "auto",
      outputFormat: body.outputFormat || "png",
      filename: "",
      isPublic: body.isPublic === true,
      createdAt: new Date().toISOString(),
      imageUrl: "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/poster_case113/output.jpg"
    };
    mockRequests.unshift({
      id: `req_${Date.now()}`,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      prompt: generation.prompt,
      ipAddress: req.socket?.remoteAddress || "127.0.0.1",
      userAgent: String(req.headers["user-agent"] || ""),
      isPublic: generation.isPublic,
      status: "success",
      firstGenerationId: generation.id,
      generationIds: [generation.id],
      imageUrl: generation.imageUrl,
      createdAt: generation.createdAt
    });
    mockGenerations.unshift(generation);
    return json(res, 200, {
      generations: [generation],
      credits: user.credits,
      generationCost: cost
    });
  }
  if (url.pathname === "/api/images/edit" && req.method === "POST") {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: "Please sign in first" });
    const body = await readJson(req);
    const cost = Number(mockSettings.generationCreditCost || 1);
    if (cost > 0 && user.credits < cost) {
      return json(res, 402, { error: "Not enough credits" });
    }
    user.credits = Math.max(0, user.credits - cost);
    const generation = {
      id: `mock_edit_${Date.now()}`,
      userId: user.id,
      prompt: body.prompt || "Mock image edit",
      model: "GPT-IMAGE-2",
      size: body.size || "auto",
      quality: "auto",
      background: "auto",
      outputFormat: "png",
      filename: "",
      isPublic: body.isPublic === true,
      createdAt: new Date().toISOString(),
      imageUrl: "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/ecommerce_case074/output.jpg"
    };
    mockRequests.unshift({
      id: `req_${Date.now()}`,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      prompt: `[image-edit] ${generation.prompt}`,
      ipAddress: req.socket?.remoteAddress || "127.0.0.1",
      userAgent: String(req.headers["user-agent"] || ""),
      isPublic: generation.isPublic,
      status: "success",
      firstGenerationId: generation.id,
      generationIds: [generation.id],
      imageUrl: generation.imageUrl,
      createdAt: generation.createdAt
    });
    mockGenerations.unshift(generation);
    return json(res, 200, {
      generations: [generation],
      credits: user.credits,
      generationCost: cost
    });
  }
  if (url.pathname === "/api/admin/settings") {
    if (!requireAdmin(req, res)) return;
    if (req.method === "GET") return json(res, 200, mockSettings);
    if (req.method === "PATCH") {
      const body = await readJson(req);
      mockSettings = { ...mockSettings, ...body, hasApiKey: body.clearApiKey ? false : mockSettings.hasApiKey };
      if (body.openaiApiKey) mockSettings.hasApiKey = true;
      return json(res, 200, mockSettings);
    }
  }
  if (url.pathname === "/api/admin/users") {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, { users: mockUsers.map(publicUser) });
  }
  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch && req.method === "PATCH") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const body = await readJson(req);
    const user = mockUsers.find((entry) => entry.id === userMatch[1]);
    if (!user) return json(res, 404, { error: "User not found" });
    if (user.id !== admin.id) {
      if (body.role) user.role = body.role;
      if (body.status) user.status = body.status;
    }
    if (body.credits !== undefined) user.credits = Number(body.credits || 0);
    if (body.creditDelta !== undefined) user.credits = Math.max(0, user.credits + Number(body.creditDelta || 0));
    return json(res, 200, { user: publicUser(user) });
  }
  if (url.pathname === "/api/admin/generations") {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, { records: mockRequests });
  }
  if (url.pathname.startsWith("/api/")) return json(res, 200, {});

  const requestedPath = url.pathname === "/" ? "index.html" : url.pathname === "/admin" ? "admin.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requestedPath));
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) return json(res, 403, { error: "Forbidden" });
  try {
    const bytes = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimes.get(path.extname(filePath)) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(bytes);
  } catch {
    const html = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  }
}

http.createServer((req, res) => {
  serve(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { error: "Internal server error" });
  });
}).listen(port, () => {
  console.log(`mock ui server running at http://localhost:${port}`);
});
