import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { saveConfig } from "./config.js";
import type { Coordinator } from "./coordinator.js";
export class Pairing {
  private codes = new Map<string, { name: string; expiresAt: number }>();
  constructor(
    readonly app: Coordinator,
    readonly publicOrigin?: string,
  ) {}
  issue(name: string) {
    if (!this.publicOrigin?.startsWith("https://"))
      throw new Error(
        "Configure a reachable HTTPS public origin before pairing a remote device",
      );
    for (const [code, p] of this.codes)
      if (p.expiresAt < Date.now()) this.codes.delete(code);
    if (this.codes.size >= 10)
      throw new Error("Too many pending pairing codes");
    const code = randomBytes(6).toString("hex").toUpperCase();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.codes.set(code, { name, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  exchange(input: string) {
    const code = input.replace(/[\s-]/g, "").toUpperCase();
    const p = this.codes.get(code);
    if (!p || p.expiresAt < Date.now())
      throw new Error("Pairing code is invalid or expired");
    this.codes.delete(code);
    const deviceId = "device-" + randomBytes(6).toString("hex");
    const device = {
      id: deviceId,
      name: p.name,
      token: randomBytes(32).toString("hex"),
    };
    this.app.config.devices.push(device);
    this.persist();
    this.app.devices.registered.push({ id: device.id, name: device.name });
    this.app.store.event({
      type: "device.paired",
      deviceId,
      name: device.name,
    });
    return {
      deviceId,
      token: device.token,
      url: this.publicOrigin!.replace(/^https:/, "wss:") + "/worker",
    };
  }
  revoke(id: string) {
    if (id === this.app.config.localDeviceId)
      throw new Error("The coordinator device cannot be revoked");
    if (!this.app.config.devices.some((d) => d.id === id))
      throw new Error("Unknown device");
    const previous = this.app.config.devices;
    this.app.config.devices = previous.filter(
      (d) => d.id !== id,
    );
    try { this.persist(); }
    catch (error) { this.app.config.devices = previous; throw error; }
    const index = this.app.devices.registered.findIndex((d) => d.id === id);
    if (index >= 0) this.app.devices.registered.splice(index, 1);
    this.app.devices.disconnect(id);
    this.app.store.event({ type: "device.revoked", deviceId: id });
    return { revoked: true };
  }
  private persist() {
    saveConfig(resolve(this.app.directory, "config.json"), this.app.config);
  }
}
