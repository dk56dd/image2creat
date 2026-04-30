const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  user: null,
  firstRun: false,
  view: "records",
  settings: null,
  users: [],
  records: []
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmt(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  $("#toastLayer").appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function renderLogin() {
  $("#logoutBtn").classList.add("hidden");
  $("#adminApp").innerHTML = `
    <section class="hero">
      <h1>后台管理</h1>
      <p>请使用管理员账号登录。管理员账号由服务器环境变量 ADMIN_EMAIL / ADMIN_PASSWORD 初始化，普通前台注册不会获得后台权限。</p>
    </section>
    <section class="card" style="max-width:460px">
      <h2>管理员登录</h2>
      <form id="loginForm" class="form">
        <label>邮箱<input id="emailInput" type="email" autocomplete="email" required></label>
        <label>密码<input id="passwordInput" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">登录后台</button>
        <a class="secondary" href="/" style="display:grid;place-items:center">回到前台注册/登录</a>
      </form>
    </section>
  `;
  $("#loginForm").addEventListener("submit", login);
}

function renderDenied() {
  $("#logoutBtn").classList.remove("hidden");
  $("#adminApp").innerHTML = `
    <section class="hero">
      <h1>没有后台权限</h1>
      <p>当前账号 ${escapeHtml(state.user?.email || "")} 不是管理员。</p>
    </section>
    <section class="card" style="max-width:520px">
      <button class="secondary" type="button" id="backHome">返回前台</button>
    </section>
  `;
  $("#backHome").addEventListener("click", () => {
    window.location.href = "/";
  });
}

function renderAdmin() {
  $("#logoutBtn").classList.remove("hidden");
  $("#adminApp").innerHTML = `
    <section class="hero">
      <h1>后台管理</h1>
      <p>管理用户、积分、接口设置，并查看生图审计记录、提示词、IP 和浏览器信息。</p>
    </section>
    <div class="tabs">
      <button class="secondary ${state.view === "records" ? "active" : ""}" data-view="records">生图记录</button>
      <button class="secondary ${state.view === "users" ? "active" : ""}" data-view="users">用户管理</button>
      <button class="secondary ${state.view === "settings" ? "active" : ""}" data-view="settings">接口设置</button>
    </div>
    <section id="panel"></section>
  `;
  $$("[data-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.view = button.dataset.view;
      await loadPanel();
      renderAdmin();
      renderPanel();
    });
  });
  renderPanel();
}

function renderPanel() {
  if (state.view === "records") return renderRecords();
  if (state.view === "users") return renderUsers();
  renderSettings();
}

