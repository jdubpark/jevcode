import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { JSONUIProvider, Renderer } from "@json-render/react";

import type { Spec } from "@json-render/core";

import type {
  ArchitectureDeltaProps,
  BehaviorDeltaProps,
  DependencyDeltaProps,
  ExecutionTimelineProps,
  SchemaDeltaProps,
} from "@jevcode/contracts";

import { registry } from "../index.js";
import { ArchitectureDelta } from "./ArchitectureDelta.js";
import { BehaviorDelta } from "./BehaviorDelta.js";
import {
  DEPENDENCY_CHILDREN_CONTAINER_ID,
  DependencyDelta,
} from "./DependencyDelta.js";
import { ExecutionTimeline } from "./ExecutionTimeline.js";
import { SchemaDelta } from "./SchemaDelta.js";
import { installReactFlowPolyfills } from "../test/react-flow-polyfills.js";

installReactFlowPolyfills();

function renderWithHandlers(node: React.ReactNode, handlers: Record<string, (params: Record<string, unknown>) => void>) {
  render(<JSONUIProvider registry={registry} handlers={handlers}>{node}</JSONUIProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BehaviorDelta", () => {
  const props: BehaviorDeltaProps = {
    title: "GET /users/:id on missing user: 404 -> 200 with null body",
    subject: "missing_user_response",
    before: 'HTTP 404 { error: "user <id> not found" }',
    after: "HTTP 200 { user: null }",
    symbols: ["handleGetUser"],
    files: ["src/routes/users.ts", "tests/users.test.ts"],
  };

  it("renders before/after blocks, change badges, and evidence chips", () => {
    render(<BehaviorDelta props={props} />);
    expect(screen.getByTestId("behavior-delta")).toBeTruthy();
    expect(screen.getByText("behavior change")).toBeTruthy();
    expect(
      screen.getByText("missing_user_response").getAttribute("data-subject"),
    ).toBe("missing_user_response");
    expect(screen.getByTestId("before").textContent).toContain("HTTP 404");
    expect(screen.getByTestId("after").textContent).toContain(
      "HTTP 200 { user: null }",
    );
    const evidence = screen.getByTestId("behavior-evidence");
    expect(evidence.getAttribute("data-file-count")).toBe("2");
    expect(evidence.getAttribute("data-symbol-count")).toBe("1");
    expect(evidence.textContent).toContain("src/routes/users.ts");
    expect(evidence.textContent).toContain("handleGetUser");
  });

  it("emits actions from props.actions", async () => {
    const calls: { action: string; params: Record<string, unknown> }[] = [];
    renderWithHandlers(
      <BehaviorDelta
        props={{
          ...props,
          actions: [
            {
              action: "restore_previous_api_semantics",
              params: { symbol: "handleGetUser" },
            },
          ],
        }}
      />,
      {
        restore_previous_api_semantics: (params) => {
          calls.push({ action: "restore_previous_api_semantics", params });
        },
      },
    );
    fireEvent.click(
      document.querySelector('[data-action="restore_previous_api_semantics"]')!,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.params).toEqual({ symbol: "handleGetUser" });
  });
});

