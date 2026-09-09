import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { RelayFailure } from "./types.js";

export type SessionRecord = {
  version: 1;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  mode?: "agent" | "ask";
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  } catch (error) {
    throw new RelayFailure("STATE_IO", `Cannot create state directory: ${String(error)}`);
  }
}

export async function resolveCwd(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new RelayFailure("INVALID_CWD", "cwd must be an absolute path");
  try {
    const resolved = await realpath(cwd);
    if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch (error) {
    throw new RelayFailure("INVALID_CWD", `cwd does not exist or cannot be resolved: ${String(error)}`);
  }
}

export class SessionStore {
  readonly sessionsDir: string;
  readonly locksDir: string;

  constructor(readonly stateDir: string, namespace?: string) {
    this.sessionsDir = namespace ? join(stateDir, "sessions", namespace) : join(stateDir, "sessions");
    this.locksDir = join(stateDir, "locks");
  }

  async init(): Promise<void> {
    await ensurePrivateDirectory(this.sessionsDir);
    await ensurePrivateDirectory(this.locksDir);
  }

  private pathFor(sessionId: string): string {
    return join(this.sessionsDir, `${digest(sessionId)}.json`);
  }

  async read(sessionId: string, cwd: string): Promise<SessionRecord> {
    await this.init();
    let raw: string;
    try {
      raw = await readFile(this.pathFor(sessionId), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new RelayFailure("UNKNOWN_SESSION", `Unknown sessionId: ${sessionId}`);
      throw new RelayFailure("STATE_IO", `Cannot read session record: ${String(error)}`);
    }
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new RelayFailure("CORRUPT_SESSION", `Session record is invalid JSON: ${sessionId}`);
    }
    if (!isSessionRecord(record) || record.sessionId !== sessionId) {
      throw new RelayFailure("CORRUPT_SESSION", `Session record is invalid: ${sessionId}`);
    }
    if (record.cwd !== cwd) {
      throw new RelayFailure("CWD_MISMATCH", `Session belongs to ${record.cwd}, not ${cwd}`);
    }
    return record;
  }

  async writeNew(sessionId: string, cwd: string, metadata: Pick<SessionRecord, "model" | "mode"> = {}): Promise<void> {
    await this.init();
    const now = new Date().toISOString();
    const record = { version: 1 as const, sessionId, cwd, createdAt: now, updatedAt: now, ...metadata };
    const path = this.pathFor(sessionId);
    const temp = join(dirname(path), `.${digest(sessionId)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      await link(temp, path);
      await rm(temp);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RelayFailure("STATE_CONFLICT", `Session record already exists: ${sessionId}`);
      }
      throw new RelayFailure("STATE_IO", `Cannot save new session record: ${String(error)}`);
    }
  }

  async touch(record: SessionRecord): Promise<void> {
    await this.atomicWrite(this.pathFor(record.sessionId), { ...record, updatedAt: new Date().toISOString() });
  }

  private async atomicWrite(path: string, record: SessionRecord): Promise<void> {
    const temp = join(dirname(path), `.${digest(record.sessionId)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new RelayFailure("STATE_IO", `Cannot save session record: ${String(error)}`);
    }
  }

  async acquire(cwd: string): Promise<() => Promise<void>> {
    await this.init();
    const path = join(this.locksDir, `${digest(cwd)}.lock`);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, cwd, createdAt: new Date().toISOString() })}\n`);
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (handle) await rm(path, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RelayFailure("WORKSPACE_BUSY", `Another delegated task is active for ${cwd}`);
      }
      throw new RelayFailure("LOCK_IO", `Cannot acquire cwd lock: ${String(error)}`);
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { await rm(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new RelayFailure("LOCK_IO", `Cannot release cwd lock: ${String(error)}`);
        }
      }
    };
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SessionRecord>;
  return v.version === 1 && typeof v.sessionId === "string" && typeof v.cwd === "string"
    && typeof v.createdAt === "string" && typeof v.updatedAt === "string"
    && (v.model === undefined || typeof v.model === "string")
    && (v.mode === undefined || v.mode === "agent" || v.mode === "ask");
}
