/**
 * Fakes for the box service's tests: a provider adapter whose "cloud" is a map, a hub whose boxes
 * connect on demand (a `localBoxConnection` each), and a service factory wiring them with fake
 * accounts. Nothing here touches the network or a real provider.
 */

import { EventEmitter } from "node:events";
import { join } from "node:path";

import type { BoxKind, BoxProviderCredentialField, BoxProviderId, BoxSizeOffer } from "@orquester/api";

import type {
  BoxAgentConfig,
  BoxConnection,
  BoxHub,
  BoxProviderAdapter,
  BuildBootstrap,
  ProviderCreateRequest,
  ProviderCreateResult,
  ProviderCredentials,
  ProviderInstanceRef,
  ProviderInstanceState,
  ProviderInstanceStatus,
  ProviderManagedInstance,
  ProviderOffers
} from "../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../testing.ts";
import { createBoxService, type BoxService, type BoxServiceDeps } from "./index.ts";
import type { BoxClock } from "./lifecycle.ts";

export interface FakeInstance {
  ref: { id: string };
  name: string;
  boxId: string | null;
  state: ProviderInstanceState;
  createdAt: string;
}

export interface FakeAdapterOptions {
  id?: BoxProviderId;
  label?: string;
  kinds?: BoxKind[];
  sizes?: BoxSizeOffer[];
  maxLifetimeMinutes?: number | null;
  needsWindowsImage?: boolean;
  credentialFields?: BoxProviderCredentialField[];
}

/** A provider whose instances live in `instances`. Toggle the `fail*` fields to make calls throw. */
export class FakeAdapter implements BoxProviderAdapter {
  readonly id: BoxProviderId;
  readonly label: string;
  readonly kinds: readonly BoxKind[];
  readonly website = "https://example.test";
  readonly credentialsUrl = "https://example.test/keys";
  readonly credentialFields: readonly BoxProviderCredentialField[];
  readonly accountNote = null;
  readonly maxLifetimeMinutes: number | null;
  readonly needsWindowsImage: boolean;

  readonly instances = new Map<string, FakeInstance>();
  readonly creates: ProviderCreateRequest[] = [];
  readonly destroyed: string[] = [];
  readonly validKey = "good-key-1234";
  failCreate: Error | null = null;
  failDestroy: Error | null = null;
  /** Destroy succeeds but the instance never reports gone. */
  destroyLeavesRunning = false;
  /** Called inside `create` before the instance exists (assert the record is already written). */
  onCreate: ((request: ProviderCreateRequest) => void) | null = null;
  offersCalls = 0;
  private next = 1;
  private readonly sizes: BoxSizeOffer[];

  constructor(options: FakeAdapterOptions = {}) {
    this.id = options.id ?? "hetzner";
    this.label = options.label ?? "Fake Cloud";
    this.kinds = options.kinds ?? ["linux"];
    this.maxLifetimeMinutes = options.maxLifetimeMinutes ?? null;
    this.needsWindowsImage = options.needsWindowsImage ?? false;
    this.credentialFields = options.credentialFields ?? [{ id: "apiKey", label: "API key", secret: true }];
    this.sizes = options.sizes ?? [
      { id: "big", label: "Big 8 vCPU", vcpu: 8, ramGb: 16, diskGb: 160, gpu: null, hourlyUsd: 0.2, regions: [] },
      { id: "small", label: "Small 2 vCPU", vcpu: 2, ramGb: 4, diskGb: 40, gpu: null, hourlyUsd: 0.05, regions: ["fsn1"] }
    ];
  }

  async validate(credentials: ProviderCredentials) {
    return credentials.apiKey === this.validKey ? ({ ok: true } as const) : ({ ok: false, message: "invalid token" } as const);
  }

  async offers(): Promise<ProviderOffers> {
    this.offersCalls += 1;
    return {
      sizes: this.sizes,
      regions: [
        { id: "fsn1", label: "Falkenstein", country: "DE" },
        { id: "ash", label: "Ashburn", country: "US" }
      ],
      images: [],
      priceSource: "table"
    };
  }

  async create(_credentials: ProviderCredentials, request: ProviderCreateRequest): Promise<ProviderCreateResult> {
    this.onCreate?.(request);
    this.creates.push(request);
    if (this.failCreate) throw this.failCreate;
    const id = `i-${this.next++}`;
    this.instances.set(id, { ref: { id }, name: request.name, boxId: request.boxId, state: "running", createdAt: new Date().toISOString() });
    return { ref: { id }, hourlyUsd: null };
  }

  async status(_credentials: ProviderCredentials, ref: ProviderInstanceRef): Promise<ProviderInstanceStatus> {
    const instance = this.instances.get(String(ref.id));
    return { state: instance?.state ?? "gone", detail: instance ? null : "Not found", publicIp: null, hourlyUsd: null };
  }

  async destroy(_credentials: ProviderCredentials, ref: ProviderInstanceRef): Promise<void> {
    if (this.failDestroy) throw this.failDestroy;
    this.destroyed.push(String(ref.id));
    if (!this.destroyLeavesRunning) this.instances.delete(String(ref.id));
  }

  async listManaged(): Promise<ProviderManagedInstance[]> {
    return [...this.instances.values()].map((instance) => ({ ...instance }));
  }
}

/**
 * A hub whose boxes connect when `connect(boxId)` is called — or at once in `waitConnected` when
 * `autoConnect` builds a connection for them. `waitConnected` otherwise waits for that call (or
 * the signal), never on a timer; `refuseConnect` makes it reject at once (a connect timeout).
 */
