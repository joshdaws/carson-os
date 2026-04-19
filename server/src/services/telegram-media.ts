/**
 * Telegram media handler -- converts non-text messages to text for the LLM.
 *
 * The constitution engine's processMessage accepts a text string. This module
 * bridges the gap for photos, voice messages, documents, stickers, and videos
 * by extracting a text representation the engine can work with.
 *
 * Three layers, all OpenClaw / Hermes informed:
 *
 *   1. Per-capability size guards. Telegram includes file_size in every media
 *      update — we reject oversized files before downloading. Min audio guard
 *      (1KB) skips empty/corrupt clips that would just produce a Whisper error.
 *
 *   2. Local cache. Downloads land at ~/.carsonos/media/ keyed by file_unique_id
 *      (Telegram's stable cross-bot id). Telegram file_ids expire ~1hr; the
 *      cache lets the agent re-examine an image without re-fetching. Pruned
 *      every 30 minutes; entries older than 1 hour go.
 *
 *   3. Photo vision via Claude Agent SDK. Pre-describe pattern (Hermes-style):
 *      we call Claude with the image, get a 1-3 sentence description, and inject
 *      that description as text. processMessage stays text-only — no engine
 *      surgery — and the agent gets the cached file path so it can ask follow-up
 *      questions about the image without us re-uploading.
 *
 * Voice transcription uses Groq Whisper (whisper-large-v3-turbo).
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Context } from "grammy";

// ── Types ───────────────────────────────────────────────────────────

export interface MediaExtraction {
  text: string;
  mediaType: "photo" | "voice" | "audio" | "document" | "sticker" | "video";
  caption?: string;
  fileUrl?: string;
  /** Local cached path, when the file was downloaded. */
  localPath?: string;
  /**
   * For photos: raw image bytes + MIME type so the relay can pass them inline
   * to the agent's multimodal model. Avoids the Haiku pre-describe round-trip.
   */
  image?: { mediaType: string; base64: string };
}

// ── Constants ───────────────────────────────────────────────────────

const MB = 1024 * 1024;

/**
 * Per-capability max file size, checked from Telegram's reported file_size
 * before we download a single byte. Numbers mirror OpenClaw's defaults.
 */
const MAX_BYTES = {
  image: 10 * MB,
  voice: 20 * MB,
  audio: 20 * MB,
  document: 20 * MB,
  video: 50 * MB,
} as const;

/**
 * Below this size, audio is almost always silence/corrupt — skip the Whisper
 * round-trip. OpenClaw uses the same threshold for the same reason.
 */
const MIN_AUDIO_BYTES = 1024;

/** Cap text-readable document content injection. Hermes uses 100KB. */
const MAX_DOCUMENT_CHARS = 100_000;

/** Voice transcription. */
const GROQ_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/toml",
]);

// ── Cache ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_PRUNE_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const CACHE_PRUNE_INITIAL_DELAY_MS = 30_000;

const MEDIA_CACHE_DIR = (() => {
  const dataDir = process.env.DATA_DIR ?? path.join(homedir(), ".carsonos");
  return path.join(dataDir, "media");
})();

interface CacheEntry {
  filePath: string;
  expiresAt: number;
}

const memCache = new Map<string, CacheEntry>();
let cacheDirReady = false;
let pruneTimerScheduled = false;

async function ensureCacheDir(): Promise<void> {
  if (cacheDirReady) return;
  await mkdir(MEDIA_CACHE_DIR, { recursive: true });
  cacheDirReady = true;
}

function schedulePruneTimer(): void {
  if (pruneTimerScheduled) return;
  pruneTimerScheduled = true;
  setTimeout(() => {
    void pruneCache();
    setInterval(() => void pruneCache(), CACHE_PRUNE_INTERVAL_MS).unref();
  }, CACHE_PRUNE_INITIAL_DELAY_MS).unref();
}

async function pruneCache(): Promise<void> {
  const now = Date.now();

  // Prune in-memory expired entries
  for (const [key, entry] of memCache) {
    if (now > entry.expiresAt) memCache.delete(key);
  }

  // Prune on-disk files older than CACHE_TTL_MS
  try {
    const files = await readdir(MEDIA_CACHE_DIR);
    let removed = 0;
    for (const f of files) {
      const p = path.join(MEDIA_CACHE_DIR, f);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > CACHE_TTL_MS) {
          await unlink(p);
          removed++;
        }
      } catch { /* skip */ }
    }
    if (removed > 0) {
      console.log(`[telegram-media] Cache prune removed ${removed} stale file(s)`);
    }
  } catch { /* cache dir doesn't exist yet — nothing to prune */ }
}

/**
 * Sanitize a Telegram file_unique_id into a safe filename component.
 * file_unique_id is alphanumeric + - + _ in practice, but defend anyway.
 */
