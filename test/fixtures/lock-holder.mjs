const [moduleUrl, stateDir, cwd] = process.argv.slice(2);
const { SessionStore } = await import(moduleUrl);
const release = await new SessionStore(stateDir).acquire(cwd);
process.stdout.write("ready\n");
const keepAlive = setInterval(() => {}, 1_000);
const finish = async () => { clearInterval(keepAlive); await release(); process.exit(0); };
process.once("SIGTERM", () => { void finish(); });
process.once("SIGINT", () => { void finish(); });
