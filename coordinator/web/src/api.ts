export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message);
  }
}
// A request held open without ever answering, which a Wi-Fi handover or a
// dropped tunnel produces, must still settle so the next poll round can run.
export const REQUEST_TIMEOUT_MS = 10_000;
export const HOSTED_ACCOUNT_SESSION = "providence-account-session";
export const sessionCredentials = (token: string): RequestCredentials =>
  token === HOSTED_ACCOUNT_SESSION ? "same-origin" : "omit";

export function apiPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f#]/.test(path))
    throw new Error("Use a coordinator-relative API path.");
  const full = `/v1${path}`;
  const checked = new URL(full, "https://providence.invalid");
  if (!checked.pathname.startsWith("/v1/") || checked.pathname !== full.split("?")[0])
    throw new Error("Use a coordinator-relative API path.");
  return full;
}
const bounded = (signal?: AbortSignal) => {
  const budget = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, budget]) : budget;
};
export async function api<T>(
  token: string,
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(apiPath(path), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    credentials: sessionCredentials(token),
    mode: "same-origin",
    referrerPolicy: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal: bounded(signal),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any;
  try { data = await response.json(); }
  catch { throw new ApiError("The coordinator returned an unreadable response. Please try again.", response.ok ? 502 : response.status); }
  if (!response.ok && data?.errorCode === "ai_consent_required")
    throw new ApiError("Allow OpenAI processing in Account before sending messages or using voice.", response.status, "ai_consent_required");
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status})`,
      response.status,
    );
  return data as T;
}
export async function exchangeClientCode(
  code: string,
): Promise<{ token: string; expiresAt: string }> {
  const response = await fetch("/client/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    mode: "same-origin",
    referrerPolicy: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal: bounded(),
    body: JSON.stringify({ code }),
  });
  const data = await response.json().catch(() => ({
    error: "The coordinator returned an unreadable response.",
  }));
  if (!response.ok && data?.errorCode === "ai_consent_required")
    throw new ApiError("Allow OpenAI processing in Account before sending messages or using voice.", response.status, "ai_consent_required");
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Client code exchange failed (${response.status})`,
      response.status,
    );
  if (
    typeof data.token !== "string" ||
    !data.token ||
    typeof data.expiresAt !== "string"
  )
    throw new Error("The coordinator returned an invalid client session.");
  return data;
}

// A large artifact can legitimately outlast the request budget, so its caller
// supplies the deadline instead of inheriting one.
export async function artifactBlob(
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/v1/artifacts/${encodeURIComponent(id)}/content`,
    {
      headers: { Authorization: `Bearer ${token}` },
      credentials: sessionCredentials(token),
      mode: "same-origin",
      referrerPolicy: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error ?? "This file is currently unavailable.",
      response.status,
    );
  }
  return response.blob();
}
export const active = (status: string) =>
  ["queued", "running", "needs_input"].includes(status);
export function statusLabel(status: string) {
  return (
    (
      {
        needs_input: "Needs your input",
        completed: "Agent finished",
        running: "Working",
        queued: "Queued",
        failed: "Failed",
        cancelled: "Cancelled",
        interrupted: "Interrupted",
        offline: "Offline",
      } as Record<string, string>
    )[status] ?? status.replaceAll("_", " ")
  );
}
export function timeLabel(date: string) {
  return new Date(date).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
export function fileSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