function safeKey(fileUniqueId: string): string {
  return fileUniqueId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

async function cacheGet(fileUniqueId: string): Promise<{ buffer: Buffer; localPath: string } | null> {
  const entry = memCache.get(fileUniqueId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(fileUniqueId);
    return null;
  }
  try {
    const buffer = await readFile(entry.filePath);
    return { buffer, localPath: entry.filePath };
  } catch {
    memCache.delete(fileUniqueId);
    return null;
  }
}

async function cachePut(
  fileUniqueId: string,
  buffer: Buffer,
  remoteFilePath: string,
): Promise<string> {
  await ensureCacheDir();
  const ext = path.extname(remoteFilePath) || ".bin";
  const localPath = path.join(MEDIA_CACHE_DIR, `${safeKey(fileUniqueId)}${ext}`);
  await writeFile(localPath, buffer, { mode: 0o644 });
  memCache.set(fileUniqueId, {
    filePath: localPath,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  schedulePruneTimer();
  return localPath;
}

/**
 * Fetch a Telegram file with cache lookup. Returns the buffer + local path.
 * Cache miss: getFile → download → store. Cache hit: read from disk.
 */
async function fetchTelegramMedia(
  botToken: string,
  fileId: string,
  fileUniqueId: string,
): Promise<{ buffer: Buffer; localPath: string; fileUrl: string }> {
  const filePath = await getTelegramFilePath(botToken, fileId);
  const fileUrl = buildFileUrl(botToken, filePath);

  const cached = await cacheGet(fileUniqueId);
  if (cached) {
    return { buffer: cached.buffer, localPath: cached.localPath, fileUrl };
  }

  const buffer = await downloadTelegramFile(botToken, filePath);
  const localPath = await cachePut(fileUniqueId, buffer, filePath);
  return { buffer, localPath, fileUrl };
}

// ── Size guard helpers ──────────────────────────────────────────────

function exceedsMax(fileSize: number | undefined, max: number): boolean {
  return typeof fileSize === "number" && fileSize > max;
}

function fmtMb(bytes: number): string {
  return `${(bytes / MB).toFixed(0)}MB`;
}

// ── Main extractor ──────────────────────────────────────────────────

/**
 * Inspect a Grammy context for non-text media and return a text representation.
 * Returns null if no recognized media is present or extraction fails entirely.
 * Never throws -- the relay should fall back to ignoring unrecognized media.
 */
export async function extractMediaText(
  ctx: Context,
  botToken: string,
): Promise<MediaExtraction | null> {
  const msg = ctx.message;
  if (!msg) return null;

  try {
    if (msg.photo && msg.photo.length > 0) {
      return await extractPhoto(msg, botToken);
    }

    if (msg.voice) {
      return await extractVoice(msg, botToken);
    }

    if (msg.audio) {
      return await extractAudio(msg, botToken);
    }

    if (msg.document) {
      return await extractDocument(msg, botToken);
    }

    if (msg.sticker) {
      return extractSticker(msg);
    }

    if (msg.video) {
      return extractVideo(msg);
    }

    return null;
  } catch (err) {
    console.error("[telegram-media] Extraction failed:", err);
    return null;
  }
}

// ── Photo ───────────────────────────────────────────────────────────

async function extractPhoto(
  msg: NonNullable<Context["message"]>,
  botToken: string,
): Promise<MediaExtraction> {
  const photos = msg.photo!;
  const largest = photos[photos.length - 1];
  const caption = msg.caption || undefined;

  // Size guard before download
  if (exceedsMax(largest.file_size, MAX_BYTES.image)) {
    return {
      text:
        `[Photo received but too large to process (${fmtMb(largest.file_size!)} ` +
        `> ${fmtMb(MAX_BYTES.image)} limit)${caption ? `. Caption: ${caption}` : ""}]`,
      mediaType: "photo",
      caption,
    };
  }

  let media: Awaited<ReturnType<typeof fetchTelegramMedia>>;
  try {
    media = await fetchTelegramMedia(botToken, largest.file_id, largest.file_unique_id);
  } catch (err) {
    console.error("[telegram-media] Photo fetch failed:", err);
    return {
      text:
        `[Photo received but couldn't be downloaded` +
        `${caption ? `. Caption: ${caption}` : ""}]`,
      mediaType: "photo",
      caption,
    };
  }

  // Telegram photos are JPEG by default after compression. Pass the bytes
  // through as a multimodal attachment — the agent's model (sonnet/opus/haiku,
  // all multimodal) sees the image inline. No pre-describe round-trip.
  const text = caption
    ? `[Photo received with caption: "${caption}". The image is attached to this message.]`
    : `[Photo received. The image is attached to this message.]`;

  return {
    text,
    mediaType: "photo",
    caption,
    fileUrl: media.fileUrl,
    localPath: media.localPath,
    image: {
      mediaType: "image/jpeg",
      base64: media.buffer.toString("base64"),
    },
  };
}

// ── Voice ───────────────────────────────────────────────────────────

async function extractVoice(
  msg: NonNullable<Context["message"]>,
  botToken: string,
): Promise<MediaExtraction> {
  const voice = msg.voice!;
  const caption = msg.caption || undefined;

  if (exceedsMax(voice.file_size, MAX_BYTES.voice)) {
    return {
      text: `[Voice message too large (${fmtMb(voice.file_size!)} > ${fmtMb(MAX_BYTES.voice)}). Please type your message instead.]`,
      mediaType: "voice",
      caption,
    };
  }

  if (typeof voice.file_size === "number" && voice.file_size < MIN_AUDIO_BYTES) {
    return {
      text: "[Voice message too short to transcribe. Please try again or type your message.]",
      mediaType: "voice",
      caption,
    };
  }

  let media: Awaited<ReturnType<typeof fetchTelegramMedia>>;
  try {
    media = await fetchTelegramMedia(botToken, voice.file_id, voice.file_unique_id);
  } catch (err) {
    console.error("[telegram-media] Voice fetch failed:", err);
    return {
      text: "[Voice message received but couldn't be downloaded. Please try again.]",
      mediaType: "voice",
      caption,
    };
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.error("[telegram-media] GROQ_API_KEY not set, cannot transcribe voice");
    return {
      text: "[Voice message received but could not be transcribed (Groq API key not configured). Please type your message instead.]",
      mediaType: "voice",
      caption,
      fileUrl: media.fileUrl,
      localPath: media.localPath,
    };
  }

  try {
    const transcript = await transcribeVoice(media.buffer, groqApiKey);
    return {
      text: transcript,
      mediaType: "voice",
      caption,
      fileUrl: media.fileUrl,
      localPath: media.localPath,
    };
  } catch (err) {
    console.error("[telegram-media] Voice transcription failed:", err);
    return {
      text: "[Voice message received but could not be transcribed. Please type your message instead.]",
      mediaType: "voice",
      caption,
      fileUrl: media.fileUrl,
      localPath: media.localPath,
    };
  }
}

// ── Audio (audio files sent via Telegram's "audio" message type) ────

async function extractAudio(
  msg: NonNullable<Context["message"]>,
  botToken: string,
): Promise<MediaExtraction> {
  const audio = msg.audio!;
  const caption = msg.caption || undefined;
  const filename = audio.file_name || "audio file";
  const duration = audio.duration ? ` (${audio.duration}s)` : "";

  if (exceedsMax(audio.file_size, MAX_BYTES.audio)) {
    return {
      text: `[Audio file ${filename}${duration} too large (${fmtMb(audio.file_size!)} > ${fmtMb(MAX_BYTES.audio)}). Please trim it or send a shorter clip.]`,
      mediaType: "audio",
      caption,
    };
  }

  if (typeof audio.file_size === "number" && audio.file_size < MIN_AUDIO_BYTES) {
    return {
      text: `[Audio file ${filename} too short to transcribe.]`,
      mediaType: "audio",
      caption,
    };
  }

  let media: Awaited<ReturnType<typeof fetchTelegramMedia>>;
  try {
    media = await fetchTelegramMedia(botToken, audio.file_id, audio.file_unique_id);
  } catch (err) {
    console.error("[telegram-media] Audio fetch failed:", err);
    return {
      text: `[Audio file received: ${filename}${duration}. Couldn't be downloaded.]`,
      mediaType: "audio",
      caption,
    };
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.error("[telegram-media] GROQ_API_KEY not set, cannot transcribe audio");
    return {
      text: `[Audio file received: ${filename}${duration}. Could not transcribe. Please send your message as text.]`,
      mediaType: "audio",
      caption,
      fileUrl: media.fileUrl,
      localPath: media.localPath,
    };
  }

  try {
    const transcript = await transcribeVoice(media.buffer, groqApiKey);
    return {
      text: transcript,
      mediaType: "audio",
      caption,
      fileUrl: media.fileUrl,
      localPath: media.localPath,
    };
  } catch (err) {
    console.error("[telegram-media] Audio transcription failed:", err);
    return {
      text: `[Audio file received: ${filename}${duration}. Transcription failed. Please send your message as text.]`,
      mediaType: "audio",
      caption,
      fileUrl: media.fileUrl,
      localPath: media.localPath,
    };
  }
}

// ── Document ────────────────────────────────────────────────────────

async function extractDocument(
  msg: NonNullable<Context["message"]>,
  botToken: string,
): Promise<MediaExtraction> {
  const doc = msg.document!;
  const filename = doc.file_name || "unknown";
  const mimeType = doc.mime_type || "";
  const caption = msg.caption || undefined;

  if (exceedsMax(doc.file_size, MAX_BYTES.document)) {
    return {
      text: `[Document ${filename} too large (${fmtMb(doc.file_size!)} > ${fmtMb(MAX_BYTES.document)}). Please send a smaller file.]`,
      mediaType: "document",
      caption,
    };
  }

  let media: Awaited<ReturnType<typeof fetchTelegramMedia>>;
  try {
    media = await fetchTelegramMedia(botToken, doc.file_id, doc.file_unique_id);
  } catch (err) {
    console.error("[telegram-media] Document fetch failed:", err);
    return {
      text: `[Document received: ${filename}. Couldn't be downloaded.]`,
      mediaType: "document",
      caption,
    };
  }

  const captionSuffix = caption ? ` - ${caption}` : "";
  const header = `[Document received: ${filename}${captionSuffix}. Cached at: ${media.localPath}]`;

  // PDFs: just acknowledge for now. Real PDF text extraction is a separate task.
  if (mimeType === "application/pdf") {
    return { text: header, mediaType: "document", caption, fileUrl: media.fileUrl, localPath: media.localPath };
  }

  // Text-readable files: include content directly
  if (isTextReadable(mimeType)) {
    let content = media.buffer.toString("utf-8");
    if (content.length > MAX_DOCUMENT_CHARS) {
      content =
        content.slice(0, MAX_DOCUMENT_CHARS) +
        `\n\n[... truncated, ${content.length - MAX_DOCUMENT_CHARS} characters omitted]`;
    }
    return {
      text: `${header}\n\n${content}`,
      mediaType: "document",
      caption,
      fileUrl: media.fileUrl,
      localPath: media.localPath,
    };
  }

  // Binary or unrecognized: header only
  return { text: header, mediaType: "document", caption, fileUrl: media.fileUrl, localPath: media.localPath };
}

// ── Sticker ─────────────────────────────────────────────────────────

function extractSticker(
  msg: NonNullable<Context["message"]>,
): MediaExtraction {
  const sticker = msg.sticker!;
  const emoji = sticker.emoji || "?";
  const setName = sticker.set_name || "unknown pack";

  return {
    text: `[Sticker: ${emoji} from pack "${setName}". The user sent a sticker expressing this emotion.]`,
    mediaType: "sticker",
  };
}

// ── Video ───────────────────────────────────────────────────────────

function extractVideo(
  msg: NonNullable<Context["message"]>,
): MediaExtraction {
  const video = msg.video!;
  const caption = msg.caption || undefined;
  const captionSuffix = caption ? `: ${caption}` : "";

  if (exceedsMax(video.file_size, MAX_BYTES.video)) {
    return {
      text: `[Video too large (${fmtMb(video.file_size!)} > ${fmtMb(MAX_BYTES.video)}). Please send a shorter clip.]`,
      mediaType: "video",
      caption,
    };
  }

  // Video understanding is parity-with-OpenClaw deferred (requires Gemini-class
  // model for inbound video; not enabled for Claude-only deployments).
  return {
    text: `[Video received${captionSuffix}. Video understanding isn't enabled. Describe what's in it or ask the user.]`,
    mediaType: "video",
    caption,
  };
}

// ── Telegram file helpers ───────────────────────────────────────────

/**
 * Download a file from Telegram's servers.
 * filePath comes from the getFile API response.
 */
export async function downloadTelegramFile(
  botToken: string,
  filePath: string,
): Promise<Buffer> {
  const url = buildFileUrl(botToken, filePath);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Telegram file download failed: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Call Telegram's getFile API to resolve a file_id to a file_path.
 */
async function getTelegramFilePath(
  botToken: string,
  fileId: string,
): Promise<string> {
  const url = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Telegram getFile failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };

  if (!data.ok || !data.result?.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }

  return data.result.file_path;
}

function buildFileUrl(botToken: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

// ── Voice transcription ─────────────────────────────────────────────

/**
 * Transcribe an audio buffer using Groq's Whisper API.
 * Expects OGG/Opus format (Telegram's default for voice messages).
 * Throws on failure -- callers should catch and provide a fallback message.
 */
export async function transcribeVoice(
  audioBuffer: Buffer,
  groqApiKey: string,
): Promise<string> {
  const formData = new FormData();

  const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" });
  formData.append("file", blob, "voice.ogg");
  formData.append("model", GROQ_WHISPER_MODEL);

  const response = await fetch(GROQ_WHISPER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Groq transcription failed: ${response.status} ${response.statusText} -- ${body}`,
    );
  }

  const data = (await response.json()) as { text?: string };

  if (!data.text || data.text.trim().length === 0) {
    throw new Error("Groq returned empty transcription");
  }

  return data.text.trim();
}

// ── Helpers ─────────────────────────────────────────────────────────

function isTextReadable(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  return TEXT_MIME_TYPES.has(mimeType);
}
