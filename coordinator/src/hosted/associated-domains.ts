const APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

/** Only explicitly configured, concrete signed application identifiers are trusted. */
export function validateAppleAppIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || id.length > 266 || !APP_ID.test(id))) {
    throw new Error("Invalid PROVIDENCE_APPLE_APP_IDS: use exact App ID prefix.bundle-identifier values without wildcards.");
  }
  return [...new Set(value)];
}

export function appleAppIdsFromEnvironment(value: string | undefined): string[] {
  return validateAppleAppIds(value?.trim() ? value.split(",").map(id => id.trim()) : undefined);
}

export function appleAssociationDocument(appIds: readonly string[] | undefined): string | undefined {
  const apps = validateAppleAppIds(appIds);
  return apps.length ? JSON.stringify({ webcredentials: { apps } }) + "\n" : undefined;
}
