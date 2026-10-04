/**
 * OrgConfig (design C4): `config/orgs/<org>/org.json`. A new department brings data, not code. Holds no secrets and no personal
 * data; reviewers are role labels or placeholders, never contact details.
 */
import { z } from "zod";
import { NonEmptyString } from "./common";

export const DEFAULT_TENANT_ID = "default";

/** Directory-safe tenant id: it prefixes every run, registry, watch and report path. */
export const TenantIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "tenantId must be 1-32 chars of [a-z0-9-], starting with a letter or digit");
export type TenantId = z.infer<typeof TenantIdSchema>;

export const ORG_APPS = ["check", "impact", "peers", "draft"] as const;
export const OrgAppSchema = z.enum(ORG_APPS);
export type OrgApp = z.infer<typeof OrgAppSchema>;

export const OrgConfigSchema = z.strictObject({
  name: NonEmptyString,
  tenantId: TenantIdSchema,
  /** Peer-comparison group (for example a retail group). */
  domainGroup: NonEmptyString,
  /** Folder of the org's published policies (.md, .html), relative to the repository root unless absolute. */
  policyDir: NonEmptyString,
  /** Reviewer role labels for reports; no names or contacts. */
  reviewers: z.array(NonEmptyString).optional(),
  apps: z.array(OrgAppSchema).min(1),
  /** `none`: deterministic checks only. */
  llm: z.enum(["api", "claude-code", "none"]),
  /** Rule-pack ids under kb/jurisdictions/kr/rulepacks; the first one also drives the C2 checks. */
  rulePacks: z.array(NonEmptyString).min(1),
  /** Peer registry file (design C4), relative to the config folder. */
  peersFile: NonEmptyString.optional(),
});
export type OrgConfig = z.infer<typeof OrgConfigSchema>;
