// FFmpeg utility for Story composition
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./story-canvas.ts";

// Timeout constants
const FFMPEG_TIMEOUT = 120000; // 2 min (120s)
const FFMPEG_INIT_TIMEOUT = 60000; // 1 min (initialization)
const FFMPEG_DOWNLOAD_CORE_TIMEOUT = 30000; // 30s (core download)
const FFMPEG_DOWNLOAD_WASM_TIMEOUT = 60000; // 1 min (WASM download)
const VIDEO_METADATA_TIMEOUT = 15000;

// Timeout utility
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FFmpegError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Singleton FFmpeg instance
let ffmpeg: FFmpeg | null = null;
let loaded = false;
let loading: Promise<FFmpeg> | null = null;

// Custom error class for FFmpeg operations
export class FFmpegError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FFmpegError";
  }
}

// Initialize FFmpeg
export async function initFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg && loaded) return ffmpeg;

  if (loading) return loading;

  const instance = new FFmpeg();
  ffmpeg = instance;
  loaded = false;
  let retired = false;
  const urls = new Set<string>();
  const releaseURLs = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const captureURL = (url: string) => {
    // A timed-out download can still finish. It cannot start the retired worker
    // or retain a Blob URL after another initialization has begun.
    if (retired) {
      URL.revokeObjectURL(url);
      throw new FFmpegError("FFmpeg initialization was cancelled");
    }
    urls.add(url);
    return url;
  };
  const initialize = async () => {
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
    const [coreURL, wasmURL] = await Promise.all([
      withTimeout(
        toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript").then(
          captureURL,
        ),
        FFMPEG_DOWNLOAD_CORE_TIMEOUT,
        "FFmpeg core download timed out",
      ),
      withTimeout(
        toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm").then(
          captureURL,
        ),
        FFMPEG_DOWNLOAD_WASM_TIMEOUT,
        "FFmpeg WASM download timed out",
      ),
    ]);
    await instance.load({ coreURL, wasmURL });
  };
  // First caller and joiners share the same bounded attempt, including startup.
  const attempt = withTimeout(
    initialize(),
    FFMPEG_INIT_TIMEOUT,
    "FFmpeg initialization timed out. Please select the video again.",
  )
    .then(() => {
      loaded = true;
      return instance;
    })
    .catch((error: unknown) => {
      retired = true;
      try {
        instance.terminate();
      } catch {
        /* Preserve the original initialization failure. */
      }
      if (ffmpeg === instance) {
        ffmpeg = null;
        loaded = false;
      }
      if (error instanceof FFmpegError) throw error;
      throw new FFmpegError("Failed to initialize FFmpeg", error);
    })
    .finally(() => {
      retired = true;
      releaseURLs();
      if (loading === attempt) loading = null;
    });
  loading = attempt;
  return attempt;
}

// Get file extension from MIME type
function getExtensionFromMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "video/ogg": "ogv",
  };
  return mimeToExt[mimeType] || "mp4";
}

// Get video duration
export async function getVideoDuration(
  file: File,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FFmpegError("Video inspection was cancelled"));
      return;
    }
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (duration: number, error?: FFmpegError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      if (error) reject(error);
      else resolve(duration);
    };
    const abort = () =>
      finish(5, new FFmpegError("Video inspection was cancelled"));
    video.onloadedmetadata = () => {
      const duration = video.duration;
      finish(
        Number.isFinite(duration) && duration > 0 ? Math.min(duration, 60) : 5,
      );
    };
    video.onerror = () => finish(5);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => finish(5, new FFmpegError("Video inspection timed out")),
      VIDEO_METADATA_TIMEOUT,
    );
    video.preload = "metadata";
    video.src = objectUrl;
  });
}

// Check if file is video
export function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/");
}

/**
 * Video transform parameters
 */
export interface VideoTransform {
  scale: number;
  position: { x: number; y: number };
  rotation: number; // Rotation in degrees
  displayScale: number; // The scale factor from canvas to display
}

/**
 * Export Canvas + Video to MP4 through FFmpeg
 * Canvas is overlaid on top of video
 */
