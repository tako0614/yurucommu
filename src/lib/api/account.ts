export {
  fetchAlsoKnownAs,
  moveAccount,
  setAlsoKnownAs,
} from "@takosjp/yurucommu-api";
import { apiFetch, assertOk } from "@takosjp/yurucommu-api";

/**
 * Trigger a download of the actor's personal-portability JSON archive.
 *
 * This is intentionally kept in the web client shim because it depends on the
 * browser DOM. The shared npm API package stays transport/type focused.
 */
export async function downloadDataExport(): Promise<void> {
  const res = await apiFetch("/api/actors/me/export");
  await assertOk(res, "Failed to export data");

  const blob = await res.blob();
  const filename = parseFilename(res.headers.get("Content-Disposition"));
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function parseFilename(disposition: string | null): string {
  const fallback = "yurucommu-export.json";
  if (!disposition) return fallback;
  const match = disposition.match(/filename="?([^"]+)"?/);
  return match?.[1] || fallback;
}
