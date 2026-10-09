import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export function runtimeNotices(root) {
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  const sections = ["Third-party software used by this Providence interface\n\nThese notices apply to the listed dependencies. Providence's own source license remains unchanged.\n"];
  for (const [path, entry] of Object.entries(lock.packages ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.startsWith("node_modules/") || entry.dev) continue;
    const directory = resolve(root, path), local = relative(resolve(root), directory);
    if (local.startsWith("..") || isAbsolute(local) || path.split("/").includes("..")) throw new Error("Invalid dependency path in package lock");
    const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    const files = readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && /^(licen[cs]e|copying)([.-]|$)/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) throw new Error(`Missing license text for ${manifest.name}`);
    const notices = files.map(file => readFileSync(resolve(directory, file.name), "utf8").trim());
    if (notices.some(text => !text || Buffer.byteLength(text) > 128_000)) throw new Error(`Invalid license text for ${manifest.name}`);
    sections.push(`\n${"=".repeat(72)}\n${manifest.name} ${manifest.version}\nLicense: ${manifest.license ?? entry.license ?? "See below"}\n\n${notices.join("\n\n")}\n`);
  }
  return sections.join("");
}

/** Include exact locked runtime dependency notices without adding them to the JS payload. */
export function runtimeNoticesPlugin(root, base = "/") {
  return {
    name: "providence-runtime-notices",
    apply: "build",
    enforce: "post",
    generateBundle: { order: "post", handler(_options, bundle) {
      const source = runtimeNotices(root);
      const fileName = `assets/third-party-notices-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.txt`;
      this.emitFile({ type: "asset", fileName, source });
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset" || !item.fileName.endsWith(".html") || typeof item.source !== "string") continue;
        item.source = item.source.replace("</head>", `    <link rel="license" href="${base}${fileName}" />\n  </head>`)
          .replaceAll("__PROVIDENCE_LICENSE_NOTICES__", base + fileName);
      }
    } },
  };
}