describe("ExecutionTimeline", () => {
  const props: ExecutionTimelineProps = {
    title: "Execution",
    events: [
      { id: "e-1", ts: "2026-09-18T09:00:00.000Z", kind: "agent", label: "I will now add the rate limiter" },
      { id: "e-2", ts: "2026-09-18T09:00:02.000Z", kind: "command", label: "pnpm add ioredis" },
      { id: "e-3", ts: "2026-09-18T09:00:05.000Z", kind: "validation", label: "pnpm test passed" },
      { id: "e-4", ts: "2026-09-18T09:00:07.000Z", kind: "decision", label: "Redis failure policy: fail open" },
      { id: "e-5", ts: "2026-09-18T09:00:09.000Z", label: "Session review completed" },
    ],
  };

  it("shows milestones and filters agent narration out", () => {
    render(<ExecutionTimeline props={props} />);
    const timeline = screen.getByTestId("execution-timeline");
    expect(timeline.getAttribute("data-event-count")).toBe("5");
    expect(timeline.getAttribute("data-milestone-count")).toBe("4");
    expect(screen.queryByText("I will now add the rate limiter")).toBeNull();
    expect(screen.getByText("pnpm add ioredis")).toBeTruthy();
    expect(screen.getByText("pnpm test passed")).toBeTruthy();
    expect(screen.getByText("Redis failure policy: fail open")).toBeTruthy();
    expect(screen.getByText("Session review completed")).toBeTruthy();
  });

  it("labels validation milestones as tests", () => {
    render(<ExecutionTimeline props={props} />);
    const testKind = document.querySelector(
      '[data-kind="validation"]',
    );
    expect(testKind?.textContent).toBe("test");
  });

  it("keeps the curated input order", () => {
    render(<ExecutionTimeline props={props} />);
    const events = document.querySelectorAll("[data-timeline-event]");
    const ids = Array.from(events).map((el) => el.getAttribute("data-timeline-event"));
    expect(ids).toEqual(["e-2", "e-3", "e-4", "e-5"]);
  });
});

describe("SchemaDelta", () => {
  const props: SchemaDeltaProps = {
    title: "users table: profile fields added, password hash removed",
    migration: "migrations/001_alter_users.sql",
    changes: [
      { entity: "full_name", entityType: "column", change: "added", after: "TEXT NOT NULL DEFAULT ''" },
      { entity: "last_login_at", entityType: "column", change: "added", after: "TIMESTAMPTZ" },
      { entity: "password_hash", entityType: "column", change: "removed", before: "TEXT" },
      { entity: "users_pkey", entityType: "constraint", change: "modified", before: "PRIMARY KEY (id)", after: "PRIMARY KEY (id, org_id)" },
    ],
    compatibilityNote:
      "Callers must stop reading password_hash; getUserProfile returns full_name but not last_login_at.",
  };

  it("renders a table with entities, change badges, and counts", () => {
    render(<SchemaDelta props={props} />);
    expect(screen.getByTestId("schema-delta")).toBeTruthy();
    expect(screen.getByText("migrations/001_alter_users.sql")).toBeTruthy();
    const counts = screen.getByTestId("schema-counts");
    expect(
      counts.querySelector('[data-change="added"]')?.getAttribute("data-count"),
    ).toBe("2");
    expect(
      counts
        .querySelector('[data-change="removed"]')
        ?.getAttribute("data-count"),
    ).toBe("1");
    expect(
      counts
        .querySelector('[data-change="modified"]')
        ?.getAttribute("data-count"),
    ).toBe("1");
    const rows = screen.getByTestId("schema-table").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(4);
    expect(document.querySelector('[data-entity="full_name"]')).toBeTruthy();
    expect(
      document.querySelector('[data-entity="password_hash"]')?.textContent,
    ).toContain("removed");
  });

  it("shows before/after details where provided", () => {
    render(<SchemaDelta props={props} />);
    const details = screen.getAllByTestId("schema-detail");
    expect(details).toHaveLength(4);
    expect(details[0]?.textContent).toContain("TEXT NOT NULL DEFAULT");
    expect(
      details.find((el) => el.textContent?.includes("PRIMARY KEY (id, org_id)")),
    ).toBeTruthy();
  });

  it("renders the compatibility note and actions", () => {
    renderWithHandlers(
      <SchemaDelta
        props={{
          ...props,
          actions: [
            { action: "show_exact_diff", params: { files: ["migrations/001_alter_users.sql"] } },
          ],
        }}
      />,
      {},
    );
    expect(screen.getByTestId("compatibility-note").textContent).toContain(
      "password_hash",
    );
    expect(
      document.querySelector('[data-action="show_exact_diff"]'),
    ).toBeTruthy();
  });
});

