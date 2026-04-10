/**
 * Telegram streaming engine — edit-in-place as tokens arrive.
 *
 * Queues edits through a single async chain so they never race.
 * Each edit waits for the previous one to complete before running.
 */

import type { Context } from "grammy";

const EDIT_INTERVAL_MS = 300;
const MAX_PLAIN_LENGTH = 4096;

export interface StreamResult {
  text: string;
  messageId: number | null;
}

export interface TelegramStreamConsumer {
  onDelta: (text: string) => void;
  finish: () => Promise<StreamResult>;
}

export function createTelegramStream(ctx: Context): TelegramStreamConsumer {
  let accumulated = "";
  let messageId: number | null = null;
  let lastSentText = "";
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  // Serial async queue — each edit waits for the previous one
  let editChain: Promise<void> = Promise.resolve();

  function enqueueEdit() {
    const textToSend = accumulated.length > MAX_PLAIN_LENGTH
      ? accumulated.slice(0, MAX_PLAIN_LENGTH - 3) + "..."
      : accumulated;

    if (!textToSend || textToSend === lastSentText) return;

    // Capture the text at this point in time
    const snapshot = textToSend;

    editChain = editChain.then(async () => {
      if (finished && snapshot !== accumulated) return; // Skip stale snapshots
      try {
        if (messageId) {
          await ctx.api.editMessageText(ctx.chat!.id, messageId, snapshot);
        } else {
          const sent = await ctx.reply(snapshot);
          messageId = sent.message_id;
        }
        lastSentText = snapshot;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes("not modified")) {
          console.warn("[streaming] Edit failed:", msg);
        }
      }
    });
  }

  function scheduleFlush() {
    if (editTimer) return;
    editTimer = setTimeout(() => {
      editTimer = null;
      enqueueEdit();
    }, EDIT_INTERVAL_MS);
  }

  let firstDeltaSent = false;

  const onDelta = (text: string) => {
    if (finished) return;
    accumulated += text;

    if (!firstDeltaSent) {
      // First delta — flush immediately so user sees something right away
      firstDeltaSent = true;
      enqueueEdit();
      return;
    }

    // Subsequent deltas — coalesce with timer
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      editTimer = null;
      enqueueEdit();
    }, EDIT_INTERVAL_MS);
  };

  const finish = async (): Promise<StreamResult> => {
    finished = true;
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }

    // Enqueue final edit with complete text
    enqueueEdit();

    // Wait for all edits to complete
    await editChain;

    return { text: accumulated, messageId };
  };

  return { onDelta, finish };
}
