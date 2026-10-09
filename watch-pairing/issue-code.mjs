import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const failure = "Could not issue a Watch pairing code. Check the local coordinator, private config, port and pending-code limit; no automatic retry was made.";

// Run on the coordinator host. The reusable key stays in memory and goes only
// to its loopback HTTP listener, never a user-supplied host or a redirect.
export async function issueCode({
  dataDirectory = process.env.PROVIDENCE_DATA_DIR ?? ".providence",
  port = process.env.PORT ?? "8787",
  name = "Watch",
  fetchImpl = fetch,
} = {}) {
  try {
    if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
      throw new Error(failure);
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
      throw new Error(failure);
    const { clientToken } = JSON.parse(await readFile(resolve(dataDirectory, "config.json"), "utf8"));
    if (typeof clientToken !== "string" || clientToken.length < 32 || /[\r\n]/.test(clientToken))
      throw new Error(failure);
    const response = await fetchImpl(`http://127.0.0.1:${Number(port)}/v1/clients/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 201) throw new Error(failure);
    const result = await response.json();
    if (typeof result.code !== "string" || !/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(result.code))
      throw new Error(failure);
    const expiry = typeof result.expiresAt === "string" ? Date.parse(result.expiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 10 * 60 * 1000 + 5000)
      throw new Error(failure);
    // Whitelist output; never echo server errors, config or extra fields.
    return { code: result.code, expiresAt: new Date(expiry).toISOString() };
  } catch {
    throw new Error(failure);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--name"))
      throw new Error(failure);
    const result = await issueCode({ name: args[1] ?? "Watch" });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write(failure + "\n");
    process.exitCode = 1;
  }
}
