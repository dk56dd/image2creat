const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

if (process.env.RUN_MYSQL_SMOKE !== "1") {
  process.stdout.write("smoke test skipped: set RUN_MYSQL_SMOKE=1 with MYSQL_* env vars to run it\n");
  process.exit(0);
}

const rootDir = require("node:path").resolve(__dirname, "..");
const port = 3300 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
let child;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data };
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 7000) {
    try {
      const { response, data } = await request("/api/health");
      if (response.ok && data.ok) return data;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("server did not become ready");
}

async function main() {
  child = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_EMAIL: "admin-smoke@example.com",
      ADMIN_PASSWORD: "password123",
      ADMIN_NAME: "Smoke Admin"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const health = await waitForServer();
  assert.equal(health.settings.model, process.env.IMAGE_MODEL || "GPT-IMAGE-2");

  const missingAuth = await request("/api/images/generate", {
    method: "POST",
    body: JSON.stringify({ prompt: "A product photo of a desk lamp" })
  });
  assert.equal(missingAuth.response.status, 401);

  const adminLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: "admin-smoke@example.com",
      password: "password123"
    })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.get("set-cookie").split(";")[0];

  const email = `user-${Date.now()}@example.com`;
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke User",
      email,
      password: "password123"
    })
  });
  assert.equal(registered.response.status, 201);
  const userCookie = registered.response.headers.get("set-cookie").split(";")[0];

  const me = await request("/api/auth/me", {
    headers: { Cookie: userCookie }
  });
  assert.equal(me.response.status, 200);
  assert.equal(me.data.user.email, email);
  assert.equal(me.data.user.role, "user");

  const checkin = await request("/api/checkin", {
    method: "POST",
    headers: { Cookie: userCookie }
  });
  assert.equal(checkin.response.status, 200);
  assert.equal(checkin.data.awarded, 1);

  const settings = await request("/api/admin/settings", {
    method: "PATCH",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      openaiApiKey: "test-local-only",
      apiBaseUrl: "https://example.test",
      model: "GPT-IMAGE-2",
      defaultCredits: 12,
      generationCreditCost: 2,
      maxImagesPerRequest: 2,
      allowRegistration: true,
      requireApproval: true
    })
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.data.hasApiKey, true);
  assert.equal(settings.data.apiBaseUrl, "https://example.test");
  assert.equal(settings.data.generationCreditCost, 2);

  const users = await request("/api/admin/users", {
    headers: { Cookie: adminCookie }
  });
  assert.equal(users.response.status, 200);
  assert.ok(users.data.users.length >= 1);

  process.stdout.write("smoke test passed\n");
  if (stderr) process.stderr.write(stderr);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (child) child.kill();
  });
