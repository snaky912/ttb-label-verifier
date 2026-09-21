/**
 * Client-side image downscaling.
 *
 * Latency was the reason the previous vendor pilot failed, so the cheapest
 * available win is not sending eight megabytes of phone photograph across
 * a government WAN. Label text stays legible well below the resolution a
 * modern phone produces, so images are capped on the long edge before
 * they leave the browser.
 *
 * Falls back to the original file on any failure: a slightly slower check
 * is much better than a failed one.
 */

export async function downscaleImage(file, maxEdge = 1600, quality = 0.85) {
  try {
    if (!file.type.startsWith('image/')) return file;

    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= maxEdge) {
      bitmap.close?.();
      return file;
    }

    const scale = maxEdge / longest;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    return blob;
  } catch {
    return file;
  }
}
