/**
 * Delegation Orchestrator -- coordinates the full delegation lifecycle.
 *
 * When a personal agent's response contains <delegate> blocks, the
 * orchestrator creates a project (parent task) with subtasks for each
 * delegation, triggers the dispatcher, and handles synthesis when all
 * subtasks complete. The synthesized result is delivered back to the
 * kid via broadcast events -- the relay handles the actual Telegram send.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  staffAgents,
  delegationEdges,
  tasks,
  taskEvents,
  conversations,
  messages,
  familyMembers,
} from "@carsonos/db";

import type { Adapter } from "./subprocess-adapter.js";
import type { BroadcastFn } from "./event-bus.js";
import {
  parseDelegateBlocks,
  validateDelegateBlock,
} from "./delegate-parser.js";
import { compileSystemPrompt } from "./prompt-compiler.js";
import { Dispatcher } from "./dispatcher.js";
import { TaskEngine } from "./task-engine.js";

// -- Types -----------------------------------------------------------

export interface DelegationResult {
  delegated: boolean;
  userMessage: string;
  projectId?: string;
  warnings?: string[];
}

interface OrchestratorConfig {
  db: Db;
  adapter: Adapter;
  broadcast: BroadcastFn;
}

// -- Orchestrator ----------------------------------------------------

export class DelegationOrchestrator {
  private db: Db;
  private adapter: Adapter;
  private broadcast: BroadcastFn;
  private dispatcher: Dispatcher;
  private taskEngine: TaskEngine;

  constructor(
    config: OrchestratorConfig,
    dispatcher: Dispatcher,
    taskEngine: TaskEngine,
  ) {
    this.db = config.db;
    this.adapter = config.adapter;
    this.broadcast = config.broadcast;
    this.dispatcher = dispatcher;
    this.taskEngine = taskEngine;
  }

  // -- Public API -----------------------------------------------------

  /**
   * Called by the constitution engine after getting an LLM response from
   * a personal agent. Parses delegate blocks, creates tasks, and triggers
   * the dispatcher for each subtask.
   */
  async handleAgentResponse(
    agentId: string,
    memberId: string,
    householdId: string,
    conversationId: string,
    response: string,
  ): Promise<DelegationResult> {
    // 1. Parse delegate blocks from the response
    const parseResult = parseDelegateBlocks(response);

    if (parseResult.blocks.length === 0) {
      return {
        delegated: false,
        userMessage: response,
        warnings: parseResult.warnings.length > 0 ? parseResult.warnings : undefined,
      };
    }

    // 2. Load the personal agent and delegation edges
    const [agent, member] = await Promise.all([
      this.loadAgent(agentId),
      this.loadMember(memberId),
    ]);

    if (!agent || !member) {
      console.error(
        `[orchestrator] Agent ${agentId} or member ${memberId} not found`,
      );
      return { delegated: false, userMessage: response };
    }

    const edges = await this.db
      .select()
      .from(delegationEdges)
      .where(eq(delegationEdges.fromAgentId, agentId));

    // Resolve target agent names for validation
    const targetAgentIds = edges.map((e) => e.toAgentId);
    const targetAgents =
      targetAgentIds.length > 0
        ? await Promise.all(
            targetAgentIds.map((id) => this.loadAgent(id)),
          ).then((agents) => agents.filter(Boolean) as NonNullable<Awaited<ReturnType<typeof this.loadAgent>>>[])
        : [];

    const allowedAgentNames = targetAgents.map((a) => a.name);

    // 3. Validate each block against delegation edges
    const validBlocks: Array<{
      block: (typeof parseResult.blocks)[number];
      targetAgent: (typeof targetAgents)[number];
    }> = [];
    const warnings = [...parseResult.warnings];

    for (const block of parseResult.blocks) {
      const validation = validateDelegateBlock(block, allowedAgentNames);

      if (!validation.valid) {
        warnings.push(
          `Delegation rejected: ${validation.reason}`,
        );
        continue;
      }

      // Find the matching target agent (case-insensitive)
      const targetAgent = targetAgents.find(
        (a) => a.name.toLowerCase() === block.agent.toLowerCase(),
      );

      if (!targetAgent) {
        warnings.push(
          `Delegation rejected: target agent "${block.agent}" resolved but not found in DB.`,
        );
        continue;
      }

      validBlocks.push({ block, targetAgent });
    }

    if (validBlocks.length === 0) {
      // All blocks were invalid -- return the user message as-is
      return {
        delegated: false,
        userMessage: parseResult.userMessage || response,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    // 4. Create project task (parent) and subtasks
    const projectTask = await this.taskEngine.createTask({
      householdId,
      agentId,
      title: `Delegation from ${agent.name} for ${member.name}`,
      requestedBy: memberId,
      requiresApproval: false,
      delegationDepth: 0,
    });

    const subtaskIds: string[] = [];

    for (const { block, targetAgent } of validBlocks) {
      const subtask = await this.taskEngine.createTask({
        householdId,
        agentId: targetAgent.id,
        parentTaskId: projectTask.id,
        requestedBy: memberId,
        title: block.type || `Task for ${targetAgent.name}`,
        description: block.content,
        requiresApproval: false,
        delegationDepth: 1,
      });

      subtaskIds.push(subtask.id);

      // Log delegation decision
      await this.logEvent(
        subtask.id,
        "delegated",
        agentId,
        `${agent.name} delegated "${block.type || "task"}" to ${targetAgent.name}`,
        {
          fromAgent: agent.name,
          toAgent: targetAgent.name,
          blockType: block.type,
          contentPreview: block.content.slice(0, 200),
        },
      );
    }

    // 5. Trigger dispatcher for each subtask
    for (const subtaskId of subtaskIds) {
      try {
        await this.dispatcher.handleTaskAssignment(subtaskId);
      } catch (err) {
        console.error(
          `[orchestrator] Failed to dispatch subtask ${subtaskId}:`,
          err,
        );
      }
    }

    return {
      delegated: true,
      userMessage: parseResult.userMessage,
      projectId: projectTask.id,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Called when the dispatcher broadcasts project.completed.
   * Loads subtask results, synthesizes them into a single response,
   * and delivers it back to the member via broadcast.
   */
  async handleProjectCompleted(projectId: string): Promise<void> {
    // 1. Load the project task and all subtasks
    const projectTask = await this.taskEngine.getTask(projectId);
    if (!projectTask) {
      console.error(
        `[orchestrator] Project task ${projectId} not found for synthesis`,
      );
      return;
    }

    const subtasks = await this.taskEngine.getSubtasks(projectId);
    if (subtasks.length === 0) {
      console.error(
        `[orchestrator] No subtasks found for project ${projectId}`,
      );
      return;
    }

    // 2. Load the personal agent and the member
    const [agent, member] = await Promise.all([
      this.loadAgent(projectTask.agentId),
      projectTask.requestedBy
        ? this.loadMember(projectTask.requestedBy)
        : null,
    ]);

    if (!agent) {
      console.error(
        `[orchestrator] Agent ${projectTask.agentId} not found for synthesis`,
      );
      return;
    }

    const memberName = member?.name ?? "the user";

    // 3. Find the conversation to deliver the result
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, projectTask.agentId))
      .then((rows) =>
        rows.filter((c) =>
          member ? c.memberId === member.id : true,
        ),
      )
      .then((rows) =>
        rows.sort((a, b) =>
          (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""),
        ),
      )
      .then((rows) => [rows[0]]);

    // 4. Synthesize results
    let synthesizedResponse: string;

    const completedSubtasks = subtasks.filter((t) => t.status === "completed");
    const failedSubtasks = subtasks.filter((t) => t.status === "failed");

    if (subtasks.length === 1) {
      // Single subtask -- skip LLM synthesis
      const subtask = subtasks[0];
      if (subtask.status === "completed" && subtask.result) {
        synthesizedResponse = `Here's what I found:\n\n${subtask.result}`;
      } else {
        synthesizedResponse = `I wasn't able to complete that. ${subtask.result ?? "The task failed without details."}`;
      }
    } else {
      // Multiple subtasks -- synthesize via LLM
      synthesizedResponse = await this.synthesizeResults(
        agent,
        memberName,
        completedSubtasks,
        failedSubtasks,
      );
    }

    // 5. Record the synthesized response as an assistant message
    if (conversation) {
      try {
        const now = new Date().toISOString();

        await this.db.insert(messages).values({
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          role: "assistant",
          content: synthesizedResponse,
        });

        await this.db
          .update(conversations)
          .set({ lastMessageAt: now })
          .where(eq(conversations.id, conversation.id));
      } catch (err) {
        console.error(
          "[orchestrator] Failed to record synthesis message:",
          err,
        );
      }
    }

    // 6. Broadcast the result for the relay to deliver
    try {
      this.broadcast({
        type: "delegation.result",
        data: {
          memberId: member?.id ?? null,
          agentId: agent.id,
          conversationId: conversation?.id ?? null,
          response: synthesizedResponse,
        },
      });
    } catch (err) {
      console.error("[orchestrator] Failed to broadcast delegation result:", err);
    }

    // 7. Log synthesis event
    await this.logEvent(
      projectId,
      "synthesis_requested",
      agent.id,
      `Synthesis completed for ${subtasks.length} subtask(s)`,
      {
        completedCount: completedSubtasks.length,
        failedCount: failedSubtasks.length,
        responseLength: synthesizedResponse.length,
      },
    );
  }

  /**
   * Load delegation edges and target agent info for a given source agent.
   */
  async getDelegationEdges(
    agentId: string,
  ): Promise<
    Array<{
      agentId: string;
      agentName: string;
      staffRole: string;
      specialty: string | null;
    }>
  > {
    const edges = await this.db
      .select()
      .from(delegationEdges)
      .where(eq(delegationEdges.fromAgentId, agentId));

    if (edges.length === 0) return [];

    const results: Array<{
      agentId: string;
      agentName: string;
      staffRole: string;
      specialty: string | null;
    }> = [];

    for (const edge of edges) {
      const targetAgent = await this.loadAgent(edge.toAgentId);
      if (targetAgent) {
        results.push({
          agentId: targetAgent.id,
          agentName: targetAgent.name,
          staffRole: targetAgent.staffRole,
          specialty: targetAgent.specialty,
        });
      }
    }

    return results;
  }

  // -- Private: synthesis ---------------------------------------------

  /**
   * Invoke the personal agent's subprocess to synthesize multiple
   * subtask results into a single response for the member.
   * Falls back to raw result concatenation on LLM failure.
   */
  private async synthesizeResults(
    agent: {
      id: string;
      name: string;
      roleContent: string;
      soulContent: string | null;
    },
    memberName: string,
    completedSubtasks: Array<{ title: string; result: string | null }>,
    failedSubtasks: Array<{ title: string; result: string | null }>,
  ): Promise<string> {
    // Build the synthesis user prompt
    const resultSections: string[] = [];

    for (const subtask of completedSubtasks) {
      resultSections.push(
        `Task: ${subtask.title}\nResult: ${subtask.result ?? "(no result)"}`,
      );
    }

    for (const subtask of failedSubtasks) {
      resultSections.push(
        `Task: ${subtask.title}\nResult: FAILED -- ${subtask.result ?? "(no details)"}`,
      );
    }

    const synthesisUserMessage = [
      `You previously delegated work for ${memberName}. Here are the results:`,
      "",
      ...resultSections.map((s, i) =>
        i < resultSections.length - 1 ? `${s}\n` : s,
      ),
      "",
      `Synthesize these results into a single, helpful response for ${memberName}.`,
      "Maintain your personality (soul). Address them directly.",
    ].join("\n");

    // Build the system prompt using the personal agent's role + soul
    const systemPrompt = compileSystemPrompt({
      mode: "chat",
      roleContent: agent.roleContent,
      soulContent: agent.soulContent,
      softRules: "",
      constitutionDocument: "",
      memberName,
    });

    try {
      const result = await this.adapter.execute({
        systemPrompt,
        messages: [{ role: "user", content: synthesisUserMessage }],
      });

      return result.content;
    } catch (err) {
      // Synthesis LLM call failed -- fall back to raw results
      console.error("[orchestrator] Synthesis LLM call failed:", err);

      const parts = ["Here's what I found:"];

      for (const subtask of completedSubtasks) {
        parts.push("");
        parts.push(`**${subtask.title}**`);
        parts.push(subtask.result ?? "(no result)");
      }

      if (failedSubtasks.length > 0) {
        parts.push("");
        parts.push("Some tasks were unable to complete:");
        for (const subtask of failedSubtasks) {
          parts.push(`- ${subtask.title}: ${subtask.result ?? "(no details)"}`);
        }
      }

      return parts.join("\n");
    }
  }

  // -- Private: data loading ------------------------------------------

  private async loadAgent(agentId: string) {
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId));

    return agent ?? null;
  }

  private async loadMember(memberId: string) {
    const [member] = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId));

    return member ?? null;
  }

  // -- Private: event logging -----------------------------------------

  private async logEvent(
    taskId: string,
    eventType: string,
    agentId: string | null,
    message: string | null,
    payload?: unknown,
  ): Promise<void> {
    try {
      await this.db.insert(taskEvents).values({
        taskId,
        eventType,
        agentId: agentId ?? undefined,
        message,
        payload: payload ?? null,
        clauseIds: null,
      });
    } catch (err) {
      console.error("[orchestrator] Failed to log task event:", err);
    }
  }
}
