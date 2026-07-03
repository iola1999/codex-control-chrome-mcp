import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_STATE_DIR,
  CODEX_EXTENSION_ID,
  CODEX_NATIVE_HOST_NAME,
  DEFAULT_BROWSER,
  SUPPORTED_BROWSERS,
  browserProfileDir,
  configPathFor,
  installStatePathFor,
  nativeHostManifestPath,
} from "./constants.js";
import {
  MANIFEST_DESCRIPTION,
  classifyHost,
  inspectHostBinary,
  isOfficialCodexManifest,
  isOurLauncherPath,
  isProjectManifest,
} from "./host-identity.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-meta.js";

export async function installNativeHost({
  binPath,
  proxy = true,
  browser = DEFAULT_BROWSER,
  paths = defaultInstallPaths(browser),
  selfBinPath = resolveSelfBinPath(),
} = {}) {
  const { manifestPath, appStateDir, configPath, installStatePath } = paths;
  const browserId = paths.browser ?? browser;
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.mkdir(appStateDir, { recursive: true });

  const { hostPath, launchMode } = await createLauncher({
    binPath,
    selfBinPath,
    appStateDir,
    browser: browserId,
  });
  const existing = await readJsonIfExists(manifestPath);
  const previousState = await readJsonIfExists(installStatePath);
  const previousBackup = previousState?.backupPath
    ? await readJsonIfExists(previousState.backupPath)
    : null;
  const existingIsOurs = isProjectManifest(existing);
  const previousBackupIsOurs = isProjectManifest(previousBackup);
  let backupPath = null;
  if (existing && !existingIsOurs) {
    backupPath = await backupManifest(manifestPath);
  } else if (previousBackup && !previousBackupIsOurs) {
    backupPath = previousState.backupPath;
  }

  const officialHostPath = proxy
    ? await resolveOfficialHostPath({ existing, existingIsOurs, previousState, previousBackup, hostPath })
    : null;

  const manifest = {
    allowed_origins: [`chrome-extension://${CODEX_EXTENSION_ID}/`],
    description: MANIFEST_DESCRIPTION,
    name: CODEX_NATIVE_HOST_NAME,
    path: hostPath,
    type: "stdio",
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const config = {
    installedAt: new Date().toISOString(),
    browser: browserId,
    manifestPath,
    hostPath,
    binPath: binPath ? path.resolve(binPath) : null,
    launchMode,
    backupPath,
    officialHostPath,
    proxy,
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.writeFile(installStatePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

/**
 * Resolve the genuine OpenAI host to proxy to. Authority order:
 *   1. the live manifest, when it is verifiably OpenAI's (most up to date),
 *   2. the previously recorded official host,
 *   3. the backed-up manifest's path.
 * Self-references and our own launcher are dropped, and a candidate whose file
 * still exists is preferred so a renamed/removed host (e.g. after a Codex
 * update) never gets recorded as the official target.
 */
async function resolveOfficialHostPath({ existing, existingIsOurs, previousState, previousBackup, hostPath }) {
  const candidates = [];
  if (existing?.path && !existingIsOurs && isOfficialCodexManifest(existing)) {
    candidates.push(existing.path);
  }
  if (typeof previousState?.officialHostPath === "string") {
    candidates.push(previousState.officialHostPath);
  }
  if (previousBackup?.path && !isProjectManifest(previousBackup)) {
    candidates.push(previousBackup.path);
  }

  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved === path.resolve(hostPath) || isOurLauncherPath(candidate) || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(candidate);
  }

  for (const candidate of unique) {
    if ((await inspectHostBinary(candidate)).exists) return candidate;
  }
  // None of the candidates exist on disk; fall back to the most authoritative
  // one (the live official manifest) for diagnostics rather than inventing null.
  return unique[0] ?? null;
}

/**
 * Idempotently re-assert a previously-established install. Used on stdio
 * startup so a Codex update that reclaims the manifest self-heals without a
 * manual `install-native-host`. Never bootstraps a fresh install silently.
 */
export async function ensureNativeHostRegistered({
  browser = DEFAULT_BROWSER,
  paths = defaultInstallPaths(browser),
} = {}) {
  const { manifestPath, installStatePath } = paths;
  const state = await readJsonIfExists(installStatePath);
  if (!state || typeof state.hostPath !== "string") {
    return { action: "skip", reason: "not-installed" };
  }

  const manifest = await readJsonIfExists(manifestPath);
  const pointsToUs =
    isProjectManifest(manifest) &&
    typeof manifest?.path === "string" &&
    path.resolve(manifest.path) === path.resolve(state.hostPath);
  const launcherExists = (await inspectHostBinary(state.hostPath)).exists;
  if (pointsToUs && launcherExists) {
    return { action: "ok", reason: "already-registered" };
  }

  const result = await installNativeHost({
    binPath: state.launchMode === "direct-bin" ? state.binPath ?? undefined : undefined,
    proxy: state.proxy !== false,
    paths,
  });
  return {
    action: "re-registered",
    reason: launcherExists ? "manifest-reverted" : "launcher-missing",
    manifestPath,
    hostPath: result.hostPath,
    officialHostPath: result.officialHostPath,
  };
}

export async function uninstallNativeHost({
  force = false,
  browser = DEFAULT_BROWSER,
  paths = defaultInstallPaths(browser),
} = {}) {
  const { manifestPath, installStatePath } = paths;
  const state = await readJsonIfExists(installStatePath);
  const manifest = await readJsonIfExists(manifestPath);

  if (!manifest && !state?.backupPath) {
    return { ok: true, action: "noop", manifestPath };
  }

  if (!force && !isProjectManifest(manifest)) {
    throw new Error(
      `Refusing to uninstall because ${manifestPath} does not look like a codex-control-chrome-mcp manifest. Use --force to override.`,
    );
  }

  if (state?.backupPath) {
    await fs.copyFile(state.backupPath, manifestPath);
    return { ok: true, action: "restored", manifestPath, backupPath: state.backupPath };
  }

  await fs.rm(manifestPath, { force: true });
  return { ok: true, action: "removed", manifestPath };
}

export async function nativeHostInstallStatus({
  browser = DEFAULT_BROWSER,
  paths = defaultInstallPaths(browser),
} = {}) {
  const { manifestPath, installStatePath } = paths;
  const manifest = await readJsonIfExists(manifestPath);
  const state = await readJsonIfExists(installStatePath);
  const classification = await classifyHost({ manifest, hostPath: manifest?.path });
  const registered =
    isProjectManifest(manifest) &&
    typeof state?.hostPath === "string" &&
    typeof manifest?.path === "string" &&
    path.resolve(manifest.path) === path.resolve(state.hostPath);
  return { browser: paths.browser ?? browser, manifestPath, manifest, state, registered, classification };
}

/** Browsers whose user profile directory exists on this machine (install targets). */
export async function detectInstalledBrowsers() {
  const present = [];
  for (const browser of SUPPORTED_BROWSERS) {
    let dir;
    try {
      dir = browserProfileDir(browser);
    } catch {
      continue; // unsupported platform for this browser
    }
    try {
      await fs.access(dir);
      present.push(browser);
    } catch {
      // profile directory absent -> browser not installed (or never launched)
    }
  }
  return present;
}

/** Browsers we have previously installed for (an install-state file exists). */
export async function detectManagedBrowsers() {
  const managed = [];
  for (const browser of SUPPORTED_BROWSERS) {
    if (await readJsonIfExists(installStatePathFor(browser))) {
      managed.push(browser);
    }
  }
  return managed;
}

function defaultInstallPaths(browser = DEFAULT_BROWSER) {
  return {
    browser,
    manifestPath: nativeHostManifestPath(browser),
    appStateDir: APP_STATE_DIR,
    configPath: configPathFor(browser),
    installStatePath: installStatePathFor(browser),
  };
}

async function backupManifest(manifestPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    path.dirname(manifestPath),
    `${path.basename(manifestPath)}.backup-${stamp}`,
  );
  await fs.copyFile(manifestPath, backupPath);
  return backupPath;
}

/**
 * Choose how the Native Messaging host is launched:
 *   - `--bin <path>`: a caller-supplied CLI entry (local dev) -> direct launcher.
 *   - installed to a stable location (e.g. `npm i -g`): our own resolved entry
 *     -> direct launcher, so every connect skips npx's resolve/download cost.
 *   - run from npx's temp cache (`npx … install-native-host`): that copy can be
 *     garbage-collected, so a launcher must not point at it -> npx launcher
 *     (stable, but pays npx startup on every connect). Install globally and
 *     re-run for the fast path.
 */
async function createLauncher({ binPath, selfBinPath, appStateDir, browser }) {
  if (binPath) {
    const hostPath = await createDirectLauncher(
      path.resolve(binPath),
      appStateDir,
      browser,
      "native-host-local-launcher",
    );
    return { hostPath, launchMode: "direct-bin" };
  }
  if (isNpxCachePath(selfBinPath)) {
    const hostPath = await createNpxLauncher(appStateDir, browser);
    return { hostPath, launchMode: "npx-launcher" };
  }
  const hostPath = await createDirectLauncher(
    selfBinPath,
    appStateDir,
    browser,
    "native-host-launcher",
  );
  return { hostPath, launchMode: "global-bin" };
}

// Each browser gets its own launcher so the native host knows which browser's
// config to read for proxy mode. Chrome keeps the original unsuffixed filename
// so manifests written before multi-browser support still resolve.
function launcherFileName(base, browser) {
  return browser === DEFAULT_BROWSER ? base : `${base}-${browser}`;
}

/**
 * A tiny shell shim that execs the installed Node CLI directly (no npx), so the
 * host starts in milliseconds instead of paying npx's resolve/download cost on
 * every Native Messaging connect. It prefers the Node.js used at install time
 * and falls back to `node` on PATH, so a Node upgrade (which moves the versioned
 * Homebrew/nvm path in process.execPath) does not strand the launcher. Chrome/
 * Edge Native Messaging manifests cannot carry arguments, so `--native-host` and
 * `--browser` are injected here.
 */
async function createDirectLauncher(binPath, appStateDir, browser, launcherBase) {
  if (process.platform === "win32" || !binPath.endsWith(".js")) {
    return binPath;
  }
  const launcherPath = path.join(appStateDir, launcherFileName(launcherBase, browser));
  const script = `#!/usr/bin/env sh
node_bin=${shellQuote(process.execPath)}
[ -x "$node_bin" ] || node_bin=node
exec "$node_bin" ${shellQuote(binPath)} --native-host --browser ${browser} "$@"
`;
  await fs.writeFile(launcherPath, script, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(launcherPath, 0o755);
  return launcherPath;
}

async function createNpxLauncher(appStateDir, browser = DEFAULT_BROWSER) {
  if (process.platform === "win32") {
    throw new Error("NPX native host launcher installation is not implemented for Windows yet.");
  }
  const launcherPath = path.join(appStateDir, launcherFileName("native-host-launcher", browser));
  const script = `#!/usr/bin/env sh
exec npx -y ${PACKAGE_NAME}@${PACKAGE_VERSION} --native-host --browser ${browser} "$@"
`;
  await fs.writeFile(launcherPath, script, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(launcherPath, 0o755);
  return launcherPath;
}

/**
 * Absolute path to this package's own CLI entry, resolved from the installed
 * module location so a global (or otherwise stable) install yields a launcher
 * target that survives package upgrades.
 */
function resolveSelfBinPath() {
  return fileURLToPath(new URL("../bin/codex-control-chrome-mcp.js", import.meta.url));
}

/** True when a path lives inside npm's `_npx` temp cache (subject to GC). */
function isNpxCachePath(filePath) {
  return filePath.split(path.sep).includes("_npx");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
