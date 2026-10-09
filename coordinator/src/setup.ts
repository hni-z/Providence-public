import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dataDir, loadConfig, saveConfig } from "./config.js";
mkdirSync(dataDir, { recursive: true });
const file = resolve(dataDir, "config.json");
if (!existsSync(file)) {
  const config = {
    clientToken: randomBytes(32).toString("hex"),
    localDeviceId: "mac",
    localDeviceName: hostname(),
    workspace: resolve(
      process.env.PROVIDENCE_WORKSPACE ?? resolve(dataDir, "workspace"),
    ),
    devices: [],
  };
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const flag = process.argv.indexOf("--device");
if (flag !== -1) {
  const id = process.argv[flag + 1];
  if (!id || !/^[\w-]+$/.test(id))
    throw new Error("Provide a device ID, e.g. --device windows");
  const config = loadConfig();
  if (id === config.localDeviceId)
    throw new Error("Device ID is already local");
  if (!config.devices.find((d) => d.id === id)) {
    config.devices.push({
      id,
      name: id,
      token: randomBytes(32).toString("hex"),
    });
    saveConfig(file, config);
  }
  const d = config.devices.find((d) => d.id === id)!;
  const target = resolve(dataDir, `${id}.device.json`);
  writeFileSync(
    target,
    JSON.stringify(
      {
        deviceId: id,
        token: d.token,
        url: "wss://YOUR_PRIVATE_COORDINATOR/worker",
        workspace: "CHANGE_TO_LOCAL_WORKSPACE",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `Enrollment file created: ${target}. Transfer privately to the device; do not commit. Restart coordinator after enrollment.`,
  );
}
console.log(
  `Ready: ${file}. Client token remains in that local file; never commit it.`,
);
