import type { ReferenceImage } from "../contracts";
import { bytesToBase64 } from "./media";

export interface PreparedReference extends ReferenceImage { name: string; previewUrl: string }

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 512 * 1024;
const READ_ERROR = "This image could not be read. Choose another JPEG, PNG, or WebP image.";

/** Decode locally and re-encode oriented pixels without retaining file metadata. */
export async function prepareReferenceImage(file: File): Promise<PreparedReference> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Choose an image smaller than 10 MiB.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  }
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = file.type === "image/jpeg" ? header[0] === 255 && header[1] === 216 && header[2] === 255
    : file.type === "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte)
      : String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
  if (!signature) throw new Error(READ_ERROR);

  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(READ_ERROR);
    const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
    let width = Math.max(1, Math.round(image.naturalWidth * scale));
    let height = Math.max(1, Math.round(image.naturalHeight * scale));
    let quality = 0.88;
    for (let attempt = 0; attempt < 12; attempt++) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error(READ_ERROR);
      context.fillStyle = "white";
      context.fillRect(0, 0, width, height);
      // Image decoding applies EXIF orientation; the reference is never mirrored.
      context.drawImage(image, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob || blob.type !== "image/jpeg") throw new Error(READ_ERROR);
      if (blob.size <= MAX_REFERENCE_BYTES) {
        const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
        return { data, mimeType: "image/jpeg", name: file.name, previewUrl: `data:image/jpeg;base64,${data}` };
      }
      if (quality > 0.5) quality -= 0.14;
      else { width = Math.max(1, Math.round(width * 0.8)); height = Math.max(1, Math.round(height * 0.8)); }
    }
    throw new Error(READ_ERROR);
  } catch {
    throw new Error(READ_ERROR);
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 1;
  }
}
