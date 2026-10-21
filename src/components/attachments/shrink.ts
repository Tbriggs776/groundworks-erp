/**
 * Phone photos are often 3 to 12 MB; uploads are capped at 4 MB. Large
 * JPEG, PNG, and WebP images are redrawn at most 2400 px on the long side as
 * JPEG before they're sent, which keeps receipts sharp enough to read.
 */
export async function shrinkImage(file: File, maxSide = 2400, quality = 0.85): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_500_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.gif,.csv,.txt,.xlsx,.docx,application/pdf,image/jpeg,image/png,image/webp,image/gif";

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
