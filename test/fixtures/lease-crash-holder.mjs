import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";

const [storeUrl, root, cwd, mode] = process.argv.slice(2);
const next = (name) => new Promise((resolve) => {
  const listener = (message) => {
    if (message === name) { process.off("message", listener); resolve(); }
  };
  process.on("message", listener);
});
const send = (value) => process.send(value);
if (mode === "paused-reclaim") {
  const rename = fs.rename;
  let paused = false;
  fs.rename = async (from, to) => {
    if (!paused && String(from).endsWith(".lock") && String(to).includes(".retired.")) {
      paused = true;
      const resume = next("resume"); send({ event: "paused" }); await resume;
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
const { SessionStore } = await import(storeUrl);
const store = new SessionStore(root);
let lease;
try {
  if (mode === "mkdir") {
    await store.init();
    await fs.mkdir(join(store.locksDir, `${createHash("sha256").update(cwd).digest("hex")}.lock`));
  } else {
    if (mode === "race") { const go = next("go"); send({ event: "waiting" }); await go; }
    lease = await store.acquire(cwd);
    if (["spawning", "spawned", "running"].includes(mode)) await lease.markSpawning();
    if (["spawned", "running"].includes(mode)) {
      const writer = spawn(process.execPath, ["--input-type=module", "-e",
        'import {appendFileSync} from "node:fs"; process.on("disconnect",()=>{}); const write=()=>appendFileSync(process.argv[1],"x"); write(); setInterval(write,20); process.send("ready");',
        join(cwd, "orphan-writes.txt")], {
        detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      await new Promise((resolve, reject) => { writer.once("message", resolve); writer.once("error", reject); });
      if (mode === "running") await lease.bindWorker(process.platform === "win32"
        ? { kind: "windows-process-tree", pid: writer.pid }
        : { kind: "posix-process-group", pid: writer.pid, pgid: writer.pid });
      send({ event: "worker", pid: writer.pid });
      writer.unref();
    }
    if (mode === "reaped") await lease.markReaped("no-worker-created");
  }
  const release = next("release");
  send({ event: "ready" });
  await release;
  if (lease) { await lease.markReaped("no-worker-created"); await lease.release(); }
  process.disconnect();
} catch (error) {
  send({ event: "failure", code: error.code, message: error.message }); process.disconnect();
}