export async function exportCanvasWithVideo(
  canvas: HTMLCanvasElement,
  videoFile: File,
  onProgress?: (progress: number) => void,
  videoTransform?: VideoTransform,
): Promise<{ blob: Blob; duration: number }> {
  const ff = await initFFmpeg();

  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(progress * 100);
  };
  ff.on("progress", progressHandler);

  try {
    // Get video duration
    const duration = await getVideoDuration(videoFile);

    // Convert canvas to PNG (for overlay)
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to create PNG blob"));
      }, "image/png");
    });

    // Write files to FFmpeg filesystem
    const ext = getExtensionFromMimeType(videoFile.type);
    const videoData = await fetchFile(videoFile);
    const pngData = new Uint8Array(await pngBlob.arrayBuffer());

    await ff.writeFile(`input.${ext}`, videoData);
    await ff.writeFile("overlay.png", pngData);

    // Build video filter with transform
    let videoFilter: string;
    const hasTransform =
      videoTransform &&
      (videoTransform.scale !== 1 ||
        videoTransform.position.x !== 0 ||
        videoTransform.position.y !== 0 ||
        videoTransform.rotation !== 0);

    if (hasTransform && videoTransform) {
      // Convert display coordinates to canvas coordinates
      const scale = videoTransform.scale;
      const offsetX = Math.round(
        videoTransform.position.x * videoTransform.displayScale,
      );
      const offsetY = Math.round(
        videoTransform.position.y * videoTransform.displayScale,
      );
      const rotationRad = (videoTransform.rotation * Math.PI) / 180;

      // Calculate scaled video dimensions (larger to accommodate rotation)
      const scaledW = Math.round(CANVAS_WIDTH * scale * 1.5); // Extra space for rotation
      const scaledH = Math.round(CANVAS_HEIGHT * scale * 1.5);

      // Calculate position (centered + offset)
      const posX = Math.round((CANVAS_WIDTH - scaledW) / 2 + offsetX);
      const posY = Math.round((CANVAS_HEIGHT - scaledH) / 2 + offsetY);

      // Scale video, rotate, then position on black background
      if (videoTransform.rotation !== 0) {
        // With rotation: scale -> rotate -> crop -> overlay
        videoFilter = `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${scaledW}:${scaledH},rotate=${rotationRad}:c=black:ow=${scaledW}:oh=${scaledH}[scaled];color=black:s=${CANVAS_WIDTH}x${CANVAS_HEIGHT}[bg];[bg][scaled]overlay=${posX}:${posY}[v];[v][1:v]overlay=0:0[out]`;
      } else {
        // Without rotation: scale -> crop -> overlay
        videoFilter = `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${scaledW}:${scaledH}[scaled];color=black:s=${CANVAS_WIDTH}x${CANVAS_HEIGHT}[bg];[bg][scaled]overlay=${posX}:${posY}[v];[v][1:v]overlay=0:0[out]`;
      }
    } else {
      // Default: scale to fit and center
      videoFilter = `[0:v]scale=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:force_original_aspect_ratio=decrease,pad=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:(ow-iw)/2:(oh-ih)/2[v];[v][1:v]overlay=0:0[out]`;
    }

    // Compose video with canvas overlay
    await withTimeout(
      ff.exec([
        "-i",
        `input.${ext}`,
        "-i",
        "overlay.png",
        "-filter_complex",
        videoFilter,
        "-map",
        "[out]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-t",
        "60",
        "-y",
        "output.mp4",
      ]),
      FFMPEG_TIMEOUT * 2,
      "Video export timed out",
    );

    // Read output
    const data = await ff.readFile("output.mp4");

    // Cleanup
    try {
      await ff.deleteFile(`input.${ext}`);
    } catch {
      /* ignore */
    }
    try {
      await ff.deleteFile("overlay.png");
    } catch {
      /* ignore */
    }
    try {
      await ff.deleteFile("output.mp4");
    } catch {
      /* ignore */
    }

    const blobData = data instanceof Uint8Array ? new Uint8Array(data) : data;
    return {
      blob: new Blob([blobData], { type: "video/mp4" }),
      duration: Math.min(duration, 60),
    };
  } catch (error) {
    if (error instanceof FFmpegError) throw error;
    throw new FFmpegError("Failed to export video", error);
  } finally {
    ff.off("progress", progressHandler);
  }
}
