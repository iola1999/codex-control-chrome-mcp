import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_EXTENSION_ID, CODEX_NATIVE_HOST_NAME } from "../src/constants.js";
import {
  ensureNativeHostRegistered,
  installNativeHost,
  uninstallNativeHost,
} from "../src/installer.js";
import { MANIFEST_DESCRIPTION } from "../src/host-identity.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-meta.js";

function tmpPaths(root) {
  const appStateDir = path.join(root, "state");
  return {
    manifestPath: path.join(root, "NativeMessagingHosts", `${CODEX_NATIVE_HOST_NAME}.json`),
    appStateDir,
    configPath: path.join(appStateDir, "config.json"),
    installStatePath: path.join(appStateDir, "install-state.json"),
  };
}

function officialManifest(hostPath) {
  return {
    name: CODEX_NATIVE_HOST_NAME,
    description: "Codex chrome native messaging host",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${CODEX_EXTENSION_ID}/`],
  };
}

test("installNativeHost backs up and restores an existing manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-control-chrome-mcp-test-"));
  const manifestPath = path.join(root, "NativeMessagingHosts", `${CODEX_NATIVE_HOST_NAME}.json`);
  const appStateDir = path.join(root, "state");
  const paths = {
    manifestPath,
    appStateDir,
    configPath: path.join(appStateDir, "config.json"),
    installStatePath: path.join(appStateDir, "install-state.json"),
  };
  const originalManifest = {
    name: CODEX_NATIVE_HOST_NAME,
    description: "Official Codex native host",
    path: path.join(root, "official-extension-host"),
    type: "stdio",
    allowed_origins: [`chrome-extension://${CODEX_EXTENSION_ID}/`],
  };

  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(originalManifest, null, 2)}\n`, "utf8");

  const installResult = await installNativeHost({ paths });
  const installedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const launcher = await fs.readFile(installedManifest.path, "utf8");

  assert.equal(installedManifest.name, CODEX_NATIVE_HOST_NAME);
  assert.equal(installedManifest.description, "Codex Control Chrome MCP native messaging host");
  assert.equal(installResult.officialHostPath, originalManifest.path);
  // Run from a stable location (the repo checkout), the default install writes a
  // direct launcher that execs Node against our CLI — no npx in the hot path.
  assert.equal(installResult.launchMode, "global-bin");
  assert.doesNotMatch(launcher, /npx/);
  assert.match(launcher, /--native-host --browser chrome/);
  assert.match(launcher, /bin\/codex-control-chrome-mcp\.js/);

  const backupManifest = JSON.parse(await fs.readFile(installResult.backupPath, "utf8"));
  assert.deepEqual(backupManifest, originalManifest);

  const uninstallResult = await uninstallNativeHost({ paths });
  const restoredManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  assert.equal(uninstallResult.action, "restored");
  assert.deepEqual(restoredManifest, originalManifest);
});

test("installNativeHost falls back to an npx launcher when run from the npx cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-control-chrome-mcp-test-"));
  const paths = tmpPaths(root);
  // Simulate `npx … install-native-host`: the package resolves inside npm's
  // `_npx` temp cache, which can be garbage-collected, so a direct launcher
  // would dangle. The installer must fall back to the (stable) npx launcher.
  const npxSelfBin = path.join(
    root, ".npm", "_npx", "deadbeef", "node_modules",
    "codex-control-chrome-mcp", "bin", "codex-control-chrome-mcp.js",
  );

  const result = await installNativeHost({ paths, selfBinPath: npxSelfBin });
  const launcher = await fs.readFile(result.hostPath, "utf8");

  assert.equal(result.launchMode, "npx-launcher");
  assert.match(launcher, new RegExp(`npx -y ${PACKAGE_NAME}@${PACKAGE_VERSION} --native-host`));
});

test("installNativeHost prefers the live official host over a stale recorded path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-control-chrome-mcp-test-"));
  const paths = tmpPaths(root);
  await fs.mkdir(path.dirname(paths.manifestPath), { recursive: true });
  await fs.mkdir(paths.appStateDir, { recursive: true });

  // The current official host (renamed by an update) exists on disk...
  const liveHost = path.join(root, "Codex for Chrome");
  await fs.writeFile(liveHost, "binary", { mode: 0o755 });
  // ...while the previously recorded host path is now gone.
  const staleHost = path.join(root, "extension-host");

  await fs.writeFile(
    paths.manifestPath,
    `${JSON.stringify(officialManifest(liveHost), null, 2)}\n`,
    "utf8",
  );
  const staleBackup = `${paths.manifestPath}.backup-stale`;
  await fs.writeFile(staleBackup, `${JSON.stringify(officialManifest(staleHost), null, 2)}\n`, "utf8");
  await fs.writeFile(
    paths.installStatePath,
    `${JSON.stringify({ officialHostPath: staleHost, backupPath: staleBackup, hostPath: path.join(paths.appStateDir, "old") }, null, 2)}\n`,
    "utf8",
  );

  const result = await installNativeHost({ paths });
  assert.equal(result.officialHostPath, liveHost); // live host wins, stale path dropped
});

test("ensureNativeHostRegistered re-registers a manifest reverted by an update", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-control-chrome-mcp-test-"));
  const paths = tmpPaths(root);

  await installNativeHost({ paths });
  assert.equal((await ensureNativeHostRegistered({ paths })).action, "ok");

  // Simulate Codex reclaiming the manifest after an update.
  const reclaimedHost = path.join(root, "Codex for Chrome");
  await fs.writeFile(reclaimedHost, "binary", { mode: 0o755 });
  await fs.writeFile(
    paths.manifestPath,
    `${JSON.stringify(officialManifest(reclaimedHost), null, 2)}\n`,
    "utf8",
  );

  const result = await ensureNativeHostRegistered({ paths });
  assert.equal(result.action, "re-registered");

  const manifest = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.description, MANIFEST_DESCRIPTION); // back to our launcher
  assert.equal(manifest.path, result.hostPath);
});

test("ensureNativeHostRegistered skips when nothing was ever installed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-control-chrome-mcp-test-"));
  const result = await ensureNativeHostRegistered({ paths: tmpPaths(root) });
  assert.equal(result.action, "skip");
});

function browserPaths(root, appStateDir, browser) {
  const suffix = browser === "chrome" ? "" : `.${browser}`;
  return {
    browser,
    manifestPath: path.join(root, browser, "NativeMessagingHosts", `${CODEX_NATIVE_HOST_NAME}.json`),
    appStateDir,
    configPath: path.join(appStateDir, `config${suffix}.json`),
    installStatePath: path.join(appStateDir, `install-state${suffix}.json`),
  };
}

test("installing two browsers keeps independent state and restore metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-control-chrome-mcp-test-"));
  const appStateDir = path.join(root, "state");
  const chrome = browserPaths(root, appStateDir, "chrome");
  const edge = browserPaths(root, appStateDir, "edge");

  // Each browser starts with its own distinct official manifest.
  for (const paths of [chrome, edge]) {
    await fs.mkdir(path.dirname(paths.manifestPath), { recursive: true });
    const hostPath = path.join(root, `${paths.browser}-extension-host`);
    await fs.writeFile(paths.manifestPath, `${JSON.stringify(officialManifest(hostPath), null, 2)}\n`, "utf8");
  }

  const chromeInstall = await installNativeHost({ paths: chrome });
  const edgeInstall = await installNativeHost({ paths: edge });

  // Per-browser launchers, recorded under each browser's own state file.
  assert.equal(chromeInstall.browser, "chrome");
  assert.equal(edgeInstall.browser, "edge");
  assert.ok(chromeInstall.hostPath.endsWith("native-host-launcher"));
  assert.ok(edgeInstall.hostPath.endsWith("native-host-launcher-edge"));
  assert.notEqual(chrome.installStatePath, edge.installStatePath);

  const edgeLauncher = await fs.readFile(edgeInstall.hostPath, "utf8");
  assert.match(edgeLauncher, /--native-host --browser edge/);

  // Installing edge must not have overwritten chrome's recorded restore target.
  const chromeState = JSON.parse(await fs.readFile(chrome.installStatePath, "utf8"));
  const edgeState = JSON.parse(await fs.readFile(edge.installStatePath, "utf8"));
  assert.equal(chromeState.officialHostPath, path.join(root, "chrome-extension-host"));
  assert.equal(edgeState.officialHostPath, path.join(root, "edge-extension-host"));

  // Uninstalling edge restores edge's manifest and leaves chrome's untouched.
  await uninstallNativeHost({ paths: edge });
  const restoredEdge = JSON.parse(await fs.readFile(edge.manifestPath, "utf8"));
  const chromeManifest = JSON.parse(await fs.readFile(chrome.manifestPath, "utf8"));
  assert.equal(restoredEdge.path, path.join(root, "edge-extension-host"));
  assert.equal(chromeManifest.description, MANIFEST_DESCRIPTION); // still ours
});
