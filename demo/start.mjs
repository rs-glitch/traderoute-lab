// `npm run demo`: start TradeRoute Lab and open the guided demo in the default browser.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT) || 4174;
const url = `http://localhost:${port}/#demo`;
const server = spawn(process.execPath, [fileURLToPath(new URL("../server/http.js", import.meta.url))], { stdio: "inherit", env: { ...process.env, PORT: String(port) } });

async function ready() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

if (await ready()) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", shell: process.platform === "win32" }).on("error", () => console.log(`Open ${url} in your browser.`));
  console.log(`\n▶ Demo: ${url}   (Ctrl+C to stop)\n`);
} else {
  console.error("Server did not start. Is the port already in use? Try PORT=4180 npm run demo");
  server.kill();
  process.exit(1);
}
process.on("SIGINT", () => { server.kill(); process.exit(0); });
