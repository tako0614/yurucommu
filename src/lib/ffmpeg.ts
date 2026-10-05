// FFmpeg utility for Story composition
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./story-canvas.ts";

// Timeout constants
const FFMPEG_EXPORT_TIMEOUT = 240000; // One deadline for the entire export
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
let exporting = false;
const terminated = new WeakSet<FFmpeg>();

function retireFFmpeg(instance: FFmpeg): void {
  if (terminated.has(instance)) return;
  terminated.add(instance);
  if (ffmpeg === instance) {
    ffmpeg = null;
    loaded = false;
  }
  try {
    instance.terminate();
  } catch {
    // The failed worker must not replace the original export error.
  }
}

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
      retireFFmpeg(instance);
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
  signal?: AbortSignal,
): Promise<{ blob: Blob; duration: number }> {
  // Acquire the lease before the first await, including shared initialization.
  if (exporting) throw new FFmpegError("A video export is already in progress");
  exporting = true;
  let ff: FFmpeg | null = null;
  let failure: FFmpegError | null = null;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inspection = new AbortController();
  let rejectInterruption!: (error: FFmpegError) => void;
  const interruption = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });
  // An already-aborted signal can reject before the first raced operation.
  void interruption.catch(() => {});
  const interrupt = (error: FFmpegError) => {
    if (failure) return;
    failure = error;
    inspection.abort();
    rejectInterruption(error);
  };
  const abort = () => interrupt(new FFmpegError("Video export was cancelled"));
  timer = setTimeout(
    () => interrupt(new FFmpegError("Video export timed out")),
    FFMPEG_EXPORT_TIMEOUT,
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const assertActive = () => {
    if (failure) throw failure;
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    // Check again in the scheduled operation so an abort cannot start a late RPC.
    const work = Promise.resolve().then(() => {
      assertActive();
      return operation();
    });
    const value = await Promise.race([work, interruption]);
    assertActive();
    return value;
  };
  const progressHandler = ({ progress }: { progress: number }) => {
    if (active && !failure && ff) onProgress?.(progress * 100);
  };

  try {
    ff = await run(() => initFFmpeg());
    assertActive();
    ff.on("progress", progressHandler);
    // Get video duration
    const duration = await run(() =>
      getVideoDuration(videoFile, inspection.signal),
    );

    // Convert canvas to PNG (for overlay)
    const pngBlob = await run(
      () =>
        new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("Failed to create PNG blob"));
          }, "image/png");
        }),
    );

    // Write files to FFmpeg filesystem
    const ext = getExtensionFromMimeType(videoFile.type);
    const videoData = await run(() => fetchFile(videoFile));
    const pngData = new Uint8Array(await run(() => pngBlob.arrayBuffer()));

    await run(() => ff!.writeFile(`input.${ext}`, videoData));
    await run(() => ff!.writeFile("overlay.png", pngData));

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
    const exitCode = await run(() =>
      ff!.exec([
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
    );
    if (exitCode !== 0)
      throw new FFmpegError(`Video encoder exited with status ${exitCode}`);

    // Read output
    const data = await run(() => ff!.readFile("output.mp4"));
    if (!(data instanceof Uint8Array) || data.byteLength === 0)
      throw new FFmpegError("Video encoder produced no usable output");

    // A cached worker is reusable only after all work files are removed.
    await run(() => ff!.deleteFile(`input.${ext}`));
    await run(() => ff!.deleteFile("overlay.png"));
    await run(() => ff!.deleteFile("output.mp4"));

    const blobData = new Uint8Array(data);
    return {
      blob: new Blob([blobData], { type: "video/mp4" }),
      duration: Math.min(duration, 60),
    };
  } catch (error) {
    active = false;
    if (ff) retireFFmpeg(ff);
    if (error instanceof FFmpegError) throw error;
    throw new FFmpegError("Failed to export video", error);
  } finally {
    active = false;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    inspection.abort();
    if (ff) {
      try {
        ff.off("progress", progressHandler);
      } catch {
        // A terminated worker may no longer accept listener operations.
      }
    }
    exporting = false;
  }
}