export class FakeHub implements BoxHub {
  readonly connections = new Map<string, BoxConnection>();
  readonly tokens = new Map<string, string>();
  readonly revoked: string[] = [];
  autoConnect: ((boxId: string) => BoxConnection) | null = null;
  refuseConnect: Error | null = null;
  private readonly events = new EventEmitter();

  get(boxId: string): BoxConnection | undefined {
    return this.connections.get(boxId);
  }

  async waitConnected(boxId: string, options?: { signal?: AbortSignal }): Promise<BoxConnection> {
    const existing = this.connections.get(boxId);
    if (existing?.connected) return existing;
    if (this.refuseConnect) throw this.refuseConnect;
    if (this.autoConnect) return this.connect(boxId, this.autoConnect(boxId));
    return await new Promise<BoxConnection>((resolve, reject) => {
      const onConnected = (id: string, connected: boolean) => {
        if (id !== boxId || !connected) return;
        cleanup();
        resolve(this.connections.get(boxId)!);
      };
      const onAbort = () => {
        cleanup();
        reject(options?.signal?.reason ?? new Error("aborted"));
      };
      const cleanup = () => {
        this.events.off("change", onConnected);
        options?.signal?.removeEventListener("abort", onAbort);
      };
      this.events.on("change", onConnected);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  connect(boxId: string, connection: BoxConnection): BoxConnection {
    this.connections.set(boxId, connection);
    this.events.emit("change", boxId, true);
    return connection;
  }

  disconnect(boxId: string): void {
    (this.connections.get(boxId) as LocalBoxConnection | undefined)?.setConnected(false);
    this.events.emit("change", boxId, false);
  }

  async issueBootstrapToken(boxId: string): Promise<string> {
    const token = `boot-${boxId}`;
    this.tokens.set(boxId, token);
    return token;
  }

  async revoke(boxId: string): Promise<void> {
    this.revoked.push(boxId);
  }

  setForwards(_boxId: string, _forwards: BoxAgentConfig["forwards"]): void {}
  handle(): void {}
  handleRaw(): void {}
  handleChannel(): void {}

  onConnectionChange(listener: (boxId: string, connected: boolean) => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }
}

export const fakeBootstrap: BuildBootstrap = (input) => ({
  posixScript: `#!/bin/sh\n# box ${input.boxId}\n`,
  powershellScript: "# windows",
  containerCommand: ["/bin/sh", "-c", "true"],
  env: {},
  cloudInit: "#cloud-config\n"
});

/** A clock whose `wait` resolves at once (provider polls in tests); `now` is real unless set. */
export function testClock(now?: () => number): BoxClock {
  return { now: now ?? (() => Date.now()), wait: async () => undefined };
}

/** A local "box" whose git and HOME are confined to `home` (setup writes the box user's global git config). */
export function isolatedBoxConnection(boxId: string, home: string): LocalBoxConnection {
  const connection = localBoxConnection({ boxId, sys: { home } });
  const exec = connection.exec.bind(connection);
  connection.exec = (options) =>
    exec({ ...options, env: { ...(options.env ?? {}), HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } });
  return connection;
}

export interface TestServiceOptions {
  baseDir: string;
  adapters?: BoxProviderAdapter[];
  hub?: FakeHub;
  enabled?: boolean;
  overrides?: Partial<BoxServiceDeps>;
}

export interface TestService {
  service: BoxService;
  hub: FakeHub;
  published: { type: string; payload: unknown }[];
  setEnabled(enabled: boolean): void;
}

export function testBoxService(options: TestServiceOptions): TestService {
  const hub = options.hub ?? new FakeHub();
  const published: { type: string; payload: unknown }[] = [];
  const listeners = new Set<(enabled: boolean) => void>();
  let enabled = options.enabled ?? true;
  const providers = new Map((options.adapters ?? []).map((adapter) => [adapter.id, adapter] as const));
  const service = createBoxService({
    baseDir: options.baseDir,
    providers,
    hub,
    buildBootstrap: fakeBootstrap,
    tailscale: () => ({ mintAuthKey: async () => "tskey-auth-test", removeNode: async () => undefined }),
    accounts: {
      list: async () => [
        {
          id: "acct",
          label: "Work",
          provider: "github",
          login: "octo",
          githubLogin: "octo",
          host: "github.com",
          gitName: "Octo Cat",
          gitEmail: "octo@example.com",
          publicKey: "ssh-ed25519 AAAA",
          repoAccess: true,
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      token: async () => "ghp_testtoken",
      resolveClone: async (_accountId, input) => ({ url: input, name: input.split("/").pop()!.replace(/\.git$/, "") }),
      createRepo: async (_accountId, repo) => ({ url: `git@github.com:${repo.owner}/${repo.name}.git` })
    },
    git: {
      identity: async (accountId) => (accountId === "acct" ? { name: "Octo Cat", email: "octo@example.com" } : null),
      knownHosts: async () => "github.com ssh-ed25519 AAAAtest\n"
    },
    managedAgentHomes: () => [],
    pluginEnabled: async () => enabled,
    onPluginChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    publish: (_channel, type, payload) => published.push({ type, payload }),
    publicOrigin: () => "https://orq.example.test",
    clock: testClock(),
    logger: { warn: () => undefined, error: () => undefined, log: () => undefined },
    ...options.overrides
  });
  return {
    service,
    hub,
    published,
    setEnabled(next) {
      enabled = next;
      for (const listener of listeners) listener(next);
    }
  };
}

/** Store a provider's credentials straight through the service (validated by the fake adapter). */
export async function connectProvider(service: BoxService, adapter: FakeAdapter): Promise<void> {
  await service.settings.setCredentials(adapter.id, { credentials: { apiKey: adapter.validKey } });
}
