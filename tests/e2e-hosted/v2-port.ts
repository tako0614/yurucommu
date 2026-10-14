import {
  API,
  HarnessError,
  appOrigin,
  check,
  form,
  record,
  text,
  uidPattern,
  type Artifact,
  type JsonObject,
  type Operation,
  type Resource,
  type Role,
  type Target,
} from "./contracts.ts";
import { parseJson, sha256 } from "./inputs.ts";

export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export interface Port {
  preflight(
    names: readonly { role: Role; name: string }[],
    files: readonly Artifact[],
  ): Promise<void>;
  create(
    role: Role,
    name: string,
    spec: JsonObject,
    key: string,
    privateInputs?: Readonly<Record<string, string>>,
  ): Promise<Operation>;
  delete(resource: Resource, key: string): Promise<Operation>;
  operation(id: string): Promise<Operation>;
  resource(uid: string): Promise<Resource>;
  absent(uid: string): Promise<boolean>;
  appJson(origin: string, path: string): Promise<unknown>;
  routeAbsent(origin: string): Promise<boolean>;
}
function identity(value: unknown): string {
  const id = text(value);
  check(uidPattern.test(id), "IDENTITY_REFUSED");
  return id;
}
export function parseOperation(value: unknown): Operation {
  const op = record(value);
  check(op.action === "create" || op.action === "delete", "OPERATION_REFUSED");
  check(
    Number.isSafeInteger(op.generation) &&
      (op.generation as number) >= 1 &&
      [
        "queued",
        "running",
        "waiting_input",
        "reconciling",
        "succeeded",
        "failed",
      ].includes(text(op.status)) &&
      ["none", "unknown", "partial", "complete"].includes(text(op.effect)),
    "OPERATION_REFUSED",
  );
  return {
    id: identity(op.id),
    resourceUid: identity(op.resourceUid),
    action: op.action,
    generation: op.generation as number,
    status: text(op.status),
    effect: text(op.effect),
  };
}
export function parseResource(value: unknown): Resource {
  const item = record(value);
  check(
    Number.isSafeInteger(item.generation) &&
      (item.generation as number) >= 1 &&
      Number.isSafeInteger(item.observedGeneration) &&
      (item.observedGeneration as number) >= 0,
    "RESOURCE_REFUSED",
  );
  return {
    uid: identity(item.uid),
    form: text(item.form),
    space: text(item.space),
    name: text(item.name),
    generation: item.generation as number,
    observedGeneration: item.observedGeneration as number,
    phase: text(item.phase),
    lastOperation: identity(item.lastOperation),
    spec: record(item.spec),
    observed: record(item.observed),
    output: record(item.output),
  };
}
export class HttpV2Port implements Port {
  private base: string | undefined;
  constructor(
    private readonly target: Target,
    private readonly writer: string,
    private readonly evidence: string,
    private readonly transport: Transport = (url, init) => fetch(url, init),
  ) {}
  private async read(
    url: string,
    method = "GET",
    token?: string,
    body?: unknown,
    headers: Record<string, string> = {},
    limit = 1_048_576,
  ): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.transport(url, {
        method,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      check(
        response.status < 300 || response.status >= 400,
        "REDIRECT_REFUSED",
      );
      const length = response.headers.get("content-length");
      check(
        !length || (/^\d+$/.test(length) && Number(length) <= limit),
        "RESPONSE_TOO_LARGE",
      );
      reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          check(size <= limit, "RESPONSE_TOO_LARGE");
          parts.push(next.value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return { status: response.status, bytes, headers: response.headers };
    } catch {
      throw new HarnessError("HTTP_UNCONFIRMED");
    } finally {
      clearTimeout(timeout);
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* No diagnostics from a transport. */
        }
      }
    }
  }
  private decode(response: { bytes: Uint8Array; headers: Headers }): unknown {
    check(
      /^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ),
      "JSON_REQUIRED",
    );
    return parseJson(response.bytes);
  }
  private api(path: string): string {
    check(this.base, "PREFLIGHT_REQUIRED");
    return `${this.base}${path}`;
  }
  private acknowledged(value: unknown): Operation {
    const op = parseOperation(value);
    check(
      ![op.id, op.resourceUid].some(
        (id) => id.includes(this.writer) || id.includes(this.evidence),
      ),
      "CREDENTIAL_IN_METADATA",
    );
    return op;
  }
  async preflight(
    names: readonly { role: Role; name: string }[],
    files: readonly Artifact[],
  ): Promise<void> {
    // Public artifacts are anonymously readable, immutable digest identities.
    // No writer/evidence or application private input is sent to the publisher.
    for (const file of files) {
      const response = await this.read(
        file.url,
        "GET",
        undefined,
        undefined,
        {},
        16_777_216,
      );
      check(
        response.status === 200 && sha256(response.bytes) === file.sha256,
        "ARTIFACT_PUBLICATION_UNCONFIRMED",
      );
    }
    const response = await this.read(
      `${this.target.hostOrigin}/.well-known/takoform/v2`,
    );
    check(response.status === 200, "HOST_DISCOVERY_REFUSED");
    const discovery = record(this.decode(response));
    const base = new URL(text(discovery.baseUrl));
    check(
      discovery.api === API &&
        base.origin === this.target.hostOrigin &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash &&
        base.href === discovery.baseUrl &&
        /^\/[A-Za-z0-9._/-]+$/.test(base.pathname) &&
        !base.pathname.endsWith("/") &&
        !base.pathname.includes("//") &&
        record(discovery.capabilities).privateInputs === true,
      "HOST_DISCOVERY_REFUSED",
    );
    this.base = base.href;
    const supported = new Set<string>();
    for (const { role, name } of names) {
      const url = form(role);
      if (!supported.has(url)) {
        const support = await this.read(
          this.api(`/support?${new URLSearchParams({ form: url })}`),
          "GET",
          this.evidence,
        );
        check(support.status === 200, "FORM_UNQUALIFIED");
        const entry = record(this.decode(support));
        check(
          entry.form === url &&
            entry.supported === true &&
            Array.isArray(entry.operations) &&
            ["create", "read", "delete"].every((action) =>
              (entry.operations as unknown[]).includes(action),
            ) &&
            (role !== "version" || entry.privateInputs === true),
          "FORM_UNQUALIFIED",
        );
        supported.add(url);
      }
      const existing = await this.read(
        this.api(
          `/resources?${new URLSearchParams({ space: this.target.space, name, form: url, limit: "1" })}`,
        ),
        "GET",
        this.evidence,
      );
      check(existing.status === 200, "NAMESPACE_UNCONFIRMED");
      const page = record(this.decode(existing));
      check(
        Array.isArray(page.items) &&
          page.items.length === 0 &&
          page.nextCursor === null,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
  }
  async create(
    role: Role,
    name: string,
    spec: JsonObject,
    key: string,
    privateInputs?: Readonly<Record<string, string>>,
  ): Promise<Operation> {
    const result = await this.read(
      this.api("/resources"),
      "POST",
      this.writer,
      {
        form: form(role),
        space: this.target.space,
        name,
        spec,
        ...(privateInputs ? { privateInputs } : {}),
      },
      { "idempotency-key": key },
    );
    check(result.status === 200 || result.status === 202, "ACK_UNCONFIRMED");
    const op = this.acknowledged(this.decode(result));
    check(
      result.headers.get("location") ===
        this.api(`/operations/${encodeURIComponent(op.id)}`),
      "ACK_UNCONFIRMED",
    );
    return op;
  }
  async delete(resource: Resource, key: string): Promise<Operation> {
    const result = await this.read(
      this.api(`/resources/${encodeURIComponent(identity(resource.uid))}`),
      "DELETE",
      this.writer,
      undefined,
      {
        "idempotency-key": key,
        "takoform-expected-generation": String(resource.generation),
      },
    );
    check(result.status === 200 || result.status === 202, "ACK_UNCONFIRMED");
    const op = this.acknowledged(this.decode(result));
    check(
      result.headers.get("location") ===
        this.api(`/operations/${encodeURIComponent(op.id)}`),
      "ACK_UNCONFIRMED",
    );
    return op;
  }
  async operation(id: string): Promise<Operation> {
    const result = await this.read(
      this.api(`/operations/${encodeURIComponent(identity(id))}`),
      "GET",
      this.evidence,
    );
    check(result.status === 200, "OPERATION_UNCONFIRMED");
    return this.acknowledged(this.decode(result));
  }
  async resource(uid: string): Promise<Resource> {
    const result = await this.read(
      this.api(`/resources/${encodeURIComponent(identity(uid))}`),
      "GET",
      this.evidence,
    );
    check(result.status === 200, "RESOURCE_UNCONFIRMED");
    return parseResource(this.decode(result));
  }
  async absent(uid: string): Promise<boolean> {
    const result = await this.read(
      this.api(`/resources/${encodeURIComponent(identity(uid))}`),
      "GET",
      this.evidence,
    );
    // Authentication/authorization errors, network loss, and redirects are never absence.
    return result.status === 404 || result.status === 410;
  }
  async appJson(origin: string, path: string): Promise<unknown> {
    check(appOrigin(`${origin}/`) === origin, "APP_ORIGIN_REFUSED");
    check(
      [
        "/healthz",
        "/readyz",
        "/.well-known/social-server",
        "/nodeinfo/2.0",
      ].includes(path),
      "APP_PATH_REFUSED",
    );
    const result = await this.read(`${origin}${path}`);
    check(result.status === 200, "HEALTH_FAILED");
    return this.decode(result);
  }
  async routeAbsent(origin: string): Promise<boolean> {
    check(appOrigin(`${origin}/`) === origin, "APP_ORIGIN_REFUSED");
    const result = await this.read(`${origin}/healthz`);
    return result.status === 404 || result.status === 410;
  }
}
