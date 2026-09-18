import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { RelayFailure } from "./types.js";
import {
  probePosixProcessGroup,
  probeProcess,
  type ProcessTreeReference,
} from "./runner/process-tree.js";

export type SessionRecord = {
  version: 1;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  mode?: "agent" | "ask";
};

export type WorkspaceLockPhase = "locked" | "spawning" | "running" | "terminating" | "reaped" | "orphaned";

export type WorkspaceLockRecord = {
  version: 1;
  cwd: string;
  owner: {
    pid: number;
    token: string;
    hostname: string;
  };
  phase: WorkspaceLockPhase;
  worker?: ProcessTreeReference;
  createdAt: string;
  updatedAt: string;
};

export interface WorkspaceLease {
  markSpawning(): Promise<void>;
  bindWorker(ref: ProcessTreeReference): Promise<void>;
  markTerminating(): Promise<void>;
  markReaped(evidence: "no-worker-created" | "tree-exit-confirmed"): Promise<void>;
  markOrphaned(): Promise<void>;
  release(): Promise<void>;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const MAX_LOCK_RECORD_BYTES = 16 * 1_024;
const MAX_ACQUIRE_ATTEMPTS = 8;
const OWNER_FILE = "owner.json";

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

  async acquire(cwd: string): Promise<WorkspaceLease> {
    await this.init();
    const hash = digest(cwd);
    const lockPath = join(this.locksDir, `${hash}.lock`);
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const token = randomUUID();
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw lockIo(`Cannot acquire cwd lock for ${cwd}`, error);
        }
        const existing = await readLockPath(lockPath);
        if (existing.kind === "missing") continue;
        if (existing.kind === "legacy") {
          if (existing.record.cwd !== cwd) {
            throw new RelayFailure("STALE_LOCK_UNVERIFIED", `Legacy cwd lock does not match ${cwd}`);
          }
          const owner = probeProcess(existing.record.pid);
          if (owner === "alive") {
            throw new RelayFailure("WORKSPACE_BUSY", `Another delegated task is active for ${cwd}`);
          }
          throw new RelayFailure("STALE_LOCK_UNVERIFIED", `Legacy cwd lock cannot be safely recovered for ${cwd}`);
        }
        if (existing.kind !== "modern" || existing.record.cwd !== cwd) {
          throw new RelayFailure("STALE_LOCK_UNVERIFIED", `Cwd lock metadata cannot be safely verified for ${cwd}`);
        }
        const disposition = staleDisposition(existing.record);
        if (disposition === "busy") {
          throw new RelayFailure("WORKSPACE_BUSY", `Another delegated task is active for ${cwd}`);
        }
        if (disposition === "unverified") {
          throw new RelayFailure("STALE_LOCK_UNVERIFIED", `Cwd lock owner cannot be safely verified for ${cwd}`);
        }
        if (disposition === "orphaned") {
          throw new RelayFailure("WORKSPACE_ORPHANED", `Cwd lock may still have a live worker for ${cwd}`);
        }
        const retiredPath = join(this.locksDir, `${hash}.retired.${existing.record.owner.token}`);
        await retireForReclaim(lockPath, retiredPath, existing.record);
        continue;
      }
      const now = new Date().toISOString();
      const record: WorkspaceLockRecord = {
        version: 1,
        cwd,
        owner: { pid: process.pid, token, hostname: hostname() },
        phase: "locked",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await chmod(lockPath, 0o700);
        await writeLockRecord(lockPath, record);
      } catch (error) {
        throw lockIo(`Cannot publish cwd lock for ${cwd}`, error);
      }
      return createWorkspaceLease(lockPath, join(this.locksDir, `${hash}.retired.${token}`), record);
    }
    throw new RelayFailure("WORKSPACE_BUSY", `Cwd lock changed repeatedly while acquiring ${cwd}`);
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

type LegacyLockRecord = { pid: number; cwd: string; createdAt: string };
type ReadLockResult =
  | { kind: "modern"; record: WorkspaceLockRecord }
  | { kind: "legacy"; record: LegacyLockRecord }
  | { kind: "missing" }
  | { kind: "invalid" };

class InvalidLockRecordError extends Error {}

function lockIo(message: string, error: unknown): RelayFailure {
  return error instanceof RelayFailure
    && (error.code === "LOCK_IO" || error.code === "LOCK_OWNERSHIP_LOST")
    ? error
    : new RelayFailure("LOCK_IO", `${message}: ${String(error)}`);
}