describe("DependencyDelta", () => {
  const props: DependencyDeltaProps = {
    title: "Dependency swap: axios -> fetch + zod",
    added: [
      {
        name: "zod",
        version: "^3.24.1",
        reason: "response validation in fetchJson",
        usage: "src/helpers/http.ts",
      },
    ],
    removed: [{ name: "axios", version: "^1.7.0", reason: "replaced by native fetch" }],
  };

  it("renders added/removed packages with reason and usage", () => {
    render(<DependencyDelta props={props} />);
    expect(screen.getByTestId("dependency-delta")).toBeTruthy();
    expect(screen.getByText("+ zod ^3.24.1")).toBeTruthy();
    expect(screen.getByText("- axios ^1.7.0")).toBeTruthy();
    expect(screen.getAllByTestId("dep-reason").map((el) => el.textContent)).toEqual([
      "response validation in fetchJson",
      "replaced by native fetch",
    ]);
    expect(screen.getByTestId("dep-usage").textContent).toContain(
      "src/helpers/http.ts",
    );
    expect(document.querySelector("[data-dep=zod]")?.getAttribute("data-dep-kind")).toBe(
      "added",
    );
    expect(
      document.querySelector("[data-dep=axios]")?.getAttribute("data-dep-kind"),
    ).toBe("removed");
  });

  it("shows no diff link when no CodeDiff child is present", () => {
    render(<DependencyDelta props={props} />);
    expect(screen.queryByTestId("dep-diff-link")).toBeNull();
  });

  it("scrolls to the CodeDiff child container when the link is clicked", () => {
    const scrollIntoView = vi.fn();
    vi.stubGlobal("scrollIntoView", scrollIntoView);
    const el = document.createElement("div");
    el.id = DEPENDENCY_CHILDREN_CONTAINER_ID;
    el.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
    document.body.appendChild(el);
    render(<DependencyDelta props={props} diffChildPresent={true} />);
    fireEvent.click(screen.getByTestId("dep-diff-link"));
    expect(scrollIntoView).toHaveBeenCalled();
    document.body.removeChild(el);
    vi.unstubAllGlobals();
  });

  it("emits actions from props.actions", async () => {
    const calls: { action: string; params: Record<string, unknown> }[] = [];
    renderWithHandlers(
      <DependencyDelta
        props={{
          ...props,
          actions: [
            {
              action: "show_exact_diff",
              params: { files: ["src/helpers/http.ts", "package.json"] },
            },
          ],
        }}
      />,
      {
        show_exact_diff: (params) => {
          calls.push({ action: "show_exact_diff", params });
        },
      },
    );
    fireEvent.click(document.querySelector('[data-action="show_exact_diff"]')!);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.params).toEqual({
      files: ["src/helpers/http.ts", "package.json"],
    });
  });
});

