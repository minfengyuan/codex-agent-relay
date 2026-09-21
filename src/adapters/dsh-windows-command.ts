import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";
import { RelayFailure } from "../types.js";

const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
const DSH_ENTRY_SUFFIX = "/@deepseek-ai/dsh/lib/bin.js";
const DSH_ENTRY_MARKER = /@deepseek-ai[/\\]+dsh[/\\]+lib[/\\]+bin\.js/i;
const OTHER_PERCENT = /%(?:~[^%]*|[^%]+)%/;
const SHIM_MAX_BYTES = 64 * 1024;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

export type WindowsDshLauncher = {
  command: string;
  prefixArgs: string[];
};

export function resolveWindowsDshLauncher(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsDshLauncher {
  const found = locateCommand(command, env);
  if (!found) {
    throw fail(
      `Cannot find the DSH command ${JSON.stringify(command)} on PATH. Set CODEX_AGENT_RELAY_DSH_COMMAND to a native .exe/.com, a .js/.mjs entry, or a supported npm/pnpm dsh.cmd shim.`,
    );
  }
  return interpretLauncher(found);
}

function interpretLauncher(found: string): WindowsDshLauncher {
  const ext = extname(found).toLowerCase();
  if (ext === ".exe" || ext === ".com") {
    return { command: found, prefixArgs: [] };
  }
  if (ext === ".js" || ext === ".mjs") {
    return { command: process.execPath, prefixArgs: [found] };
  }
  if (ext === ".bat") {
    throw fail(
      `Windows DSH launcher ${found} is a .bat script; the relay cannot spawn batch files with shell:false. Set CODEX_AGENT_RELAY_DSH_COMMAND to a native .exe/.com, a .js/.mjs entry, or a supported npm/pnpm dsh.cmd shim.`,
    );
  }
  if (ext === ".cmd") {
    const entry = parseAndVerifyCmdShim(found);
    return { command: process.execPath, prefixArgs: [entry] };
  }
  if (ext === "") {
    return { command: found, prefixArgs: [] };
  }
  throw fail(
    `Windows DSH launcher ${found} uses unsupported extension ${ext}. Set CODEX_AGENT_RELAY_DSH_COMMAND to a native .exe/.com, a .js/.mjs entry, or a supported npm/pnpm dsh.cmd shim.`,
  );
}

function locateCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathext = pathextList(env);
  if (hasPathSeparator(command)) {
    return firstExisting(pathCandidates(resolve(command), pathext, true));
  }
  const name = command;
  for (const dir of pathDirs(env)) {
    const found = firstExisting(pathCandidates(join(dir, name), pathext, false));
    if (found) return found;
  }
  return undefined;
}

function pathCandidates(target: string, pathext: string[], allowExactWithoutExt: boolean): string[] {
  const ext = extname(target);
  if (ext !== "") return [target];
  const candidates: string[] = [];
  // Bare PATH lookup skips the extensionless npm bash shim and follows PATHEXT like cmd.exe.
  if (allowExactWithoutExt) candidates.push(target);
  for (const entry of pathext) {
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    candidates.push(target + suffix);
  }
  return candidates;
}

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function parseAndVerifyCmdShim(shimPath: string): string {
  let content: string;
  try {
    const stat = statSync(shimPath);
    if (stat.size > SHIM_MAX_BYTES) {
      throw fail(unsupportedShimMessage(shimPath));
    }
    content = readFileSync(shimPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof RelayFailure) throw error;
    throw fail(
      `Windows DSH launcher ${shimPath} is not a readable npm/pnpm .cmd shim. Point CODEX_AGENT_RELAY_DSH_COMMAND at the official DSH .js/.mjs entry or a native DSH .exe/.com.`,
    );
  }
  const extracted = extractShimEntry(content, shimPath);
  if (!isFile(extracted)) {
    throw fail(
      `Windows DSH .cmd shim ${shimPath} points at missing entry ${extracted}. Reinstall ${DSH_PACKAGE_NAME} or set CODEX_AGENT_RELAY_DSH_COMMAND to a working launcher.`,
    );
  }
  return verifyDshPackageEntry(extracted, shimPath);
}

