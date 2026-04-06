/**
 * Telegram media handler -- converts non-text messages to text for the LLM.
 *
 * The constitution engine's processMessage accepts a text string. This module
 * bridges the gap for photos, voice messages, documents, stickers, and videos
 * by extracting a text representation the engine can work with.
 *
 * Voice transcription uses Groq's Whisper API. Photo vision is placeholder
 * until the adapter supports multimodal input.
 */

import type { Context } from "grammy";

// ── Types ───────────────────────────────────────────────────────────

export interface MediaExtraction {
  text: string;
  mediaType: "photo" | "voice" | "document" | "sticker" | "video";
  caption?: string;
  fileUrl?: string;
}

// ── Constants ───────────────────────────────────────────────────────

const MAX_DOCUMENT_CHARS = 10_000;
const GROQ_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_WHISPER_MODEL = "whisper-large-v3";

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/toml",
]);

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

  let fileUrl: string | undefined;
  try {
    const filePath = await getTelegramFilePath(botToken, largest.file_id);
    fileUrl = buildFileUrl(botToken, filePath);
  } catch {
    // File URL is for logging only; don't fail the extraction
  }

  const captionSuffix = caption ? `: ${caption}` : "";
  const text =
    `[Photo received${captionSuffix}. The user sent an image. ` +
    `Describe what you see or ask them what they need help with regarding this image.]`;

  return { text, mediaType: "photo", caption, fileUrl };
}

// ── Voice ───────────────────────────────────────────────────────────

async function extractVoice(
  msg: NonNullable<Context["message"]>,
  botToken: string,
): Promise<MediaExtraction> {
  const voice = msg.voice!;
  const caption = msg.caption || undefined;

  const filePath = await getTelegramFilePath(botToken, voice.file_id);
  const fileUrl = buildFileUrl(botToken, filePath);
  const audioBuffer = await downloadTelegramFile(botToken, filePath);

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.error("[telegram-media] GROQ_API_KEY not set, cannot transcribe voice");
    return {
      text: "[Voice message received but could not be transcribed. Please type your message instead.]",
      mediaType: "voice",
      caption,
      fileUrl,
    };
  }

  try {
    const transcript = await transcribeVoice(audioBuffer, groqApiKey);
    return { text: transcript, mediaType: "voice", caption, fileUrl };
  } catch (err) {
    console.error("[telegram-media] Voice transcription failed:", err);
    return {
      text: "[Voice message received but could not be transcribed. Please type your message instead.]",
      mediaType: "voice",
      caption,
      fileUrl,
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

  const filePath = await getTelegramFilePath(botToken, doc.file_id);
  const fileUrl = buildFileUrl(botToken, filePath);

  const captionSuffix = caption ? ` - ${caption}` : "";
  const header = `[Document received: ${filename}${captionSuffix}]`;

  // PDFs: just acknowledge the filename, don't attempt parsing
  if (mimeType === "application/pdf") {
    return { text: header, mediaType: "document", caption, fileUrl };
  }

  // Text-readable files: download and include content
  if (isTextReadable(mimeType)) {
    try {
      const buffer = await downloadTelegramFile(botToken, filePath);
      let content = buffer.toString("utf-8");

      if (content.length > MAX_DOCUMENT_CHARS) {
        content =
          content.slice(0, MAX_DOCUMENT_CHARS) +
          `\n\n[... truncated, ${content.length - MAX_DOCUMENT_CHARS} characters omitted]`;
      }

      return {
        text: `${header}\n\n${content}`,
        mediaType: "document",
        caption,
        fileUrl,
      };
    } catch (err) {
      console.error("[telegram-media] Failed to read document content:", err);
      return { text: header, mediaType: "document", caption, fileUrl };
    }
  }

  // Binary or unrecognized: header only
  return { text: header, mediaType: "document", caption, fileUrl };
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
  const caption = msg.caption || undefined;
  const captionSuffix = caption ? `: ${caption}` : "";

  return {
    text: `[Video received${captionSuffix}. Video processing is not yet supported.]`,
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
