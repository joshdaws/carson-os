/**
 * Hire-proposal approval routes for Signal-only family members (v0.5.2 / TODO-6).
 *
 * Two surfaces:
 *
 *   GET  /api/approval/redeem?token=...
 *     Renders a tiny standalone HTML confirmation page (no React, no
 *     /api/login) that shows what action is about to fire and gives the
 *     user a Confirm button. The page POSTs the token back to redeem.
 *     Reason for the two-step: messaging clients (including Signal Desktop
 *     and iOS Signal) speculatively prefetch URL previews; a one-shot GET
 *     would auto-fire the action whenever the message is rendered.
 *
 *   POST /api/approval/redeem  body: { token } (or form-encoded `token=`)
 *     Validates HMAC + expiry, dispatches to delegation-service's existing
 *     handleHireApproval / handleHireRejection. Same materialization path
 *     as the Telegram inline-button flow and the /tasks Web UI buttons.
 *
 * Mounted under /api/approval so it sits behind the same loopback bind
 * as the rest of the API. The deep-link host is configurable via
 * CARSONOS_PUBLIC_BASE_URL when the operator runs a tunnel (Tailscale,
 * cloudflared) so phones outside the LAN can hit the page.
 */

import express, { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { tasks } from "@carsonos/db";
import type { DelegationService } from "../services/delegation-service.js";
import { verifyApprovalToken } from "../services/approval-token.js";

export interface ApprovalRouteDeps {
  db: Db;
  delegationService: DelegationService;
}

/** Minimal HTML escape for the few user-controlled strings we render
 *  server-side (task title + status). The redemption page is otherwise
 *  static. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(args: {
  title: string;
  bodyHtml: string;
  status?: number;
}): { status: number; html: string } {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(args.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; line-height: 1.5; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.4em; margin: 0 0 16px; }
    .card { padding: 16px; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; margin: 16px 0; }
    .meta { color: #666; font-size: 0.9em; }
    button { padding: 14px 28px; font-size: 16px; border-radius: 6px; border: none; cursor: pointer; font-weight: 500; }
    button.approve { background: #2ecc71; color: white; }
    button.reject { background: #e74c3c; color: white; }
    .actions { margin-top: 24px; }
    .secondary { display: inline-block; margin-left: 16px; color: #666; text-decoration: none; }
    .error { color: #c0392b; }
  </style>
</head>
<body>
  ${args.bodyHtml}
</body>
</html>`;
  return { status: args.status ?? 200, html };
}

export function createApprovalRoutes(deps: ApprovalRouteDeps): Router {
  const { db, delegationService } = deps;
  const router = Router();
  const formParser = express.urlencoded({ extended: false });

  // GET /api/approval/redeem?token=... — the confirmation page.
  router.get("/redeem", async (req: Request, res: Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      const { status, html } = htmlPage({
        title: "Invalid link",
        bodyHtml: `<h1>Invalid link</h1><p class="error">No approval token provided.</p>`,
        status: 400,
      });
      res.status(status).type("html").send(html);
      return;
    }

    const verification = await verifyApprovalToken(db, token);
    if (!verification.ok) {
      const { status, html } = htmlPage({
        title: "Link expired or invalid",
        bodyHtml: `<h1>Link expired or invalid</h1><p class="error">${escapeHtml(verification.reason)}</p><p>Ask the agent to repropose if you still want to act on this.</p>`,
        status: 400,
      });
      res.status(status).type("html").send(html);
      return;
    }

    const { taskId, action } = verification.payload;
    const [task] = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!task) {
      const { status, html } = htmlPage({
        title: "Task not found",
        bodyHtml: `<h1>Task not found</h1><p class="error">This proposal may have expired.</p>`,
        status: 404,
      });
      res.status(status).type("html").send(html);
      return;
    }

    if (task.status !== "pending") {
      const { status, html } = htmlPage({
        title: "Already resolved",
        bodyHtml: `<h1>Already resolved</h1><p>This hire proposal is already <strong>${escapeHtml(task.status)}</strong>. No further action needed.</p>`,
        status: 409,
      });
      res.status(status).type("html").send(html);
      return;
    }

    const buttonClass = action === "approve" ? "approve" : "reject";
    const buttonLabel = action === "approve" ? "Approve hire" : "Reject hire";
    const { status, html } = htmlPage({
      title: `Confirm: ${action} hire`,
      bodyHtml: `
  <h1>${action === "approve" ? "Approve this hire?" : "Reject this hire?"}</h1>
  <div class="card">
    <strong>${escapeHtml(task.title)}</strong>
    <div class="meta">Task ${escapeHtml(task.id)}</div>
  </div>
  <p>Tap below to confirm. Closing this page or navigating away cancels.</p>
  <form method="POST" action="/api/approval/redeem" class="actions">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit" class="${buttonClass}">${escapeHtml(buttonLabel)}</button>
  </form>`,
    });
    res.status(status).type("html").send(html);
  });

  // POST /api/approval/redeem — actually executes the action.
  // Accepts both JSON (programmatic clients) and form-encoded (the HTML
  // page above). Returns JSON for the JSON path, HTML for the form path.
  router.post("/redeem", formParser, express.json(), async (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const isForm = req.is("application/x-www-form-urlencoded") !== false &&
      req.is("application/x-www-form-urlencoded") !== null;

    if (!token) {
      if (isForm) {
        const { status, html } = htmlPage({
          title: "Invalid request",
          bodyHtml: `<h1>Invalid request</h1><p class="error">No token provided.</p>`,
          status: 400,
        });
        res.status(status).type("html").send(html);
      } else {
        res.status(400).json({ error: "token required" });
      }
      return;
    }

    const verification = await verifyApprovalToken(db, token);
    if (!verification.ok) {
      if (isForm) {
        const { status, html } = htmlPage({
          title: "Link expired or invalid",
          bodyHtml: `<h1>Link expired or invalid</h1><p class="error">${escapeHtml(verification.reason)}</p>`,
          status: 400,
        });
        res.status(status).type("html").send(html);
      } else {
        res.status(400).json({ error: verification.reason });
      }
      return;
    }

    const { taskId, action } = verification.payload;
    const result =
      action === "approve"
        ? await delegationService.handleHireApproval(taskId, "signal-deeplink")
        : await delegationService.handleHireRejection(taskId, "signal-deeplink");

    if (!result.ok) {
      if (isForm) {
        const { status, html } = htmlPage({
          title: "Action failed",
          bodyHtml: `<h1>Action failed</h1><p class="error">${escapeHtml(result.error)}</p>`,
          status: 400,
        });
        res.status(status).type("html").send(html);
      } else {
        res.status(400).json({ error: result.error });
      }
      return;
    }

    if (isForm) {
      const { status, html } = htmlPage({
        title: action === "approve" ? "Hire approved" : "Hire rejected",
        bodyHtml: `<h1>${action === "approve" ? "Approved" : "Rejected"}</h1><p>The agent will pick this up on their next interaction.</p>`,
      });
      res.status(status).type("html").send(html);
    } else {
      res.json({ ok: true, action, result });
    }
  });

  return router;
}
