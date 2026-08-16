// Client-side media prep for camera captures and uploads.

export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // hub accepts 25mb raw bodies

// Downscale big photos before upload: camera stills are often 5-12MB, but
// uploads should be fast on mobile data and Claude vision only reads images
// under ~4.5MB. Videos and small images pass through untouched.
export async function prepareMedia(file: File): Promise<File> {
  const needsConvert = file.type === "image/heic" || file.type === "image/heif";
  if (
    !file.type.startsWith("image/") ||
    file.type === "image/gif" ||
    (!needsConvert && file.size < 3.5 * 1024 * 1024)
  ) {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (blob && (needsConvert || blob.size < file.size)) {
      return new File([blob], "photo.jpg", { type: "image/jpeg" });
    }
  } catch {
    // Format the browser can't decode (rare HEIC edge case) - upload as-is.
  }
  return file;
}
