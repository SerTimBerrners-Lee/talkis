import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriDir = join(rootDir, "src-tauri");
const binariesDir = join(tauriDir, "binaries");
const commonLibraryDirectories = [
  "/lib",
  "/lib64",
  "/lib/aarch64-linux-gnu",
  "/lib/arm-linux-gnueabihf",
  "/lib/x86_64-linux-gnu",
  "/usr/lib",
  "/usr/lib64",
  "/usr/lib/aarch64-linux-gnu",
  "/usr/lib/arm-linux-gnueabihf",
  "/usr/lib/llvm-18/lib",
  "/usr/lib/llvm-17/lib",
  "/usr/lib/llvm-16/lib",
  "/usr/lib/llvm-15/lib",
  "/usr/lib/llvm-14/lib",
  "/usr/lib/x86_64-linux-gnu",
  "/usr/local/lib",
];

function directoryHasMatchingFile(directory, matches) {
  if (!directory || !existsSync(directory)) return false;

  try {
    return readdirSync(directory).some(matches);
  } catch {
    return false;
  }
}

function directoryHasLibclang(directory) {
  return directoryHasMatchingFile(directory, (name) => (
    name === "libclang.so"
    || name.startsWith("libclang.so.")
    || (name.startsWith("libclang-") && name.includes(".so"))
  ));
}

function splitPathList(value) {
  if (!value) return [];
  return value.split(delimiter).filter(Boolean);
}

function librarySearchDirectories() {
  return [
    ...splitPathList(process.env.LIBRARY_PATH),
    ...splitPathList(process.env.LD_LIBRARY_PATH),
    ...commonLibraryDirectories,
  ];
}

function hasLibraryFile(fileName) {
  return librarySearchDirectories().some((directory) => (
    directoryHasMatchingFile(directory, (name) => name === fileName)
  ));
}

function compilerCanFindLibraryFile(fileName) {
  for (const compiler of ["cc", "gcc"]) {
    const result = spawnSync(compiler, ["-print-file-name=" + fileName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (result.error || result.status !== 0) continue;

    const resolvedPath = result.stdout.trim();
    if (resolvedPath && resolvedPath !== fileName && existsSync(resolvedPath)) {
      return true;
    }
  }

  return false;
}

function hasLinkableLibrary(libraryName) {
  const fileName = `lib${libraryName}.so`;
  return hasLibraryFile(fileName) || compilerCanFindLibraryFile(fileName);
}

function hasLibclang() {
  if (directoryHasLibclang(process.env.LIBCLANG_PATH)) {
    return true;
  }

  return librarySearchDirectories().some(directoryHasLibclang);
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function ensureLinuxBuildDependencies(targetTriple) {
  if (!targetTriple.includes("linux")) return;

  const missingPackages = [];

  if (!hasLibclang()) {
    missingPackages.push("clang", "libclang-dev");
  }

  if (!commandExists("cmake")) {
    missingPackages.push("cmake");
  }

  if (!hasLinkableLibrary("xdo")) {
    missingPackages.push("libxdo-dev");
  }

  if (missingPackages.length === 0) return;

  console.error("");
  console.error("Missing Linux build dependencies for local STT sidecars.");
  console.error("whisper-rs-sys needs libclang for bindgen, cmake for whisper.cpp, and xdo for Tauri/global hotkey linking.");
  console.error("Install it on Ubuntu/Debian with:");
  console.error("");
  console.error(`  sudo apt update && sudo apt install -y ${missingPackages.join(" ")}`);
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
ensureLinuxBuildDependencies(targetTriple);

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
