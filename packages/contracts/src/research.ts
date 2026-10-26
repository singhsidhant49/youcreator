import { z } from "zod";

export const ResearchProvenanceSchema = z.enum([
  "wikipedia",
  "search_engine",
  "brave",
  "duckduckgo",
  "manual_entry",
  "mock",
]);

export type ResearchProvenance = z.infer<typeof ResearchProvenanceSchema>;

export const ResearchSourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url().or(z.string().min(1)),
  title: z.string().min(1),
  snippet: z.string().min(1),
  sourceDomain: z.string().min(1),
  publishedDate: z.string().optional(),
  retrievedAt: z.string().datetime(),
  credibilityScore: z.number().min(0).max(1).default(0.8),
  provenance: ResearchProvenanceSchema.default("search_engine"),
}).strict();

export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export const ClaimTypeSchema = z.enum([
  "numerical",
  "historical",
  "scientific",
  "current_event",
  "general",
]);

export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ClaimVerificationStatusSchema = z.enum([
  "verified",
  "unsupported",
  "disputed",
  "unverified",
]);

export type ClaimVerificationStatus = z.infer<typeof ClaimVerificationStatusSchema>;

export const ClaimRecordSchema = z.object({
  id: z.string().min(1),
  claimText: z.string().min(1),
  claimType: ClaimTypeSchema,
  supportingSourceIds: z.array(z.string()).default([]),
  evidenceSnippet: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  contradictions: z.array(z.string()).default([]),
  status: ClaimVerificationStatusSchema,
  remediation: z.string().optional(),
}).strict();

export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

export const ResearchPolicyModeSchema = z.enum([
  "required",
  "optional",
  "disabled",
]);

export type ResearchPolicyMode = z.infer<typeof ResearchPolicyModeSchema>;

export const ResearchPolicySchema = z.object({
  mode: ResearchPolicyModeSchema.default("optional"),
  maxQueries: z.number().int().positive().default(4),
  maxSources: z.number().int().positive().default(8),
  minCredibility: z.number().min(0).max(1).default(0.6),
  requireVerificationFor: z.array(ClaimTypeSchema).default([
    "numerical",
    "historical",
    "scientific",
    "current_event",
  ]),
  allowUnverifiedDraft: z.boolean().default(false),
}).strict();

export type ResearchPolicy = z.infer<typeof ResearchPolicySchema>;

export const FactualResearchReportSchema = z.object({
  version: z.literal(1),
  topic: z.string().min(1),
  queriesExecuted: z.array(z.string()),
  sources: z.array(ResearchSourceSchema),
  claims: z.array(ClaimRecordSchema),
  overallFactualityScore: z.number().min(0).max(100),
  verifiedClaimsCount: z.number().int().nonnegative(),
  unsupportedClaimsCount: z.number().int().nonnegative(),
  disputedClaimsCount: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type FactualResearchReport = z.infer<typeof FactualResearchReportSchema>;