function extractShimEntry(content: string, shimPath: string): string {
  const shimDir = dirname(shimPath);
  for (const raw of shimPathTokens(content)) {
    if (!DSH_ENTRY_MARKER.test(raw)) continue;
    if (expandShimDirectoryPlaceholders(raw, shimDir) === undefined) {
      throw fail(
        `Windows DSH launcher ${shimPath} uses an unsupported environment placeholder. The relay expands only the npm/pnpm shim-directory placeholders %dp0% and %~dp0. Point CODEX_AGENT_RELAY_DSH_COMMAND at the official DSH .js/.mjs entry or a native DSH .exe/.com.`,
      );
    }
  }

  const rawEntries = npmShimEntries(content) ?? pnpmShimEntries(content);
  if (!rawEntries) throw fail(unsupportedShimMessage(shimPath));

  const expanded: string[] = [];
  for (const raw of rawEntries) {
    if (!DSH_ENTRY_MARKER.test(raw)) continue;
    const resolved = expandShimDirectoryPlaceholders(raw, shimDir);
    if (resolved === undefined) throw fail(unsupportedShimMessage(shimPath));
    expanded.push(resolved);
  }
  const unique = [...new Set(expanded)];
  const entry = unique.length === 1 ? unique[0] : undefined;
  if (!entry || !posixPath(entry).toLowerCase().endsWith(DSH_ENTRY_SUFFIX)) {
    throw fail(unsupportedShimMessage(shimPath));
  }
  return entry;
}

