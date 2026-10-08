import { z } from 'zod';

/**
 * Messages the Claude Code Skill hands to the CLI in MCP mode (as JSON files).
 *
 * The CLI cannot call MCP tools: the OAuth authorization belongs to the Claude Code
 * session. So the Skill calls the tools, and passes their raw results here. The CLI
 * owns every decision (state, checkpoints, retries) and validates what it is given.
 * The envelopes are strict; the tool results inside are untrusted and parsed by
 * src/mcp/results.ts.
 */

const ToolResult = z.unknown();

const ProbeOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: ToolResult }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      message: z.string().max(2000),
      status: z.int().min(100).max(599).optional(),
    }),
  }),
]);

/**
 * `git2jira mcp verify --input <file>`: what the session can see and what read-only
 * probe calls returned. Every probe is optional; a missing probe proves nothing.
 */
export const McpProbeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Every tool name visible in the Claude Code session (at least all `mcp__…` ones). */
  tools: z.array(z.string().min(1).max(200)).max(2000),
  server: z.string().max(64).optional(),
  probes: z
    .strictObject({
      resources: ProbeOutcomeSchema.optional(),
      userInfo: ProbeOutcomeSchema.optional(),
      issue: ProbeOutcomeSchema.optional(),
    })
    .default({}),
});

export type McpProbe = z.infer<typeof McpProbeSchema>;
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>;

/**
 * `git2jira report record-result --input <file>`: what happened to the one comment
 * creation call the CLI authorized with `report publish`.
 * - `tool-returned`: the tool answered without an error; `toolResult` is its raw output.
 * - `tool-error`: the tool (or the server) returned an error.
 * - `not-called`: the call was not made (the user denied Claude Code's permission
 *   prompt, or the tool was unavailable). Treated as a definite non-delivery, but a
 *   later retry still requires a comment listing that shows the report is absent.
 */
export const McpWriteResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('tool-returned'), toolResult: ToolResult }),
  z.strictObject({
    outcome: z.literal('tool-error'),
    error: z.strictObject({
      message: z.string().max(2000),
      status: z.int().min(100).max(599).optional(),
    }),
  }),
  z.strictObject({
    outcome: z.literal('not-called'),
    reason: z.enum(['permission-denied', 'tool-unavailable', 'user-cancelled']),
  }),
]);

export type McpWriteResult = z.infer<typeof McpWriteResultSchema>;

/**
 * `git2jira report reconcile --input <file>`: the issue's comments as returned by
 * the comment listing tool (one page or an array of pages), and optionally the
 * signed-in account so only that account's comments count.
 */
export const McpReconcileInputSchema = z.strictObject({
  comments: ToolResult,
  account: ToolResult.optional(),
});

export type McpReconcileInput = z.infer<typeof McpReconcileInputSchema>;
