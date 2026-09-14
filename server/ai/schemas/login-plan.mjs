import { z } from "zod";

export const ALLOWED_SCENARIOS = [
  "valid_login",
  "password_masked",
  "empty_fields",
  "logout",
  "invalid_password",
];

export const AIPlan = z
  .object({
    title: z.literal("Login essentials"),
    scenarios: z.array(z.enum(ALLOWED_SCENARIOS)).min(1).max(5),
    summary: z.string().min(1).max(600),
    clarification: z.string().max(600),
  })
  .strict()
  .refine(
    (p) => new Set(p.scenarios).size === p.scenarios.length,
    "Duplicate scenarios are not allowed.",
  );