async function readBoundedFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_LOCK_RECORD_BYTES) {
    throw new InvalidLockRecordError("lock record is not a bounded regular file");
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_LOCK_RECORD_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used === 0 || used > MAX_LOCK_RECORD_BYTES) throw new InvalidLockRecordError("lock record exceeds its size limit");
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readLockPath(path: string): Promise<ReadLockResult> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw lockIo(`Cannot inspect cwd lock ${path}`, error);
  }
  try {
    if (info.isSymbolicLink()) return { kind: "invalid" };
    const raw = info.isDirectory()
      ? await readBoundedFile(join(path, OWNER_FILE))
      : info.isFile() ? await readBoundedFile(path) : undefined;
    if (raw === undefined) return { kind: "invalid" };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { kind: "invalid" }; }
    if (info.isDirectory()) {
      return isWorkspaceLockRecord(parsed) ? { kind: "modern", record: parsed } : { kind: "invalid" };
    }
    return isLegacyLockRecord(parsed) ? { kind: "legacy", record: parsed } : { kind: "invalid" };
  } catch (error) {
    if (error instanceof RelayFailure) throw error;
    if (error instanceof InvalidLockRecordError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "invalid" };
    }
    throw lockIo(`Cannot read cwd lock ${path}`, error);
  }
}

