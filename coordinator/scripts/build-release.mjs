#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), "../..");
const help = `Usage: node coordinator/scripts/build-release.mjs [--output NEW_DIRECTORY]

Stage committed, clean Git HEAD and build an immutable Providence release.
Default: coordinator/.providence/releases/<full-commit-sha>
Requires Node.js 22.12+ (or a newer major), npm, Git and tar.
Runs npm ci for coordinator, web and Quest, backend checks/tests, available
frontend tests, and both production builds. There is no skip-tests option.
Never overwrites, deploys, restarts, copies private state or changes routing.
Success prints only the release directory, manifest path and manifest JSON.
`;

function git(args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Git command failed: ${args[0]}`);
  return result.stdout;
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

/** Read the actual module entry referenced by Vite's generated index.html. */
export function readEntry(coordinator, name, base) {
  const dist = resolve(coordinator, name, "dist");
  const html = readFileSync(resolve(dist, "index.html"), "utf8");
  const entries = [...html.matchAll(/<script\b([^>]*)>/gi)]
    .filter(match => /\btype\s*=\s*["']module["']/i.test(match[1]))
    .map(match => /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1])
    .filter(Boolean);
  if (entries.length !== 1) throw new Error(`${name} must have exactly one built module entry`);
  const url = new URL(entries[0], `https://release.invalid${base}`);
  if (url.origin !== "https://release.invalid" || !url.pathname.startsWith(base) || url.search || url.hash)
    throw new Error(`${name} entry is outside its expected build base`);
  const file = resolve(dist, decodeURIComponent(url.pathname.slice(base.length)));
  if (!inside(dist, file) || !inside(realpathSync(dist), realpathSync(file)) || !statSync(file).isFile())
    throw new Error(`${name} entry must be a regular file inside its dist directory`);
  const bytes = readFileSync(file);
  if (!bytes.length) throw new Error(`${name} entry is empty`);
  return { path: relative(coordinator, file).split(sep).join("/"), url: url.pathname,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

function buildEnvironment(scratch, commit) {
  // Retain OS/tool lookup paths unchanged; do not forward provider credentials,
  // inherited VITE_* values, Codex session metadata or production configuration.
  const env = {};
  for (const name of ["PATH", "Path", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "SHELL", "LANG", "LC_ALL"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const npmrc = resolve(scratch, "empty.npmrc");
  writeFileSync(npmrc, "", { flag: "wx", mode: 0o600 });
  return { ...env, CI: "true", NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_CACHE: resolve(scratch, "npm-cache"), VITE_RELEASE_COMMIT: commit };
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(help);
    return;
  }
  let requestedOutput;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--output" && requestedOutput === undefined) requestedOutput = args[++index];
    else if (arg.startsWith("--output=") && requestedOutput === undefined) requestedOutput = arg.slice(9);
    else throw new Error("Unknown or repeated option. Use --help.");
    if (!requestedOutput || requestedOutput.startsWith("--")) throw new Error("--output requires a new directory path");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error("Use Node.js 22.12+ or a newer major for the current Quest toolchain");
  if (resolve(git(["rev-parse", "--show-toplevel"]).trim()) !== repository)
    throw new Error("Run the release builder from its committed Providence repository");
  if (git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]).length)
    throw new Error("Release refused: Git has tracked or untracked changes. Commit and review the intended sources first.");
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Unable to resolve a committed HEAD");
  const tree = git(["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean);
  for (const record of tree) {
    const [metadata, path] = record.split("\t");
    const mode = metadata.split(" ")[0];
    if (mode === "120000" || mode === "160000")
      throw new Error("Release staging does not accept source symlinks or unarchived submodules");
    const parts = path.split("/");
    const name = parts.at(-1);
    if (parts.some(part => [".providence", ".git", ".ssh", ".aws", "node_modules", ".release-build"].includes(part)) ||
        ["auth.json", "state.json", "config.json", ".npmrc"].includes(name) ||
        ((/(^|\.)env$/.test(name) || /^\.env(?:\.|$)/.test(name)) && !name.endsWith(".example")) ||
        name.endsWith(".device.json") || path === "coordinator/release.json")
      throw new Error("Release refused: committed private/configuration state or a generated release manifest was found. Review the source tree.");
  }
  const output = requestedOutput ? resolve(requestedOutput) : resolve(repository, "coordinator/.providence/releases", commit);
  if (existsSync(output)) throw new Error("Release output already exists; refusing to overwrite it");
  if (inside(repository, output)) {
    const ignored = spawnSync("git", ["check-ignore", "-q", "--", relative(repository, resolve(output, "release-probe"))], { cwd: repository });
    if (ignored.status !== 0) throw new Error("An output inside the checkout must be Git-ignored; otherwise choose a directory outside it");
  }
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 }); // Exclusive creation; never reuse an existing release.
  const scratch = resolve(output, ".release-build");
  mkdirSync(scratch, { mode: 0o700 });
  const log = resolve(scratch, "build.log");
  const logFd = openSync(log, "wx", 0o600);
  const env = buildEnvironment(scratch, commit);
  let stage = "source archive";
  function run(command, commandArgs, cwd, commandEnv = env) {
    // Children inherit this fd and write at its own offset; a path append would sit
    // at end of file and be overwritten by the first child output.
    writeSync(logFd, `\n[${stage}]\n`);
    const result = spawnSync(command, commandArgs, { cwd, env: commandEnv,
      stdio: ["ignore", logFd, logFd], shell: process.platform === "win32" && command === "npm.cmd" });
    if (result.error || result.status !== 0) throw new Error(`Release failed during ${stage}. Inspect ${log}. The incomplete directory was preserved; no manifest was published.`);
  }
  try {
    const archive = resolve(scratch, "source.tar");
    run("git", ["archive", "--format=tar", `--output=${archive}`, commit], repository);
    stage = "source extraction";
    run("tar", ["-xf", archive, "-C", output], repository);
    unlinkSync(archive);
    const coordinator = resolve(output, "coordinator");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packages = [["coordinator", coordinator], ["web", resolve(coordinator, "web")], ["quest", resolve(coordinator, "quest")]];
    const manifests = new Map();
    for (const [name, cwd] of packages) {
      manifests.set(name, JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")));
      if (!existsSync(resolve(cwd, "package-lock.json"))) throw new Error(`${name} has no committed npm lockfile`);
      stage = `${name}: npm ci`;
      run(npm, ["ci", "--include=dev", "--no-audit", "--no-fund"], cwd);
    }
    for (const [name, scriptName] of [["coordinator", "check"], ["coordinator", "test"], ["coordinator", "test:watch-pairing"], ["web", "test"], ["quest", "test"], ["web", "build"], ["quest", "build"]]) {
      if (name === "web" && scriptName === "test" && !manifests.get(name).scripts?.test) continue;
      if (!manifests.get(name).scripts?.[scriptName]) throw new Error(`Required ${name}:${scriptName} script is missing`);
      stage = `${name}: ${scriptName}`;
      run(npm, ["run", scriptName], packages.find(([candidate]) => candidate === name)[1]);
    }
    const manifest = { schemaVersion: 1, commit, builtAt: new Date().toISOString(), nodeVersion: process.versions.node,
      webEntry: readEntry(coordinator, "web", "/"), questEntry: readEntry(coordinator, "quest", "/quest/") };
    const manifestPath = resolve(coordinator, "release.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
    process.stdout.write(JSON.stringify({ releaseDirectory: output, manifestPath, manifest }, null, 2) + "\n");
  } finally { closeSync(logFd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "Release staging failed") + "\n"); process.exitCode = 1; }
}
