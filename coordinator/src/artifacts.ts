import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Artifact, Store, Task } from "./store.js";

export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const mimeFor = (name: string) =>
  ({
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".css": "text/css",
    ".ts": "text/plain",
    ".py": "text/plain",
  })[extname(name).toLowerCase()] ?? "application/octet-stream";
export type ArtifactPayload = {
  path: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  base64: string;
};
export function within(root: string, target: string) {
  const r = relative(root, target);
  return (
    r !== ".." &&
    !r.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
    !isAbsolute(r)
  );
}
export function readWorkspaceArtifact(
  root: string,
  cwd: string,
  input: string,
): ArtifactPayload {
  root = realpathSync(root);
  if (!input || input.length > 4096)
    throw new Error("Provide an output file path");
  const path = realpathSync(resolve(cwd, input));
  if (!within(root, path))
    throw new Error("Artifact is outside the allowed device workspace");
  // Open the resolved path without following a newly substituted final symlink.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Artifact must be a regular file");
    if (stat.size > MAX_ARTIFACT_BYTES)
      throw new Error("Artifact exceeds the 512 KiB prototype limit");
    const bytes = Buffer.alloc(stat.size);
    let n = 0;
    while (n < bytes.length) {
      const count = readSync(fd, bytes, n, bytes.length - n, null);
      if (!count) break;
      n += count;
    }
    if (n !== stat.size || fstatSync(fd).size !== stat.size)
      throw new Error("File changed while being read; retry after saving");
    return {
      path: relative(root, path),
      name: basename(path),
      mime: mimeFor(path),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
    };
  } finally {
    closeSync(fd);
  }
}
export class Artifacts {
  constructor(
    readonly store: Store,
    readonly directory: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    store.state.artifacts ??= {};
  }
  save(task: Task, payload: ArtifactPayload): Artifact {
    if (
      !payload ||
      typeof payload.base64 !== "string" ||
      payload.base64.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4
    )
      throw new Error("Invalid artifact size");
    if (
      typeof payload.path !== "string" ||
      !payload.path ||
      payload.path.length > 4096 ||
      isAbsolute(payload.path) ||
      payload.path.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid artifact path");
    const bytes = Buffer.from(payload.base64, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.length !== payload.size ||
      bytes.length > MAX_ARTIFACT_BYTES ||
      sha256 !== payload.sha256
    )
      throw new Error("Artifact content failed integrity verification");
    const versions = Object.values(this.store.state.artifacts!).filter(
      (a) => a.chatId === task.chatId && a.path === payload.path,
    );
    const order = Object.keys(this.store.state.tasks);
    if (versions.some((a) => order.indexOf(a.taskId) > order.indexOf(task.id)))
      throw new Error("A newer task already delivered a revision of this file");
    const prior = versions.find(
      (a) => a.taskId === task.id && a.sha256 === sha256,
    );
    if (prior) return prior;
    const artifact: Artifact = {
      id: randomUUID(),
      taskId: task.id,
      chatId: task.chatId,
      deviceId: task.deviceId,
      path: payload.path,
      name: basename(payload.path.replaceAll("\\", "/")),
      mime: mimeFor(payload.path),
      size: bytes.length,
      sha256,
      revision: Math.max(0, ...versions.map((a) => a.revision)) + 1,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(resolve(this.directory, artifact.id), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    this.store.state.artifacts![artifact.id] = artifact;
    task.artifacts ??= [];
    task.artifacts.push(artifact);
    this.store.event({
      type: "artifact.verified",
      taskId: task.id,
      deviceId: task.deviceId,
      artifact,
    });
    return artifact;
  }
  get(id: string) {
    const a = this.store.state.artifacts![id];
    if (!a) throw new Error("Unknown artifact");
    return a;
  }
  content(id: string) {
    const a = this.get(id);
    const bytes = readFileSync(resolve(this.directory, a.id));
    if (createHash("sha256").update(bytes).digest("hex") !== a.sha256)
      throw new Error("Stored artifact integrity check failed");
    return { artifact: a, bytes };
  }
}
