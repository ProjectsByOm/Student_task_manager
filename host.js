const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
require("dotenv").config();

const PORT = Number(process.env.PORT || 3000);
const ENV_PATH = path.join(__dirname, ".env");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let tunnelProcess;
let appProcess;
let stopping = false;

function saveEnvValue(key, value) {
  let contents = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const expression = new RegExp(`^${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;

  if (expression.test(contents)) {
    contents = contents.replace(expression, line);
  } else {
    contents = `${contents.trimEnd()}${contents.trim() ? "\n" : ""}${line}\n`;
  }

  fs.writeFileSync(ENV_PATH, contents, { mode: 0o600 });
}

async function ensureHostingConfig() {
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    saveEnvValue("JWT_SECRET", process.env.JWT_SECRET);
    console.log("Generated and saved a persistent app signing secret in .env.");
  }
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET in .env must be at least 32 characters long.");
  }

  let adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!adminEmail) {
    const prompt = readline.createInterface({ input: stdin, output: stdout });
    try {
      adminEmail = (await prompt.question("Email address for the initial admin account: ")).trim().toLowerCase();
    } finally {
      prompt.close();
    }
    if (!EMAIL_PATTERN.test(adminEmail)) {
      throw new Error("Enter a valid email address and run npm run host again.");
    }
    saveEnvValue("ADMIN_EMAIL", adminEmail);
  } else if (!EMAIL_PATTERN.test(adminEmail)) {
    throw new Error("ADMIN_EMAIL in .env must be a valid email address.");
  }

  process.env.ADMIN_EMAIL = adminEmail;
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    const executable = process.env.CLOUDFLARED_PATH || "cloudflared";
    tunnelProcess = spawn(executable, [
      "tunnel",
      "--url",
      `http://127.0.0.1:${PORT}`,
      "--no-autoupdate"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    let outputBuffer = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      tunnelProcess.kill();
      reject(new Error("Cloudflared did not provide a Quick Tunnel URL within 90 seconds."));
    }, 90000);

    const onOutput = (chunk) => {
      const text = chunk.toString();
      stdout.write(text);
      outputBuffer = `${outputBuffer}${text}`.slice(-4000);
      const match = outputBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child: tunnelProcess, url: match[0] });
      }
    };

    tunnelProcess.stdout.on("data", onOutput);
    tunnelProcess.stderr.on("data", onOutput);
    tunnelProcess.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error(`Could not start Cloudflared (${error.message}). Install it or set CLOUDFLARED_PATH.`));
      } else {
        console.error("Cloudflared error:", error);
      }
    });
    tunnelProcess.once("exit", (code) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error(`Cloudflared exited before creating a tunnel (exit code ${code}).`));
      } else if (!stopping) {
        console.error(`Cloudflared tunnel exited (exit code ${code}).`);
        stopHosting();
        process.exitCode = 1;
      }
    });
  });
}

function stopHosting() {
  if (stopping) return;
  stopping = true;
  if (appProcess && appProcess.exitCode === null) appProcess.kill();
  if (tunnelProcess && tunnelProcess.exitCode === null) tunnelProcess.kill();
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  await ensureHostingConfig();

  console.log("Starting a Cloudflare Quick Tunnel. Wait for the public URL...");
  const tunnel = await startTunnel();
  tunnelProcess = tunnel.child;

  const appEnv = {
    ...process.env,
    NODE_ENV: "production",
    APP_URL: tunnel.url,
    PORT: String(PORT),
    TRUST_PROXY_HOPS: "1"
  };
  appProcess = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname,
    env: appEnv,
    stdio: "inherit"
  });

  appProcess.once("error", (error) => {
    console.error("Could not start the Daybook server:", error);
    stopHosting();
    process.exitCode = 1;
  });
  appProcess.once("exit", (code) => {
    if (!stopping) {
      stopping = true;
      if (tunnelProcess && tunnelProcess.exitCode === null) tunnelProcess.kill();
      process.exitCode = code || 0;
    }
  });

  process.once("SIGINT", () => {
    console.log("\nStopping Daybook and Cloudflared...");
    stopHosting();
  });
  process.once("SIGTERM", stopHosting);

  console.log(`\nPublic website: ${tunnel.url}`);
  console.log("Keep this terminal open to keep hosting. Press Ctrl+C to stop.");
}

main().catch((error) => {
  console.error(error.message);
  stopHosting();
  process.exitCode = 1;
});
