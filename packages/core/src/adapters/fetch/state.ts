/**
 * Fetch bookkeeping that must survive between runs: the per-host "one page per UTC day" limit and back-off, plus the conditional GET
 * validators (ETag / Last-Modified) and the raw-content hash of each URL. File-backed in production (`peers/fetch-state.json`, mode
 * 0600), in memory in tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { atomicWriteFile } from "../../pipeline/fs-atomic";
import { EMPTY_FETCH_STATE, FetchStateSchema, type FetchState } from "../../contracts/peers";

export type HostState = FetchState["hosts"][string];
export type UrlState = FetchState["urls"][string];

export interface FetchStateStore {
  host(host: string): HostState;
  setHost(host: string, patch: HostState): void;
  url(key: string): UrlState;
  setUrl(key: string, patch: UrlState): void;
  /** Persist (no-op in memory). */
  flush(): Promise<void>;
}

export class MemoryFetchState implements FetchStateStore {
  protected state: FetchState;
  constructor(initial: FetchState = EMPTY_FETCH_STATE) {
    this.state = { version: 1, hosts: { ...initial.hosts }, urls: { ...initial.urls } };
  }
  host(host: string): HostState {
    return this.state.hosts[host] ?? {};
  }
  setHost(host: string, patch: HostState): void {
    this.state.hosts[host] = { ...this.host(host), ...patch };
  }
  url(key: string): UrlState {
    return this.state.urls[key] ?? {};
  }
  setUrl(key: string, patch: UrlState): void {
    this.state.urls[key] = { ...this.url(key), ...patch };
  }
  async flush(): Promise<void> {}
  snapshot(): FetchState {
    return structuredClone(this.state);
  }
}

export class FileFetchState extends MemoryFetchState {
  constructor(private readonly file: string) {
    super(FileFetchState.read(file));
  }
  private static read(file: string): FetchState {
    if (!existsSync(file)) return EMPTY_FETCH_STATE;
    try {
      return FetchStateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      // Starting over would lift every back-off and daily limit: refuse instead.
      throw new Error(`[FETCH_STATE] ${file} is not a valid fetch state (${err instanceof Error ? err.message.slice(0, 160) : "error"}); fix or remove it`);
    }
  }
  override async flush(): Promise<void> {
    await atomicWriteFile(this.file, `${JSON.stringify(FetchStateSchema.parse(this.snapshot()), null, 2)}\n`);
    await chmod(this.file, 0o600).catch(() => undefined);
  }
}
