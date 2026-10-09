/** Providence-only settings; never write to the user's global Codex configuration. */
export type RuntimeProfile = Readonly<{
  model: string;
  reasoningEffort: string;
  serviceTier: string;
}>;

export const defaultRuntimeProfile: RuntimeProfile = Object.freeze({
  model: "gpt-6-sol",
  reasoningEffort: "low",
  // The installed model catalog calls this tier Fast. It is not a latency guarantee.
  serviceTier: "priority",
});

export function readRuntimeProfile(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Pick<RuntimeProfile, "model" | "reasoningEffort">> = {},
): RuntimeProfile {
  const value = (name: string, fallback: string, pattern: RegExp, override?: string): string => {
    const configured = override ?? env[name];
    if (configured === undefined) return fallback;
    if (!pattern.test(configured))
      throw new Error(`${name} must be an exact, nonempty Codex catalog value.`);
    return configured;
  };
  return Object.freeze({
    model: value("PROVIDENCE_MODEL", defaultRuntimeProfile.model, /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/, overrides.model),
    reasoningEffort: value("PROVIDENCE_REASONING_EFFORT", defaultRuntimeProfile.reasoningEffort, /^[a-z][a-z0-9_-]{0,63}$/, overrides.reasoningEffort),
    serviceTier: value("PROVIDENCE_SERVICE_TIER", defaultRuntimeProfile.serviceTier, /^[a-z][a-z0-9_-]{0,63}$/),
  });
}

/** Validate against this device's authenticated catalog, without starting a model turn. */
export async function verifyRuntimeProfileAvailable(
  profile: RuntimeProfile,
  call: (method: string, params: any) => Promise<any>,
): Promise<void> {
  let cursor: string | undefined;
  const visited = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = await call("model/list", { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data))
      throw new Error("The runtime did not return a model catalog. Providence did not select a fallback profile.");
    const model = result.data.find((entry: any) => entry?.model === profile.model);
    if (model) {
      if (!Array.isArray(model.supportedReasoningEfforts) ||
          !model.supportedReasoningEfforts.some((entry: any) => entry?.reasoningEffort === profile.reasoningEffort))
        throw new Error(`Providence reasoning effort ${profile.reasoningEffort} is not supported by ${profile.model} on this device.`);
      if (!Array.isArray(model.serviceTiers) ||
          !model.serviceTiers.some((entry: any) => entry?.id === profile.serviceTier))
        throw new Error(`Providence service tier ${profile.serviceTier} is not advertised for ${profile.model} on this device. No fallback was selected.`);
      return;
    }
    if (result.nextCursor === null || result.nextCursor === undefined) break;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || visited.has(result.nextCursor))
      throw new Error("The runtime returned invalid model catalog pagination.");
    cursor = result.nextCursor;
    visited.add(result.nextCursor);
  }
  throw new Error(`Providence model ${profile.model} is not available in this device's model catalog. No fallback was selected.`);
}

export function threadRuntimeProfile(profile: RuntimeProfile) {
  return {
    model: profile.model,
    serviceTier: profile.serviceTier,
    config: { model_reasoning_effort: profile.reasoningEffort },
  };
}

export function turnRuntimeProfile(profile: RuntimeProfile) {
  return {
    model: profile.model,
    effort: profile.reasoningEffort,
    serviceTier: profile.serviceTier,
  };
}

/** Thread responses expose resolved settings; reject ignored overrides before a turn. */
export function verifyResolvedRuntimeProfile(profile: RuntimeProfile, result: any): void {
  if (result?.model !== profile.model || result?.reasoningEffort !== profile.reasoningEffort ||
      result?.serviceTier !== profile.serviceTier)
    throw new Error("The runtime did not confirm the configured Providence model, reasoning effort and service tier. No task was started.");
}
