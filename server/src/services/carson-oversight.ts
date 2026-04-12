/**
 * Carson Oversight -- approval algorithm for task execution.
 *
 * Determines whether a task should be auto-approved, escalated to a parent,
 * or blocked based on constitution clauses and the agent's autonomy level.
 */

import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  tasks,
  staffAgents,
  constitutions,
  constitutionClauses,
} from "@carsonos/db";
import type { MemberRole, EnforcementLevel, EvaluationType } from "@carsonos/shared";
import type { ConstitutionEngine } from "./constitution-engine.js";
import type { BroadcastFn } from "./event-bus.js";
import {
  evaluateKeywordBlock,
  evaluateAgeGate,
  evaluateRoleRestrict,
} from "./evaluators.js";

// -- Types -----------------------------------------------------------

export interface CarsonOversightConfig {
  db: Db;
  constitutionEngine: ConstitutionEngine;
  broadcast: BroadcastFn;
}

export interface ReviewResult {
  approved: boolean;
  reason: string;
}

// -- Oversight -------------------------------------------------------

export class CarsonOversight {
  private db: Db;
  private constitutionEngine: ConstitutionEngine;
  private broadcast: BroadcastFn;

  constructor(config: CarsonOversightConfig) {
    this.db = config.db;
    this.constitutionEngine = config.constitutionEngine;
    this.broadcast = config.broadcast;
  }

  async reviewTask(taskId: string): Promise<ReviewResult> {
    // -- 1. Load the task and its agent ------------------------------
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    if (!task) {
      return { approved: false, reason: "Task not found" };
    }

    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, task.agentId));

    if (!agent) {
      return { approved: false, reason: "Agent not found for task" };
    }

    // -- 2. Run hard clause evaluators against task content ----------
    const textToCheck = `${task.title} ${task.description ?? ""}`.trim();

    const [constitution] = await this.db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.householdId, task.householdId),
          eq(constitutions.isActive, true),
        ),
      )
      .limit(1);

    if (constitution) {
      const clauses = await this.db
        .select()
        .from(constitutionClauses)
        .where(
          and(
            eq(constitutionClauses.constitutionId, constitution.id),
            eq(constitutionClauses.enforcementLevel, "hard"),
          ),
        );

      for (const clause of clauses) {
        const violation = this.checkClauseViolation(
          clause,
          textToCheck,
        );

        if (violation) {
          // Log the policy event
          await this.constitutionEngine.logPolicyEvent(
            task.householdId,
            task.agentId,
            null,
            taskId,
            clause.id,
            "enforced",
            { task: textToCheck, violation },
          );

          this.broadcast({
            type: "oversight.blocked",
            data: {
              taskId,
              agentId: agent.id,
              clauseId: clause.id,
              reason: violation,
            },
          });

          return {
            approved: false,
            reason: `Blocked by clause: ${violation}`,
          };
        }
      }
    }

    // -- 3. Check agent autonomy level -------------------------------
    const autonomy = agent.autonomyLevel as
      | "autonomous"
      | "trusted"
      | "supervised";

    switch (autonomy) {
      case "autonomous":
        return { approved: true, reason: "Agent has autonomous privileges" };

      case "trusted":
        if (task.requiresApproval) {
          this.broadcast({
            type: "oversight.escalated",
            data: { taskId, agentId: agent.id, reason: "Task requires approval" },
          });
          return {
            approved: false,
            reason: "Task requires parental approval (trusted agent)",
          };
        }
        return {
          approved: true,
          reason: "Trusted agent, no approval flag set",
        };

      case "supervised":
      default:
        this.broadcast({
          type: "oversight.escalated",
          data: {
            taskId,
            agentId: agent.id,
            reason: "Supervised agent requires approval",
          },
        });
        return {
          approved: false,
          reason: "Supervised agent: all tasks require parental approval",
        };
    }
  }

  // -- Private helpers -----------------------------------------------

  private checkClauseViolation(
    clause: {
      evaluationType: string;
      evaluationConfig: unknown;
      id: string;
    },
    text: string,
  ): string | null {
    const config = clause.evaluationConfig as Record<string, unknown> | null;

    switch (clause.evaluationType as EvaluationType) {
      case "keyword_block": {
        const result = evaluateKeywordBlock(
          text,
          clause.id,
          (config as any) ?? { blockedTerms: [] },
        );
        return result.allowed ? null : (result.reason ?? "Keyword violation");
      }

      // Age gate and role restrict don't apply to tasks directly
      // (tasks don't have a "member age" or "member role" in isolation)
      // These are checked during message processing instead

      default:
        return null;
    }
  }
}
