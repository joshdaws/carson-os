/**
 * Conversation routes -- list conversations and messages, send messages via web chat.
 */

import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  conversations,
  messages,
  familyMembers,
  staffAgents,
} from "@carsonos/db";
import type { ConstitutionEngine } from "../services/constitution-engine.js";

export interface ConversationRouteDeps {
  db: Db;
  constitutionEngine: ConstitutionEngine;
}

export function createConversationRoutes(
  deps: ConversationRouteDeps,
): Router {
  const { db, constitutionEngine } = deps;
  const router = Router();

  // GET / -- list all conversations
  router.get("/", async (req, res) => {
    const { agentId, memberId } = req.query;

    let query = db
      .select({
        id: conversations.id,
        householdId: conversations.householdId,
        agentId: conversations.agentId,
        memberId: conversations.memberId,
        channel: conversations.channel,
        startedAt: conversations.startedAt,
        lastMessageAt: conversations.lastMessageAt,
        sessionContext: conversations.sessionContext,
        memberName: familyMembers.name,
        memberRole: familyMembers.role,
        agentName: staffAgents.name,
      })
      .from(conversations)
      .leftJoin(familyMembers, eq(familyMembers.id, conversations.memberId))
      .leftJoin(staffAgents, eq(staffAgents.id, conversations.agentId))
      .orderBy(desc(conversations.startedAt))
      .$dynamic();

    const rows = await query.all();

    // Filter in JS for optional params (simpler than dynamic where building)
    let filtered = rows;
    if (agentId && typeof agentId === "string") {
      filtered = filtered.filter((r) => r.agentId === agentId);
    }
    if (memberId && typeof memberId === "string") {
      filtered = filtered.filter((r) => r.memberId === memberId);
    }

    res.json({ conversations: filtered });
  });

  // GET /:id/messages -- messages for a conversation
  router.get("/:id/messages", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const conversation = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, req.params.id))
      .get();

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, req.params.id))
      .orderBy(messages.createdAt)
      .limit(limit)
      .offset(offset)
      .all();

    res.json({
      conversation,
      messages: msgs,
      pagination: { limit, offset, count: msgs.length },
    });
  });

  // POST /:id/messages -- send a message via web chat
  router.post("/:id/messages", async (req, res) => {
    const { message, memberId } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const conversation = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, req.params.id))
      .get();

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Use the memberId from the conversation if not provided
    const effectiveMemberId = memberId ?? conversation.memberId;

    // SSE — headers must be committed before any write
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let closed = false;
    req.on("close", () => { closed = true; });

    const result = await constitutionEngine.processMessage({
      agentId: conversation.agentId,
      memberId: effectiveMemberId,
      householdId: conversation.householdId,
      message,
      channel: "web",
      onTextDelta: (text) => {
        if (!closed) {
          res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
        }
      },
    });

    if (!closed) {
      res.write(`data: ${JSON.stringify({ type: "done", blocked: result.blocked, policyEvents: result.policyEvents })}\n\n`);
      res.end();
    }
  });

  return router;
}