describe("ArchitectureDelta", () => {
  const props: ArchitectureDeltaProps = {
    title: "Request pipeline: Client -> RateLimiter -> API, backed by Redis",
    category: "architecture",
    status: "in_progress",
    confidence: 0.89,
    scope: "subsystem",
    evidenceCount: 4,
    nodes: [
      { id: "n-client", label: "Client", kind: "external" },
      { id: "n-app", label: "API (createApp)", kind: "module", path: "src/server/app.ts" },
      { id: "n-limiter", label: "RateLimiter", kind: "middleware", path: "src/middleware/rate-limiter.ts" },
      { id: "n-redis", label: "Redis", kind: "service" },
      { id: "n-config", label: "RateLimitOptions", kind: "config", path: "src/middleware/rate-limiter.ts" },
    ],
    edges: [
      { from: "n-client", to: "n-limiter", label: "request" },
      { from: "n-limiter", to: "n-app", label: "next()" },
      { from: "n-limiter", to: "n-redis", label: "INCR / PEXPIRE" },
      { from: "n-config", to: "n-limiter", label: "window, max, failOpen" },
    ],
    actions: [{ action: "inspect_call_sites", params: { symbol: "rateLimiter" } }],
  };

  it("renders every node with its kind style and every edge", async () => {
    const { container } = render(
      <JSONUIProvider registry={registry} handlers={{}}>
        <ArchitectureDelta props={props} />
      </JSONUIProvider>,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("architecture-delta")).toBeTruthy();
    const graph = screen.getByTestId("arch-graph");
    expect(graph.getAttribute("data-node-count")).toBe("5");
    expect(graph.getAttribute("data-edge-count")).toBe("4");
    for (const node of props.nodes) {
      const el = container.querySelector(`[data-id="${node.id}"]`);
      expect(el, `missing node ${node.id}`).toBeTruthy();
    }
    expect(
      container
        .querySelector('[data-id="n-redis"]')
        ?.className.includes("jevcode-arch-service"),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-id="n-client"]')
        ?.className.includes("jevcode-arch-dependency"),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-id="n-config"]')
        ?.className.includes("jevcode-arch-config"),
    ).toBe(true);
    expect(
      container.querySelectorAll('[aria-label^="edge "]'),
    ).toHaveLength(4);
  });

  it("shows node labels and paths", async () => {
    const { container } = render(
      <JSONUIProvider registry={registry} handlers={{}}>
        <ArchitectureDelta props={props} />
      </JSONUIProvider>,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
    });
    const limiter = container.querySelector('[data-id="n-limiter"]');
    expect(limiter?.textContent).toContain("RateLimiter");
    expect(limiter?.textContent).toContain("src/middleware/rate-limiter.ts");
  });

  it("positions nodes deterministically from the layered layout", async () => {
    const { container } = render(
      <JSONUIProvider registry={registry} handlers={{}}>
        <ArchitectureDelta props={props} />
      </JSONUIProvider>,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
    });
    const client = container.querySelector('[data-id="n-client"]');
    const limiter = container.querySelector('[data-id="n-limiter"]');
    const clientStyle = client?.getAttribute("style") ?? "";
    const limiterStyle = limiter?.getAttribute("style") ?? "";
    expect(clientStyle).toContain("0px");
    expect(limiterStyle).toMatch(/translate\(280px/);
  });

  it("renders actions and evidence count", async () => {
    const calls: { action: string; params: Record<string, unknown> }[] = [];
    renderWithHandlers(
      <ArchitectureDelta
        props={{
          ...props,
          actions: [{ action: "inspect_call_sites", params: { symbol: "rateLimiter" } }],
        }}
      />,
      {
        inspect_call_sites: (params) => {
          calls.push({ action: "inspect_call_sites", params });
        },
      },
    );
    expect(screen.getByTestId("arch-evidence").textContent).toContain("4");
    fireEvent.click(document.querySelector('[data-action="inspect_call_sites"]')!);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.params).toEqual({ symbol: "rateLimiter" });
  });
});

describe("registry DependencyDelta diff link", () => {
  it("shows the diff link when the element has a CodeDiff child", async () => {
    const spec: Spec = {
      root: "root",
      elements: {
        root: {
          type: "DependencyDelta",
          props: {
            title: "Dependency swap",
            added: [
              { name: "zod", version: "^3.24.1", reason: "response validation", usage: "src/helpers/http.ts" },
            ],
            removed: [],
          },
          children: ["diff"],
        },
        diff: {
          type: "CodeDiff",
          props: { file: "src/helpers/http.ts", diff: "-axios\n+zod\n" },
          children: [],
        },
      },
    };
    const scrollIntoView = vi.fn();
    const container = document.createElement("div");
    container.id = DEPENDENCY_CHILDREN_CONTAINER_ID;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(
        <JSONUIProvider registry={registry} handlers={{}}>
          <Renderer spec={spec} registry={registry} />
        </JSONUIProvider>,
      );
      const link = screen.getByTestId("dep-diff-link");
      expect(link).toBeTruthy();
      expect(screen.getByTestId("code-diff")).toBeTruthy();
      fireEvent.click(link);
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
      void container;
    }
  });
});
