import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { conversations, messages, agents, familyMembers } from "@carsonos/db";

export function createConversationRoutes(db: Db): Router {
  const router = Router();

  // GET /:familyId/conversations — list all conversations, optionally filter by agentId
  router.get("/:familyId/conversations", async (req, res) => {
    const { agentId } = req.query;

    const conditions = [eq(conversations.familyId, req.params.familyId)];
    if (agentId && typeof agentId === "string") {
      conditions.push(eq(conversations.agentId, agentId));
    }

    const rows = await db
      .select({
        id: conversations.id,
        familyId: conversations.familyId,
        agentId: conversations.agentId,
        channel: conversations.channel,
        startedAt: conversations.startedAt,
        lastMessageAt: conversations.lastMessageAt,
        sessionContext: conversations.sessionContext,
        memberName: familyMembers.name,
        memberRole: familyMembers.role,
      })
      .from(conversations)
      .leftJoin(agents, eq(agents.id, conversations.agentId))
      .leftJoin(familyMembers, eq(familyMembers.id, agents.memberId))
      .where(and(...conditions))
      .orderBy(desc(conversations.startedAt))
      .all();

    res.json({ conversations: rows });
  });

  // GET /:id/messages — return messages for a conversation, paginated
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

  return router;
}
