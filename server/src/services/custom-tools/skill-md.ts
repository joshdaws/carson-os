/**
 * SKILL.md parser + writer. Format is compatible with Claude Code skills,
 * plus CarsonOS-specific frontmatter extensions (kind, input_schema, http).
 *
 * Frontmatter is minimal YAML (we parse a subset, not a full YAML implementation
 * — keeping it narrow so failures are predictable and no dependencies creep in).
 */

export type ToolKind = "http" | "prompt" | "script";

export interface HttpConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  urlTemplate: string;
  headers?: Record<string, string>;
  auth?: HttpAuth;
  bodyTemplate?: string;
  responseExtract?: string;
  domainAllowlist?: string[];
}

export type HttpAuth =
  | { method: "bearer"; secretKey: string }
  | { method: "header"; name: string; secretKey: string }
  | { method: "query"; param: string; secretKey: string };

export interface SkillFrontmatter {
  name: string;
  description: string;
  kind?: ToolKind;
  input_schema?: Record<string, unknown>;
  http?: HttpConfig;
  [key: string]: unknown; // other frontmatter fields are passed through
}

export interface SkillDoc {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** Parse a SKILL.md file's contents into frontmatter + body. */
export function parseSkillMd(content: string): SkillDoc {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new ParseError("SKILL.md must start with YAML frontmatter delimited by '---'");
  }
  const [, yaml, body] = match;
  const frontmatter = parseSimpleYaml(yaml) as SkillFrontmatter;
  if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
    throw new ParseError("SKILL.md frontmatter must include a non-empty 'name'");
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new ParseError("SKILL.md frontmatter must include a non-empty 'description'");
  }
  if (frontmatter.kind && !["http", "prompt", "script"].includes(frontmatter.kind)) {
    throw new ParseError(`SKILL.md 'kind' must be http, prompt, or script (got '${frontmatter.kind}')`);
  }
  return { frontmatter, body: body ?? "" };
}

/** Serialize a SKILL.md doc back to file content. */
export function writeSkillMd(doc: SkillDoc): string {
  const yaml = serializeSimpleYaml(doc.frontmatter);
  return `---\n${yaml}\n---\n\n${doc.body}\n`;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ── Minimal YAML subset ───────────────────────────────────────────────
//
// Supports: strings (quoted or bare), numbers, booleans, null,
// nested objects (2-space indent), arrays of primitives (inline [a, b, c]
// or dashed lists), comments (# at line start), multiline strings (>-folded
// or |literal).
//
// Does NOT support: anchors, aliases, tags, complex multi-doc streams,
// advanced flow collections. Tool configs don't need that.

function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> | unknown[]; lastKey?: string }> = [
    { indent: -1, obj: root },
  ];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = line.match(/^ */)![0].length;
    const content = line.slice(indent);

    // Pop stack until we find the parent (lower indent)
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];

    if (content.startsWith("- ")) {
      // Array item
      if (!Array.isArray(parent.obj)) {
        // Converting the last key of parent to array
        const grandparent = stack[stack.length - 2];
        if (!grandparent || !grandparent.lastKey) {
          throw new ParseError("Unexpected '-' at line " + (i + 1));
        }
        const arr: unknown[] = [];
        (grandparent.obj as Record<string, unknown>)[grandparent.lastKey] = arr;
        stack[stack.length - 1] = { indent, obj: arr };
      }
      const val = parseScalar(content.slice(2).trim());
      (stack[stack.length - 1].obj as unknown[]).push(val);
      i++;
      continue;
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) {
      throw new ParseError(`Expected 'key: value' at line ${i + 1}: ${content}`);
    }
    const key = content.slice(0, colonIdx).trim();
    const rest = content.slice(colonIdx + 1).trim();

    if (!rest) {
      // Nested object/array starts next line
      const child: Record<string, unknown> = {};
      (parent.obj as Record<string, unknown>)[key] = child;
      stack.push({ indent, obj: child, lastKey: key });
      (parent as { lastKey?: string }).lastKey = key;
      i++;
      continue;
    }

    if (rest === "|" || rest === ">") {
      // Multiline block scalar — literal or folded
      const blockIndent = indent + 2;
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln.trim()) { collected.push(""); i++; continue; }
        if (ln.match(/^ */)![0].length < blockIndent) break;
        collected.push(ln.slice(blockIndent));
        i++;
      }
      const value = rest === "|" ? collected.join("\n") : collected.join(" ");
      (parent.obj as Record<string, unknown>)[key] = value;
      (parent as { lastKey?: string }).lastKey = key;
      continue;
    }

    (parent.obj as Record<string, unknown>)[key] = parseScalar(rest);
    (parent as { lastKey?: string }).lastKey = key;
    i++;
  }
  return root;
}

function parseScalar(s: string): unknown {
  if (s === "") return "";
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  // Inline array: [a, b, c]
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  // Inline object: {k: v, ...}
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const obj: Record<string, unknown> = {};
    for (const pair of splitTopLevel(inner, ",")) {
      const [k, ...vParts] = pair.split(":");
      obj[k.trim()] = parseScalar(vParts.join(":").trim());
    }
    return obj;
  }
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return s;
}

function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === delim && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function serializeSimpleYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    lines.push(`${pad}${key}: ${serializeValue(value, indent)}`);
  }
  return lines.join("\n");
}

function serializeValue(v: unknown, indent: number): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v.includes("\n")) {
      // Use literal block
      const body = v
        .split("\n")
        .map((l) => " ".repeat(indent + 2) + l)
        .join("\n");
      return "|\n" + body;
    }
    if (needsQuoting(v)) return JSON.stringify(v);
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    // Use inline for arrays of primitives
    if (v.every((x) => typeof x !== "object" || x === null)) {
      return "[" + v.map((x) => serializeValue(x, indent)).join(", ") + "]";
    }
    // Block-style
    return "\n" + v.map((x) => " ".repeat(indent + 2) + "- " + serializeValue(x, indent + 2)).join("\n");
  }
  if (typeof v === "object") {
    const nested = serializeSimpleYaml(v as Record<string, unknown>, indent + 2);
    return "\n" + nested;
  }
  return String(v);
}

function needsQuoting(s: string): boolean {
  // Quote if starts with special chars, contains a colon followed by space,
  // or is a YAML keyword (true/false/null/yes/no).
  if (!s) return true;
  if (/^[!&*?|>%@`\[\]{}]/.test(s)) return true;
  if (/^(true|false|null|yes|no|~)$/i.test(s)) return true;
  if (s.includes(": ")) return true;
  if (s.trim() !== s) return true;
  return false;
}
