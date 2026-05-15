import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriDir = join(rootDir, "src-tauri");
const binariesDir = join(tauriDir, "binaries");

function directoryHasLibclang(directory) {
  if (!directory || !existsSync(directory)) return false;

  try {
    return readdirSync(directory).some((name) => (
      name === "libclang.so"
      || name.startsWith("libclang.so.")
      || (name.startsWith("libclang-") && name.includes(".so"))
    ));
  } catch {
    return false;
  }
}

function hasLibclang() {
  if (directoryHasLibclang(process.env.LIBCLANG_PATH)) {
    return true;
  }

  const commonDirectories = [
    "/usr/lib",
    "/usr/lib64",
    "/usr/lib/llvm-18/lib",
    "/usr/lib/llvm-17/lib",
    "/usr/lib/llvm-16/lib",
    "/usr/lib/llvm-15/lib",
    "/usr/lib/llvm-14/lib",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/local/lib",
  ];

  return commonDirectories.some(directoryHasLibclang);
}

function ensureLinuxBindgenDependencies(targetTriple) {
  if (!targetTriple.includes("linux") || hasLibclang()) return;

  console.error("");
  console.error("Missing libclang: whisper-rs-sys uses bindgen and needs libclang.so during local sidecar builds.");
  console.error("Install it on Ubuntu/Debian with:");
  console.error("");
  console.error("  sudo apt update && sudo apt install -y clang libclang-dev");
  console.error("");
  console.error("If libclang is installed in a custom location, set LIBCLANG_PATH to the directory that contains libclang.so.");
  console.error("");
  process.exit(1);
}

function readTargetTriple() {
  if (process.env.TAURI_STT_TARGET_TRIPLE) {
    return process.env.TAURI_STT_TARGET_TRIPLE.trim();
  }

  try {
    return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  } catch {
    const versionOutput = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
    const hostLine = versionOutput.split("\n").find((line) => line.startsWith("host:"));

    if (!hostLine) {
      throw new Error("Failed to determine Rust target triple");
    }

    return hostLine.replace("host:", "").trim();
  }
}

const targetTriple = readTargetTriple();
ensureLinuxBindgenDependencies(targetTriple);

const extension = targetTriple.includes("windows") ? ".exe" : "";
const profile = process.env.TALKIS_STT_RELEASE === "1" ? "release" : "debug";
const sidecars = ["talkis-stt", "talkis-stt-nvidia", "talkis-stt-qwen", "talkis-diarize"];
const cargoArgs = ["build", "--manifest-path", join(tauriDir, "Cargo.toml")];

for (const sidecar of sidecars) {
  cargoArgs.push("--bin", sidecar);
}

if (profile === "release") {
  cargoArgs.push("--release");
}

mkdirSync(binariesDir, { recursive: true });

for (const sidecar of sidecars) {
  const destinationBinary = join(binariesDir, `${sidecar}-${targetTriple}${extension}`);
  if (!existsSync(destinationBinary)) {
    writeFileSync(destinationBinary, "#!/usr/bin/env sh\nexit 1\n");
    if (!targetTriple.includes("windows")) {
      chmodSync(destinationBinary, 0o755);
    }
  }
}

execFileSync("cargo", cargoArgs, { stdio: "inherit" });

for (const sidecar of sidecars) {
  const sourceBinary = join(tauriDir, "target", profile, `${sidecar}${extension}`);
  const destinationBinary = join(binariesDir, `${sidecar}-${targetTriple}${extension}`);

  if (!existsSync(sourceBinary)) {
    throw new Error(`${sidecar} binary was not built: ${sourceBinary}`);
  }

  if (!statSync(sourceBinary).isFile()) {
    throw new Error(`${sidecar} path is not a file: ${sourceBinary}`);
  }

  copyFileSync(sourceBinary, destinationBinary);

  if (!targetTriple.includes("windows")) {
    chmodSync(destinationBinary, 0o755);
  }

  console.log(`Prepared ${sidecar} sidecar: ${destinationBinary}`);
}