function npmShimEntries(content: string): string[] | undefined {
  const lines = shimLines(content);
  const invocation = /^endLocal\s+&\s+goto\s+#_undefined_#\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+"%_prog%"\s+"([^"]+)"\s+%\*$/i;
  const allowed = [
    /^@ECHO off$/i,
    /^GOTO start$/i,
    /^:find_dp0$/i,
    /^SET dp0=%~dp0$/i,
    /^EXIT \/b$/i,
    /^:start$/i,
    /^SETLOCAL$/i,
    /^CALL :find_dp0$/i,
    /^IF EXIST "%dp0%\\node\.exe" \($/i,
    /^SET "_prog=%dp0%\\node\.exe"$/i,
    /^\) ELSE \($/i,
    /^SET "_prog=node"$/i,
    /^SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
    /^\)$/,
    invocation,
  ];
  if (!hasAllLines(lines, [
    /^@ECHO off$/i,
    /^SET dp0=%~dp0$/i,
    /^CALL :find_dp0$/i,
    /^IF EXIST "%dp0%\\node\.exe" \($/i,
    /^SET "_prog=%dp0%\\node\.exe"$/i,
    /^SET "_prog=node"$/i,
    /^SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
  ]) || !lines.every((line) => allowed.some((pattern) => pattern.test(line)))) {
    return undefined;
  }
  const matches = lines.map((line) => invocation.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  return matches.length === 1 && matches[0]?.[1] ? [matches[0][1]] : undefined;
}

function pnpmShimEntries(content: string): string[] | undefined {
  const lines = shimLines(content);
  const localInvocation = /^"%~dp0\\node\.exe"\s+"([^"]+)"\s+%\*$/i;
  const pathInvocation = /^node(?:\.exe)?\s+"([^"]+)"\s+%\*$/i;
  const allowed = [
    /^@SETLOCAL$/i,
    /^@IF NOT DEFINED NODE_PATH \($/i,
    /^@SET "NODE_PATH=[^"]*"$/i,
    /^\) ELSE \($/i,
    /^\)$/,
    /^@IF EXIST "%~dp0\\node\.exe" \($/i,
    /^@SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
    localInvocation,
    pathInvocation,
  ];
  if (!hasAllLines(lines, [
    /^@SETLOCAL$/i,
    /^@IF EXIST "%~dp0\\node\.exe" \($/i,
    /^@SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
  ]) || !lines.every((line) => allowed.some((pattern) => pattern.test(line)))) {
    return undefined;
  }
  const local = lines.map((line) => localInvocation.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  const path = lines.map((line) => pathInvocation.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  return local.length === 1 && path.length === 1 && local[0]?.[1] && path[0]?.[1]
    ? [local[0][1], path[0][1]]
    : undefined;
}

function shimLines(content: string): string[] {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function hasAllLines(lines: string[], required: RegExp[]): boolean {
  return required.every((pattern) => lines.some((line) => pattern.test(line)));
}

function shimPathTokens(content: string): string[] {
  const tokens: string[] = [];
  for (const match of content.matchAll(/"([^"]+)"/g)) {
    const token = match[1];
    if (token) tokens.push(token);
  }
  for (const match of content.matchAll(/(?:%~dp0|%dp0%)[^\s"&|<>^]*/gi)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function expandShimDirectoryPlaceholders(raw: string, shimDir: string): string | undefined {
  const stripped = raw.replace(/%~dp0/gi, "").replace(/%dp0%/gi, "");
  if (OTHER_PERCENT.test(stripped) || /%~/.test(stripped)) return undefined;
  const dir = shimDir.endsWith("\\") || shimDir.endsWith("/") ? shimDir : `${shimDir}\\`;
  const expanded = raw.replace(/%~dp0/gi, dir).replace(/%dp0%/gi, dir);
  return resolve(expanded.replace(/\\/g, "/"));
}

function verifyDshPackageEntry(entryPath: string, shimPath: string): string {
  let entryReal: string;
  try {
    entryReal = realpathSync(entryPath);
  } catch {
    throw fail(
      `Windows DSH .cmd shim ${shimPath} points at missing entry ${entryPath}. Reinstall ${DSH_PACKAGE_NAME} or set CODEX_AGENT_RELAY_DSH_COMMAND to a working launcher.`,
    );
  }
  if (!posixPath(entryReal).toLowerCase().endsWith(DSH_ENTRY_SUFFIX)) {
    throw fail(mismatchMessage(entryReal));
  }
  const pkgRoot = findDshPackageRoot(entryReal);
  if (!pkgRoot) throw fail(mismatchMessage(entryReal));
  const pkg = readJson(join(pkgRoot, "package.json"));
  if (!pkg || pkg.name !== DSH_PACKAGE_NAME) throw fail(mismatchMessage(entryReal));
  const mapped = mappedBinDsh(pkg.bin, pkgRoot);
  if (!mapped) throw fail(mismatchMessage(entryReal));
  let mappedReal: string;
  try {
    mappedReal = realpathSync(mapped);
  } catch {
    throw fail(mismatchMessage(entryReal));
  }
  if (mappedReal !== entryReal) throw fail(mismatchMessage(entryReal));
  return entryReal;
}

function mappedBinDsh(bin: unknown, pkgRoot: string): string | undefined {
  if (typeof bin === "string") return resolve(pkgRoot, bin);
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) return undefined;
  const dsh = (bin as { dsh?: unknown }).dsh;
  return typeof dsh === "string" ? resolve(pkgRoot, dsh) : undefined;
}

function findDshPackageRoot(entryRealPath: string): string | undefined {
  let dir = dirname(entryRealPath);
  const { root } = parse(entryRealPath);
  while (true) {
    const pkgFile = join(dir, "package.json");
    if (isFile(pkgFile)) {
      const pkg = readJson(pkgFile);
      if (pkg?.name === DSH_PACKAGE_NAME) return dir;
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readJson(path: string): { name?: unknown; bin?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as { name?: unknown; bin?: unknown }
      : undefined;
  } catch {
    return undefined;
  }
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  const dirs: string[] = [];
  for (const entry of raw.split(delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    dirs.push(isAbsolute(dir) ? dir : resolve(dir));
  }
  return dirs;
}

function pathextList(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? DEFAULT_PATHEXT;
  return raw.split(";").map((entry) => entry.trim()).filter(Boolean);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\") || isAbsolute(command);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function mismatchMessage(entry: string): string {
  return `Windows DSH entry ${entry} is not the bin.dsh of an ${DSH_PACKAGE_NAME} package. Set CODEX_AGENT_RELAY_DSH_COMMAND to the official DSH CLI, a native .exe/.com, or a .js/.mjs entry.`;
}

function unsupportedShimMessage(shimPath: string): string {
  return `Windows DSH launcher ${shimPath} is not a supported npm/pnpm .cmd shim for ${DSH_PACKAGE_NAME}. Point CODEX_AGENT_RELAY_DSH_COMMAND at the official DSH .js/.mjs entry or a native DSH .exe/.com.`;
}

function fail(message: string): RelayFailure {
  return new RelayFailure("ACP_FAILURE", message);
}
