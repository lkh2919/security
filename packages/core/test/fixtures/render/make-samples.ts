/** Writes sample renders to runs/_samples (gitignored). Run: bun packages/core/test/fixtures/render/make-samples.ts */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRender } from "../../../src/stages/render";
import { failAudit, policyAst, termsAst, vault } from "./docs";

const dir = join(import.meta.dir, "..", "..", "..", "..", "..", "runs", "_samples");
mkdirSync(dir, { recursive: true });
async function main(): Promise<void> {
const out = await runRender({
  policy: policyAst,
  terms: termsAst,
  options: { vault, organizationName: "샘플회사", generatedAt: "2026-09-30T00:00:00.000Z", changeHistory: [{ date: "2026-10-01", version: "1.0", summary: "최초 제정" }] },
  audits: [failAudit],
  slotEvidence: { "privacy.S02_purposes": ["T0001", "T0004"], "privacy.S09_processors": ["T0007"] },
  openQuestions: ["수탁자 보유 기간 확인"],
});
for (const f of out.files) writeFileSync(join(dir, f.name), f.bytes);
console.log(dir, out.files.length, out.warnings.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