function renderRecords() {
  $("#panel").innerHTML = `
    <div class="card">
      <h2>生图记录</h2>
      <div class="table-wrap">
        ${state.records.length ? `
          <table>
            <thead>
              <tr>
                <th>图片</th>
                <th>用户</th>
                <th>提示词</th>
                <th>IP / UA</th>
                <th>公开</th>
                <th>状态</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              ${state.records.map((record) => `
                <tr>
                  <td>${record.imageUrl ? `<a href="${escapeHtml(record.imageUrl)}" target="_blank"><img class="thumb" src="${escapeHtml(record.imageUrl)}" alt=""></a>` : `<div class="thumb"></div>`}</td>
                  <td><strong>${escapeHtml(record.userName || record.userEmail || "未知用户")}</strong><br><span class="muted">${escapeHtml(record.userEmail || record.userId)}</span></td>
                  <td class="prompt-cell">${escapeHtml(record.prompt)}${record.errorMessage ? `<br><span class="muted">错误：${escapeHtml(record.errorMessage)}</span>` : ""}</td>
                  <td><strong>${escapeHtml(record.ipAddress || "-")}</strong><br><span class="muted">${escapeHtml(record.userAgent || "-")}</span></td>
                  <td>${record.isPublic ? "是" : "否"}</td>
                  <td><span class="status ${record.status === "failed" ? "failed" : ""}">${escapeHtml(record.status)}</span></td>
                  <td>${fmt(record.createdAt)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : `<div class="empty">暂无生图记录</div>`}
      </div>
    </div>
  `;
}

function renderUsers() {
  $("#panel").innerHTML = `
    <div class="card">
      <h2>用户管理</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>状态</th>
              <th>积分</th>
              <th>增减积分</th>
              <th>注册时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${state.users.map((user) => `
              <tr data-user-id="${escapeHtml(user.id)}">
                <td><strong>${escapeHtml(user.name || user.email)}</strong><br><span class="muted">${escapeHtml(user.email)}</span></td>
                <td>
                  <select class="role-input" ${user.id === state.user.id ? "disabled" : ""}>
                    <option value="user" ${user.role === "user" ? "selected" : ""}>用户</option>
                    <option value="admin" ${user.role === "admin" ? "selected" : ""}>管理员</option>
                  </select>
                </td>
                <td>
                  <select class="status-input" ${user.id === state.user.id ? "disabled" : ""}>
                    <option value="active" ${user.status === "active" ? "selected" : ""}>启用</option>
                    <option value="disabled" ${user.status === "disabled" ? "selected" : ""}>停用</option>
                  </select>
                </td>
                <td><input class="credits-input" type="number" min="0" value="${Number(user.credits || 0)}"></td>
                <td><input class="credit-delta-input" type="number" step="1" value="0"></td>
                <td>${fmt(user.createdAt)}</td>
                <td><button class="tiny save-user" type="button">保存</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
  $$(".save-user").forEach((button) => {
    button.addEventListener("click", () => saveUser(button.closest("tr")));
  });
}

function renderSettings() {
  const settings = state.settings || {};
  $("#panel").innerHTML = `
    <div class="grid">
      <section class="card">
        <h2>接口设置</h2>
        <form id="settingsForm" class="form">
          <label>OpenAI API Key<input id="apiKeyInput" type="password" placeholder="${escapeHtml(settings.apiKeyMask || "不修改则留空")}"></label>
        <label>API 地址<input id="apiBaseUrlInput" value="${escapeHtml(settings.apiBaseUrl || "")}" placeholder="AI API base URL"></label>
          <label>模型<input id="modelInput" value="${escapeHtml(settings.model || "GPT-IMAGE-2")}"></label>
          <label>注册送积分<input id="defaultCreditsInput" type="number" min="0" value="${Number(settings.defaultCredits ?? 10)}"></label>
          <label>每张图消耗积分<input id="generationCreditCostInput" type="number" min="0" value="${Number(settings.generationCreditCost ?? 1)}"></label>
          <label>单次最大张数<input id="maxImagesInput" type="number" min="1" max="4" value="${Number(settings.maxImagesPerRequest ?? 1)}"></label>
          <label><input id="allowRegistrationInput" type="checkbox" ${settings.allowRegistration ? "checked" : ""}> 开放注册</label>
          <label><input id="requireApprovalInput" type="checkbox" ${settings.requireApproval ? "checked" : ""}> 新用户需要后台启用</label>
          <button class="primary" type="submit">保存设置</button>
          <button id="clearKeyBtn" class="secondary" type="button">清除 API Key</button>
        </form>
      </section>
      <section class="card">
        <h2>说明</h2>
        <p class="muted">前台生图会按“每张图消耗积分”扣除积分；用户每天可在前台签到领取 1 积分。用户积分可在用户管理中直接设置，也可以用增减积分输入框做临时加减。</p>
      </section>
    </div>
  `;
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#clearKeyBtn").addEventListener("click", clearKey);
}

async function loadPanel() {
  if (state.view === "records") {
    const data = await api("/api/admin/generations?limit=200");
    state.records = data.records || [];
  } else if (state.view === "users") {
    const data = await api("/api/admin/users");
    state.users = data.users || [];
  } else {
    state.settings = await api("/api/admin/settings");
  }
}

async function login(event) {
  event.preventDefault();
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("#emailInput").value,
        password: $("#passwordInput").value
      })
    });
    await bootstrap();
  } catch (error) {
    toast(error.message);
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => null);
  state.user = null;
  renderLogin();
}

async function saveUser(row) {
  try {
    await api(`/api/admin/users/${row.dataset.userId}`, {
      method: "PATCH",
      body: JSON.stringify({
        role: $(".role-input", row).value,
        status: $(".status-input", row).value,
        credits: Number($(".credits-input", row).value || 0),
        creditDelta: Number($(".credit-delta-input", row).value || 0)
      })
    });
    toast("用户已保存");
    await loadPanel();
    renderUsers();
  } catch (error) {
    toast(error.message);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    state.settings = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        openaiApiKey: $("#apiKeyInput").value.trim(),
        apiBaseUrl: $("#apiBaseUrlInput").value.trim(),
        model: $("#modelInput").value.trim(),
        defaultCredits: Number($("#defaultCreditsInput").value || 0),
        generationCreditCost: Number($("#generationCreditCostInput").value || 0),
        maxImagesPerRequest: Number($("#maxImagesInput").value || 1),
        allowRegistration: $("#allowRegistrationInput").checked,
        requireApproval: $("#requireApprovalInput").checked
      })
    });
    toast("设置已保存");
    renderSettings();
  } catch (error) {
    toast(error.message);
  }
}

async function clearKey() {
  try {
    state.settings = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ clearApiKey: true })
    });
    toast("API Key 已清除");
    renderSettings();
  } catch (error) {
    toast(error.message);
  }
}

async function bootstrap() {
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    state.firstRun = data.firstRun;
    if (!state.user) return renderLogin();
    if (state.user.role !== "admin") return renderDenied();
    await loadPanel();
    renderAdmin();
  } catch (error) {
    toast(error.message);
    renderLogin();
  }
}

$("#logoutBtn").addEventListener("click", logout);
bootstrap();
