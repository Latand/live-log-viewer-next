import { z } from "zod";

export const flowDecisionRequestSchema = z.object({
  clientRequestId: z.string().min(1).max(200),
  flowId: z.string().min(1),
  decision: z.enum(["submit-review", "continue-fixing", "stop", "completed"]),
  reason: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().nonnegative(),
  expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
  round: z.number().int().nonnegative(),
  turnId: z.string().min(1).max(200),
  stage: z.object({ pipelineId: z.string().min(1), stageId: z.string().min(1), attempt: z.number().int().positive() }).optional(),
});
