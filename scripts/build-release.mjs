import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function detectPlatform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported release platform: ${process.platform}`);
}

const platform = process.argv[2] || process.env.TALKIS_RELEASE_PLATFORM || detectPlatform();
const bundleTargets = {
  macos: ["app", "dmg"],
  windows: ["nsis"],
  linux: ["appimage", "deb"],
};

if (!Object.hasOwn(bundleTargets, platform)) {
  throw new Error(`Unsupported release platform: ${platform}`);
}

const env = {
  ...process.env,
  TALKIS_STT_RELEASE: process.env.TALKIS_STT_RELEASE || "1",
  TALKIS_SKIP_BEFORE_BUILD: "1",
};

if (platform === "macos") {
  env.MACOSX_DEPLOYMENT_TARGET = process.env.MACOSX_DEPLOYMENT_TARGET || "11.0";

  if (!env.TAURI_SIGNING_PRIVATE_KEY && env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    if (!existsSync(env.TAURI_SIGNING_PRIVATE_KEY_PATH)) {
      throw new Error(`TAURI_SIGNING_PRIVATE_KEY_PATH does not point to a file: ${env.TAURI_SIGNING_PRIVATE_KEY_PATH}`);
    }

    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(env.TAURI_SIGNING_PRIVATE_KEY_PATH, "utf8");
  }
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });
}

run("bun", ["run", "prepare:sidecars"]);
run("bun", ["run", "build"]);
run("bun", ["run", "tauri", "build", "--bundles", bundleTargets[platform].join(",")]);

if (platform === "macos" && process.env.TALKIS_POSTPROCESS_MACOS_RELEASE !== "0") {
  run("bun", ["run", "postprocess:macos-release"]);
}

console.log(`Built ${platform} release bundles: ${bundleTargets[platform].join(", ")}`);
