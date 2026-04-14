import type { customTools } from "@carsonos/db";
import type { ToolDefinition } from "@carsonos/shared";

import type { RegisteredTool } from "../tool-registry.js";
import { bundleFromPath } from "./fs-helpers.js";
import { parseSkillMd } from "./skill-md.js";

export interface CustomRegistration {
  toolId: string;
  householdId: string;
  name: string;
  kind: "http" | "prompt" | "script";
  generation: number;
  schemaVersion: number;
  absDir: string;
  body: string;
  httpConfig?: import("./skill-md.js").HttpConfig;
  registered: RegisteredTool;
}

export function buildRegistrationFromRow(
  row: typeof customTools.$inferSelect,
  frontmatter: ReturnType<typeof parseSkillMd>["frontmatter"],
  body: string,
  absDir: string,
): CustomRegistration {
  const definition: ToolDefinition = {
    name: frontmatter.name,
    description: frontmatter.description,
    input_schema: (frontmatter.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
  };

  const category =
    row.source === "installed-skill"
      ? "installed-skill"
      : bundleFromPath(row.path) ?? `custom-${row.kind}`;

  return {
    toolId: row.id,
    householdId: row.householdId,
    name: row.name,
    kind: row.kind as "http" | "prompt" | "script",
    generation: row.generation,
    schemaVersion: row.schemaVersion,
    absDir,
    body,
    httpConfig: (frontmatter.http as CustomRegistration["httpConfig"]) ?? undefined,
    registered: {
      definition,
      category,
      tier: "custom",
    },
  };
}
