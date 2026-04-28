/**
 * Conversation routes -- list conversations and messages, send messages via web chat.
 */

import { Router } from "express";
import { sql, eq, desc } from "drizzle-orm";
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

// ── Validators (exported for unit tests) ──────────────────────────

export type CreateConversationBody = { agentId?: unknown; memberId?: unknown };

export function validateCreateConversation(
  body: CreateConversationBody,
): { valid: true } | { valid: false; error: string } {
  if (!body.agentId || !body.memberId) {
    return { valid: false, error: "agentId and memberId are required" };
  }
  return { valid: true };
}

export function validateSendMessage(body: { message?: unknown }): boolean {
  return typeof body.message === "string" && body.message.length > 0;
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
        lastMessage: sql<string | null>`(SELECT content FROM messages WHERE conversation_id = ${conversations.id} ORDER BY created_at DESC LIMIT 1)`,
        messageCount: sql<number>`(SELECT COUNT(*) FROM messages WHERE conversation_id = ${conversations.id})`,
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

  // POST / -- create a new web conversation
  router.post("/", async (req, res) => {
    const validation = validateCreateConversation(req.body);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const { agentId, memberId } = req.body;

    const member = await db
      .select({ id: familyMembers.id, householdId: familyMembers.householdId })
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();

    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    const agent = await db
      .select({ id: staffAgents.id })
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .get();

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const [conversation] = await db
      .insert(conversations)
      .values({
        householdId: member.householdId,
        agentId,
        memberId,
        channel: "web",
        startedAt: new Date().toISOString(),
      })
      .returning();

    res.status(201).json({ conversation });
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
    if (!validateSendMessage(req.body)) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const { message, memberId } = req.body as { message: string; memberId?: string };

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
