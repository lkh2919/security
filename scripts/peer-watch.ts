/**
 * Peer Watch (design C5): change detection on the peers' public privacy policies. Thin wrapper over `watchPeers`.
 *
 *   bun scripts/peer-watch.ts --config config/orgs/<org>/org.json [--group retail] [--dry-run] [--limit N] [--with-lotte]
 *
 * Same as `bun scripts/agent.ts peers ...` (see scripts/peers-cli.ts for the flags). Reference only: no rating, no ranking.
 */
import { join } from "node:path";
import { parsePeersArgs, runPeersCommand } from "./peers-cli";

const root = join(import.meta.dir, "..");
try {
  process.exit(await runPeersCommand(parsePeersArgs(root, process.argv.slice(2))));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
