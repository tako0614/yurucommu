import { uploadMedia, validateFile } from "@takosjp/yurucommu-api";

const transportNames: Readonly<Record<string, string>> = {
  "image/jpeg": "media.jpg",
  "image/png": "media.png",
  "image/gif": "media.gif",
  "image/webp": "media.webp",
  "video/mp4": "media.mp4",
  "video/webm": "media.webm",
};

/**
 * Package a product File with an ASCII basename because the published SDK
 * validates multipart filenames even though the server derives its object key
 * and extension from MIME type. The original File remains owned by its caller.
 */
export async function uploadProductMedia(
  file: File,
  mayUpload: () => boolean = () => true,
) {
  const transportName = transportNames[file.type] ?? "media.bin";
  const validationFile = new Proxy(file, {
    get(target, property) {
      if (property === "name") return transportName;
      return Reflect.get(target, property, target);
    },
  });

  // Keep the published SDK's MIME and size policy before reading/copying bytes.
  // Only the validation view changes the name; it is never appended to FormData.
  validateFile(validationFile);

  const bytes = await file.arrayBuffer();
  // Reading a File yields. Never resolve the SDK's mutable transport for a
  // composition whose originating authentication/instance has since changed.
  if (!mayUpload()) throw new Error("Media upload scope changed");
  const transportFile = new File([bytes], transportName, {
    type: file.type,
    lastModified: file.lastModified,
  });
  const result = await uploadMedia(transportFile);
  // API4.1.11 forwards the upload JSON but predates this optional declaration.
  // Accept only an advertised valid deadline; older servers have no deadline.
  const expiresAt = (result as typeof result & { expires_at?: unknown })
    .expires_at;
  return {
    ...result,
    expires_at:
      typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt))
        ? expiresAt
        : undefined,
  };
}
