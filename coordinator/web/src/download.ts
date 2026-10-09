// Safari on iOS ignores a click on an anchor that was never in the document,
// and revoking the object URL while the browser is still writing the file
// truncates the saved download.
export const REVOKE_AFTER_MS = 30_000;
export function downloadBlob(blob: Blob, name: string, doc: Document = document) {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = name;
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
