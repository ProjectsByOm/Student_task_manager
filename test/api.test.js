const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

let serverProcess;
let baseUrl;
let tempDirectory;

async function availablePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(route, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cookie: response.headers.get("set-cookie")?.split(";")[0]
  };
}

async function signup(email, name) {
  const response = await request("/api/auth/signup", {
    method: "POST",
    body: { name, email, password: "planner-test-password" }
  });
  assert.equal(response.status, 201);
  assert.ok(response.cookie);
  return { user: response.body.user, cookie: response.cookie };
}

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "daybook-test-"));
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_PATH: path.join(tempDirectory, "test.db"),
      JWT_SECRET: "integration-test-secret-with-more-than-32-characters",
      ADMIN_EMAIL: "admin@daybook.test",
      APP_URL: baseUrl
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server exited early: ${lastError || serverProcess.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not become ready: ${lastError}`);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await once(serverProcess, "exit");
  }
  if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
});

test("authentication, account isolation, imports, reset tokens, admin roles, and static-file protection", async () => {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal((await request("/server.js")).status, 404);

  const admin = await signup("admin@daybook.test", "Daybook Admin");
  assert.equal(admin.user.role, "admin");
  const user = await signup("student@daybook.test", "Daybook Student");
  assert.equal(user.user.role, "user");
  assert.equal((await request("/api/admin/users", { cookie: user.cookie })).status, 403);

  const adminExport = await request("/api/data/export", { cookie: admin.cookie });
  assert.equal(adminExport.status, 200);
  const unauthenticatedImport = await request("/api/data/import", {
    method: "POST",
    body: { courses: [], tasks: [], replace: true }
  });
  assert.equal(unauthenticatedImport.status, 401);

  const imported = await request("/api/data/import", {
    method: "POST",
    cookie: user.cookie,
    body: {
      replace: true,
      courses: [{ id: adminExport.body.courses[0].id, name: "Imported course", color: "#779988" }],
      tasks: [{ id: "same-task-id", title: "Imported task", course: adminExport.body.courses[0].id, due: "2026-10-04", priority: "high", status: "todo" }]
    }
  });
  assert.equal(imported.status, 200);
  assert.notEqual(imported.body.courses[0].id, adminExport.body.courses[0].id);
  assert.equal(imported.body.tasks[0].course, imported.body.courses[0].id);

  const invalidImport = await request("/api/data/import", {
    method: "POST",
    cookie: user.cookie,
    body: {
      replace: true,
      courses: [{ id: "c", name: "Broken", color: "red" }],
      tasks: []
    }
  });
  assert.equal(invalidImport.status, 400);
  const userExport = await request("/api/data/export", { cookie: user.cookie });
  assert.equal(userExport.body.tasks[0].title, "Imported task");
  const unchangedAdmin = await request("/api/data/export", { cookie: admin.cookie });
  assert.equal(unchangedAdmin.body.courses.length, adminExport.body.courses.length);

  const roleUpdate = await request(`/api/admin/users/${user.user.id}/role`, {
    method: "PUT",
    cookie: admin.cookie,
    body: { role: "admin" }
  });
  assert.equal(roleUpdate.status, 200);
  assert.equal((await request("/api/admin/users", { cookie: user.cookie })).status, 200);
  const selfDemotion = await request(`/api/admin/users/${user.user.id}/role`, {
    method: "PUT",
    cookie: user.cookie,
    body: { role: "user" }
  });
  assert.equal(selfDemotion.status, 400);

  const forgot = await request("/api/auth/forgot", {
    method: "POST",
    body: { email: "student@daybook.test" }
  });
  assert.equal(forgot.status, 200);
  const resetToken = new URL(forgot.body.resetLink).hash.slice("#reset=".length);
  assert.equal(resetToken.length, 64);

  const reset = await request("/api/auth/reset", {
    method: "POST",
    body: { token: resetToken, password: "replacement-password" }
  });
  assert.equal(reset.status, 200);
  assert.equal((await request("/api/auth/me", { cookie: user.cookie })).status, 401);
  assert.equal((await request("/api/auth/reset", {
    method: "POST",
    body: { token: resetToken, password: "another-replacement" }
  })).status, 400);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: "student@daybook.test", password: "replacement-password" }
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "admin");

  const proxiedLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "student@daybook.test", password: "replacement-password" },
    headers: {
      Origin: "https://tasks.daybook.example",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "tasks.daybook.example"
    }
  });
  assert.equal(proxiedLogin.status, 200);

  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: { email: "student@daybook.test", password: "replacement-password" },
    headers: { Origin: "https://attacker.example" }
  })).status, 403);
});

test("production startup does not require SMTP and reports unavailable password reset", async () => {
  const port = await availablePort();
  const productionUrl = `http://127.0.0.1:${port}`;
  const productionServer = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_PATH: path.join(tempDirectory, "production.db"),
      JWT_SECRET: "production-integration-test-secret-long-enough",
      ADMIN_EMAIL: "admin@production.test",
      APP_URL: "https://daybook.example",
      SMTP_HOST: "",
      SMTP_FROM: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    let lastError;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (productionServer.exitCode !== null) {
        throw new Error(`Production test server exited early: ${lastError || productionServer.exitCode}`);
      }
      try {
        const response = await fetch(`${productionUrl}/api/health`);
        if (response.ok) break;
      } catch (error) {
        lastError = error.message;
      }
      if (attempt === 79) throw new Error(`Production test server did not become ready: ${lastError}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const response = await fetch(`${productionUrl}/api/auth/forgot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@production.test" })
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not configured/i);
  } finally {
    if (productionServer.exitCode === null) {
      productionServer.kill();
      await once(productionServer, "exit");
    }
  }
});
