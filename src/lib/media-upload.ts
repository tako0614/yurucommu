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
export async function uploadProductMedia(file: File) {
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
  const transportFile = new File([bytes], transportName, {
    type: file.type,
    lastModified: file.lastModified,
  });
  return uploadMedia(transportFile);
}