async function writeLockRecord(
  lockPath: string,
  record: WorkspaceLockRecord,
  expectedToken?: string,
): Promise<void> {
  const temp = join(lockPath, `.owner.${record.owner.token}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.close();
    handle = undefined;
    if (expectedToken !== undefined) {
      const current = await readLockPath(lockPath);
      if (current.kind !== "modern" || current.record.owner.token !== expectedToken
        || current.record.cwd !== record.cwd) {
        throw new RelayFailure("LOCK_OWNERSHIP_LOST", `Workspace lease ownership was lost for ${record.cwd}`);
      }
    }
    await rename(temp, join(lockPath, OWNER_FILE));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

function createWorkspaceLease(
  lockPath: string,
  retiredPath: string,
  initial: WorkspaceLockRecord,
): WorkspaceLease {
  let tail = Promise.resolve();
  let released = false;
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const current = async (): Promise<WorkspaceLockRecord> => {
    const lock = await readLockPath(lockPath);
    if (lock.kind !== "modern" || lock.record.cwd !== initial.cwd
      || lock.record.owner.token !== initial.owner.token) {
      throw new RelayFailure("LOCK_OWNERSHIP_LOST", `Workspace lease ownership was lost for ${initial.cwd}`);
    }
    return lock.record;
  };
  const update = async (
    apply: (record: WorkspaceLockRecord) => WorkspaceLockRecord | undefined,
  ): Promise<void> => {
    const record = await current();
    const next = apply(record);
    if (!next) return;
    try {
      await writeLockRecord(lockPath, { ...next, updatedAt: new Date().toISOString() }, initial.owner.token);
    } catch (error) {
      throw lockIo(`Cannot update cwd lock for ${record.cwd}`, error);
    }
  };
  return {
    markSpawning: () => enqueue(() => update((record) => {
      if (record.phase === "spawning") return undefined;
      requirePhase(record, ["locked"], "mark spawning");
      return { ...record, phase: "spawning" };
    })),
    bindWorker: (ref) => enqueue(() => update((record) => {
      if (!validWorkerForRuntime(ref)) {
        throw new RelayFailure("LOCK_IO", `Worker reference is invalid for this platform for ${record.cwd}`);
      }
      if (record.phase === "running" && sameWorker(record.worker, ref)) return undefined;
      requirePhase(record, ["spawning"], "bind worker");
      return { ...record, phase: "running", worker: ref };
    })),
    markTerminating: () => enqueue(() => update((record) => {
      if (record.phase === "terminating") return undefined;
      requirePhase(record, ["locked", "spawning", "running"], "mark terminating");
      return { ...record, phase: "terminating" };
    })),
    markReaped: (evidence) => enqueue(() => update((record) => {
      if (record.phase === "reaped") return undefined;
      requirePhase(record, ["locked", "spawning", "running", "terminating"], "mark reaped");
      if (evidence === "no-worker-created" && record.worker !== undefined) {
        throw new RelayFailure("LOCK_IO", `Cannot mark a bound worker reaped without tree-exit evidence for ${record.cwd}`);
      }
      return { ...record, phase: "reaped" };
    })),
    markOrphaned: () => enqueue(() => update((record) => {
      if (record.phase === "orphaned") return undefined;
      requirePhase(record, ["locked", "spawning", "running", "terminating"], "mark orphaned");
      return { ...record, phase: "orphaned" };
    })),
    release: () => enqueue(async () => {
      if (released) return;
      const record = await current();
      requirePhase(record, ["reaped"], "release");
      try {
        await rename(lockPath, retiredPath);
        released = true;
      } catch (error) {
        const [after, retired] = await Promise.all([readLockPath(lockPath), readLockPath(retiredPath)]);
        if (after.kind === "missing" && retired.kind === "modern"
          && retired.record.owner.token === initial.owner.token && retired.record.cwd === initial.cwd) {
          released = true;
          return;
        }
        if (after.kind !== "modern" || after.record.owner.token !== initial.owner.token) {
          throw new RelayFailure("LOCK_OWNERSHIP_LOST", `Workspace lease ownership was lost for ${initial.cwd}`);
        }
        throw lockIo(`Cannot retire cwd lock for ${initial.cwd}`, error);
      }
    }),
  };
}

function requirePhase(record: WorkspaceLockRecord, allowed: WorkspaceLockPhase[], action: string): void {
  if (!allowed.includes(record.phase)) {
    throw new RelayFailure("LOCK_IO", `Cannot ${action} from workspace lease phase ${record.phase}`);
  }
}

function sameWorker(left: ProcessTreeReference | undefined, right: ProcessTreeReference): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function staleDisposition(record: WorkspaceLockRecord): "busy" | "recover" | "orphaned" | "unverified" {
  if (record.owner.hostname !== hostname() || !workerMatchesPlatform(record.worker)) return "unverified";
  const owner = probeProcess(record.owner.pid);
  if (owner === "alive") return "busy";
  if (owner === "unknown") return "unverified";
  if (record.phase === "reaped" || (record.phase === "locked" && record.worker === undefined)) return "recover";
  if (record.worker?.kind === "posix-process-group") {
    const group = probePosixProcessGroup(record.worker.pgid);
    return group === "gone" ? "recover" : "orphaned";
  }
  return "orphaned";
}

function workerMatchesPlatform(worker: ProcessTreeReference | undefined): boolean {
  if (!worker) return true;
  return process.platform === "win32"
    ? worker.kind === "windows-process-tree"
    : worker.kind === "posix-process-group";
}

function validWorkerForRuntime(worker: ProcessTreeReference): boolean {
  return isProcessTreeReference(worker) && workerMatchesPlatform(worker);
}

async function retireForReclaim(
  lockPath: string,
  retiredPath: string,
  expected: WorkspaceLockRecord,
): Promise<void> {
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    const [current, retired] = await Promise.all([readLockPath(lockPath), readLockPath(retiredPath)]);
    const oldRetired = retired.kind === "modern"
      && retired.record.owner.token === expected.owner.token
      && retired.record.cwd === expected.cwd;
    const generationChanged = current.kind === "missing"
      || (current.kind === "modern" && current.record.owner.token !== expected.owner.token);
    if (oldRetired && generationChanged) return;
    throw lockIo(`Cannot retire stale cwd lock for ${expected.cwd}`, error);
  }
}

function isLegacyLockRecord(value: unknown): value is LegacyLockRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, ["pid", "cwd", "createdAt"])) return false;
  return isPositiveInteger(value.pid) && typeof value.cwd === "string" && isAbsolute(value.cwd)
    && isIsoTimestamp(value.createdAt);
}

function isWorkspaceLockRecord(value: unknown): value is WorkspaceLockRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "version", "cwd", "owner", "phase", "createdAt", "updatedAt",
  ], ["worker"])) return false;
  if (value.version !== 1 || typeof value.cwd !== "string" || !isAbsolute(value.cwd)
    || !isWorkspaceOwner(value.owner) || !isWorkspacePhase(value.phase)
    || !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return false;
  const worker = value.worker;
  if (worker !== undefined && !isProcessTreeReference(worker)) return false;
  if (value.phase === "locked" && worker !== undefined) return false;
  if (value.phase === "spawning" && worker !== undefined) return false;
  if (value.phase === "running" && worker === undefined) return false;
  return true;
}

function isWorkspaceOwner(value: unknown): value is WorkspaceLockRecord["owner"] {
  return isPlainObject(value) && hasExactKeys(value, ["pid", "token", "hostname"])
    && isPositiveInteger(value.pid) && typeof value.token === "string" && isUuid(value.token)
    && typeof value.hostname === "string" && value.hostname.length > 0 && value.hostname.length <= 255;
}

function isWorkspacePhase(value: unknown): value is WorkspaceLockPhase {
  return value === "locked" || value === "spawning" || value === "running"
    || value === "terminating" || value === "reaped" || value === "orphaned";
}

function isProcessTreeReference(value: unknown): value is ProcessTreeReference {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "windows-process-tree") {
    return hasExactKeys(value, ["kind", "pid"]) && isPositiveInteger(value.pid);
  }
  return value.kind === "posix-process-group" && hasExactKeys(value, ["kind", "pid", "pgid"])
    && isPositiveInteger(value.pid) && isPositiveInteger(value.pgid) && value.pid === value.pgid;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
