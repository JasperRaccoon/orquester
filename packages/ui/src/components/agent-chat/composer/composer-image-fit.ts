/**
 * Downscale a large photo before the composer uploads it (agent-chat images
 * only; file-browser and terminal uploads keep their bytes).
 *
 * A 12 MP phone photo is several megabytes over cellular, and providers cap an
 * image's long edge anyway, so a PNG or JPEG over `IMAGE_ATTACHMENT_MAX_EDGE`
 * is redrawn at that edge: JPEG at quality 0.85, PNG as PNG so transparency
 * survives. Everything else keeps its original bytes: GIF, WebP and SVG, an
 * animated PNG, an image that already fits, one the browser cannot decode, and
 * any result that would not be smaller.
 *
 * Browser decoding applies EXIF orientation before the resized image is drawn.
 */

/**
 * Anthropic rejects an image over 2000px on a side once a request holds more
 * than 20 images, and Claude Code forwards images sent into a running turn
 * unchanged, so one large paste breaks every later request in that thread.
 */
// Adapted from T3 Code (MIT): packages/client-runtime/src/imageAttachmentSize.ts
const IMAGE_ATTACHMENT_MAX_EDGE = 2000;

// Adapted from T3 Code (MIT): apps/mobile/src/lib/composerImageFit.ts
const PHOTO_JPEG_QUALITY = 0.85;

type DownscalableImageMimeType = "image/png" | "image/jpeg";

export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

/** The size to draw at, or null when the image already fits. */
function fitImageAttachmentSize(size: {
  readonly width: number;
  readonly height: number;
}): { width: number; height: number } | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null;
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.height * scale)))
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Whether a PNG is an APNG: an `acTL` chunk before the first `IDAT`. A canvas
 * would keep only its first frame. Bytes that are not a readable PNG count as
 * animated, so an unknown file is left alone rather than flattened.
 */
function isAnimatedPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return true;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return true;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length;
  }
  return true;
}

const EXTENSIONS: Record<DownscalableImageMimeType, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg", "jpe", "jfif"],
  "image/png": ["png"]
};

/** `name` with an extension that matches `mimeType` (kept when it already does). */
function downscaledFileName(name: string, mimeType: DownscalableImageMimeType): string {
  const allowed = EXTENSIONS[mimeType];
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (allowed.includes(extension)) return name;
  return `${stem || "image"}.${allowed[0]}`;
}

/** A decoded image, already turned upright by its EXIF orientation. */
interface DecodedImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

interface ImageCodec<D extends DecodedImage = DecodedImage> {
  decode(file: Blob): Promise<D>;
  encode(
    image: D,
    size: { width: number; height: number },
    mimeType: DownscalableImageMimeType,
    quality: number
  ): Promise<Blob | null>;
}

/**
 * The file to upload for `file`: a smaller re-encode when it is a large PNG or
 * JPEG, otherwise `file` itself. Never throws; a failure keeps the original.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  const codec = browserImageCodec();
  const mimeType = downscalableImageMimeType(file.type);
  if (mimeType === null || codec === null) return file;
  try {
    if (mimeType === "image/png" && isAnimatedPng(new Uint8Array(await file.arrayBuffer()))) {
      return file;
    }
    const image = await codec.decode(file);
    let blob: Blob | null;
    try {
      const size = fitImageAttachmentSize(image);
      if (size === null) return file;
      blob = await codec.encode(image, size, mimeType, PHOTO_JPEG_QUALITY);
    } finally {
      image.close();
    }
    // An engine that cannot encode the type hands back another one (PNG).
    if (!blob || blob.type !== mimeType || blob.size === 0 || blob.size >= file.size) return file;
    return new File([blob], downscaledFileName(file.name, mimeType), {
      type: mimeType,
      lastModified: file.lastModified
    });
  } catch {
    return file;
  }
}

// ---------------------------------------------------------------------------
// The browser seam: decode with EXIF orientation applied, draw at the target
// size, encode. Null where there is no canvas (tests, SSR).
// ---------------------------------------------------------------------------

interface BrowserImage extends DecodedImage {
  readonly source: CanvasImageSource;
}

async function decodeWithImageElement(file: Blob): Promise<BrowserImage> {
  // An <img> honours EXIF orientation (CSS `image-orientation: from-image`).
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    close: () => URL.revokeObjectURL(url)
  };
}

function browserImageCodec(): ImageCodec<BrowserImage> | null {
  if (typeof document === "undefined" && typeof OffscreenCanvas === "undefined") return null;
  return {
    async decode(file) {
      if (typeof createImageBitmap === "function") {
        try {
          // An engine that does not know `from-image` rejects the option.
          const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            close: () => bitmap.close()
          };
        } catch {
          /* fall through to <img> */
        }
      }
      return decodeWithImageElement(file);
    },
    async encode(image, size, mimeType, quality) {
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(size.width, size.height);
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.imageSmoothingQuality = "high";
        context.drawImage(image.source, 0, 0, size.width, size.height);
        return canvas.convertToBlob({ type: mimeType, quality });
      }
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.imageSmoothingQuality = "high";
      context.drawImage(image.source, 0, 0, size.width, size.height);
      return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
    }
  };
}
