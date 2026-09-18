const [storeUrl, stateDir, cwd] = process.argv.slice(2);
const { SessionStore } = await import(storeUrl);
const lease = await new SessionStore(stateDir).acquire(cwd);
process.stdout.write("ready\n");
process.stdin.resume();
process.stdin.once("data", async (value) => {
  if (value.toString("utf8").trim() === "release") {
    await lease.markReaped("no-worker-created");
    await lease.release();
  }
  process.exit(0);
});
