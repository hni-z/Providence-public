export const SPATIAL_ACCOUNT_HREF = "/account?next=%2Fmeta";

/** Hosted pages use passkey accounts, never the private coordinator's key form. */
export function hostedAccountMode(hostname: string, session?: unknown): boolean {
  return ["providence.hani.so", "htn.hani.so"].includes(hostname.toLowerCase()) ||
    (!!session && typeof session === "object" && !Array.isArray(session) && (session as { hosted?: unknown }).hosted === true);
}
/** Storage denial must not prevent clearing visible state after logout/expiry. */
export function clearSpatialLogin(storage: () => Pick<Storage, "removeItem">): void {
  for (const key of ["providence.quest.session", "providence.quest.pending"]) {
    try { storage().removeItem(key); } catch { /* The caller must still retire in-memory state and media. */ }
  }
}
