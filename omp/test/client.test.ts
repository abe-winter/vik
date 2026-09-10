import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { RELATION_KINDS, VikunjaClient } from "../src/vikunja";

type JsonBody = Record<string, unknown>;
type RecordedRequest = { method: string; path: string; query: URLSearchParams; authorization: string | null; body: JsonBody | undefined };
type FakeServer = { stop(closeActiveConnections?: boolean): void };
const servers: FakeServer[] = [];

function fakeServer(handler: (request: RecordedRequest) => Response): { url: string; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const recorded = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        authorization: request.headers.get("authorization"),
        body: text ? JSON.parse(text) as JsonBody : undefined,
      };
      requests.push(recorded);
      return handler(recorded);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

afterEach(() => { while (servers.length) servers.pop()?.stop(true); });

async function clientFor(server: string) {
  return VikunjaClient.create({
    cwd: "/workspace",
    env: { VIKUNJA_TOKEN: "secret", HOME: "/home/test" },
    readFile: async (path) => path === "/workspace/.vikunja.yaml" ? `server: ${server}\nproject: 17\nusername: me\nuser_id: 73` : Promise.reject(new Error("ENOENT")),
  });
}

test("list sends direct authenticated API request and Rust-compatible filters", async () => {
  const fake = fakeServer((request) => {
    if (request.path === "/api/v1/tasks") return Response.json([]);
    if (request.path === "/api/v1/projects/17") return Response.json({ id: 17 });
    return new Response("unexpected", { status: 500 });
  });
  const { client, config } = await clientFor(fake.url);
  await expect(client.list(config, { state: "doing", mine: true, filter: "priority >= 3", search: "plan", sortBy: "priority", orderBy: "desc" })).resolves.toEqual({ tasks: [], count: 0, truncated: false, limit: 200 });
  expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/tasks", authorization: "Bearer secret" });
  expect(fake.requests[0].query.get("filter")).toBe("project_id = 17 && done = false && percent_done > 0 && assignees in me && (priority >= 3)");
  expect(fake.requests[0].query.get("per_page")).toBe("50");
  expect(fake.requests[0].query.get("s")).toBe("plan");
  expect(fake.requests[0].query.get("sort_by")).toBe("priority");
  expect(fake.requests[0].query.get("order_by")).toBe("desc");
  expect(fake.requests[1]).toMatchObject({ path: "/api/v1/projects/17", authorization: "Bearer secret" });
});

test("create converts Markdown and uses the project task endpoint", async () => {
  const fake = fakeServer((request) => Response.json({ id: 3, done: false, ...(request.body ?? {}) }));
  const { client, config } = await clientFor(fake.url);
  await expect(client.create(config, { title: "new", description: "**bold**", priority: 2, percentDone: 0.25 })).resolves.toEqual({ id: 3, title: "new", done: false, priority: 2, description: "**bold**" });
  expect(fake.requests[0]).toMatchObject({ method: "PUT", path: "/api/v1/projects/17/tasks", body: { title: "new", description: "<p><strong>bold</strong></p>\n", priority: 2, percent_done: 0.25 } });
});

test("modify reads, merges, and preserves omitted Vikunja value fields", async () => {
  const current = { id: 9, title: "old", description: "<p>before</p>", done: true, priority: 5, percent_done: 1, bucket_id: 44 };
  const fake = fakeServer((request) => request.method === "GET" ? Response.json(current) : Response.json(request.body));
  const { client } = await clientFor(fake.url);
  await expect(client.modify({ taskId: 9, description: "after", state: "doing", percentDone: 0.75 })).resolves.toEqual({ id: 9, title: "old", done: false, priority: 5, description: "after" });
  expect(fake.requests).toHaveLength(2);
  expect(fake.requests[1]).toMatchObject({ method: "POST", path: "/api/v1/tasks/9", body: { ...current, description: "<p>after</p>\n", done: false, percent_done: 0.75 } });
});

test("claiming prefers configured user_id and does not require user search permission", async () => {
  const fake = fakeServer((request) => {
    if (request.method === "PUT" && request.path === "/api/v1/tasks/9/assignees") return Response.json({ created: true });
    if (request.method === "GET" && request.path === "/api/v1/tasks/9") {
      return Response.json({ id: 9, index: 99, title: "claimed", done: false, assignees: [{ username: "me" }] });
    }
    return new Response("unexpected", { status: 500 });
  });
  const { client, config } = await clientFor(fake.url);
  await expect(client.assign(config, { taskId: 9, mine: true })).resolves.toEqual({
    id: 9,
    index: 99,
    title: "claimed",
    done: false,
    assignees: ["me"],
  });
  expect(fake.requests[0]).toMatchObject({
    method: "PUT",
    path: "/api/v1/tasks/9/assignees",
    body: { user_id: 73 },
  });
  expect(fake.requests.some(({ path }) => path === "/api/v1/users")).toBe(false);
});

test("attachment listing returns compact file metadata", async () => {
  const fake = fakeServer(() => Response.json([{
    id: 12,
    task_id: 9,
    created: "2026-09-04T12:00:00Z",
    created_by: { username: "me", email: "ignored@example.test" },
    file: { id: 33, name: "render.png", mime: "image/png", size: 2048, extra: true },
  }]));
  const { client } = await clientFor(fake.url);
  await expect(client.attachments(9)).resolves.toEqual({
    attachments: [{
      id: 12,
      task_id: 9,
      created: "2026-09-04T12:00:00Z",
      created_by: "me",
      file: { id: 33, name: "render.png", mime: "image/png", size: 2048 },
    }],
    count: 1,
    truncated: false,
    limit: 200,
  });
  expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/tasks/9/attachments" });
});

test("explicit username assignment resolves the user and tolerates already-assigned responses", async () => {
  const fake = fakeServer((request) => {
    if (request.method === "GET" && request.path === "/api/v1/users") {
      return Response.json([{ id: 81, username: "alice" }]);
    }
    if (request.method === "PUT" && request.path === "/api/v1/tasks/9/assignees") {
      return Response.json({ code: 4021, message: "already assigned" }, { status: 400 });
    }
    if (request.method === "GET" && request.path === "/api/v1/tasks/9") {
      return Response.json({ id: 9, title: "claimed", done: false, assignees: [{ username: "alice" }] });
    }
    return new Response("unexpected", { status: 500 });
  });
  const { client, config } = await clientFor(fake.url);
  await expect(client.assign(config, { taskId: 9, assigneeUsername: "alice" })).resolves.toMatchObject({ assignees: ["alice"] });
  expect(fake.requests[0].query.get("s")).toBe("alice");
  expect(fake.requests[1].body).toEqual({ user_id: 81 });
});

test("attachment upload embeds the returned image without resetting task fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vik-attachment-"));
  const attachmentPath = join(directory, "render.png");
  await writeFile(attachmentPath, "png fixture");
  let uploadContentType = "";
  let uploadedName = "";
  let postedTask: JsonBody | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "PUT" && url.pathname === "/api/v1/tasks/9/attachments") {
        uploadContentType = request.headers.get("content-type") ?? "";
        const form = await request.formData();
        const file = form.get("files");
        uploadedName = file instanceof File ? file.name : "";
        return Response.json({ success: [{ id: 12, task_id: 9, file: { id: 33, name: uploadedName, mime: "image/png", size: 11 } }] });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks/9") {
        return Response.json({ id: 9, index: 99, title: "render", done: true, priority: 5, description: "<p>Existing</p>" });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/tasks/9") {
        postedTask = await request.json() as JsonBody;
        return Response.json(postedTask);
      }
      return new Response("unexpected", { status: 500 });
    },
  });
  servers.push(server);
  try {
    const { client } = await clientFor(`http://127.0.0.1:${server.port}`);
    const result = await client.attach({ taskId: 9, files: [attachmentPath], embed: true }, "/workspace");
    expect(uploadContentType).toStartWith("multipart/form-data; boundary=");
    expect(uploadedName).toBe("render.png");
    expect(postedTask).toMatchObject({ id: 9, index: 99, done: true, priority: 5 });
    expect(postedTask?.description).toContain("/api/v1/tasks/9/attachments/12");
    expect(result).toMatchObject({
      attachments: [{ id: 12, task_id: 9, file: { id: 33, name: "render.png" } }],
      task: { id: 9, index: 99, done: true, priority: 5 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relate sends the base-task direction and returns refreshed relations", async () => {
  let relationExists = false;
  const relatedTask = { id: 401, index: 27, identifier: "OPS-27", project_id: 13, title: "dependent", done: false };
  const fake = fakeServer((request) => {
    if (request.method === "PUT" && request.path === "/api/v1/tasks/400/relations") {
      relationExists = true;
      return Response.json({ task_id: 400, other_task_id: 401, relation_kind: "blocking" }, { status: 201 });
    }
    if (request.method === "GET" && request.path === "/api/v1/tasks/400") {
      return Response.json({ id: 400, index: 99, title: "base", done: false, related_tasks: relationExists ? { blocking: [relatedTask] } : {} });
    }
    return new Response("unexpected", { status: 500 });
  });
  const { client } = await clientFor(fake.url);
  await expect(client.relate({ taskId: 400, otherTaskId: 401, relationKind: "blocking" })).resolves.toMatchObject({
    id: 400,
    index: 99,
    related_tasks: { blocking: [relatedTask] },
  });
  expect(fake.requests[0]).toMatchObject({
    method: "PUT",
    path: "/api/v1/tasks/400/relations",
    body: { other_task_id: 401, relation_kind: "blocking" },
  });
});

test("unrelate preflights the exact directional tuple before deleting", async () => {
  let relationExists = true;
  const relatedTask = { id: 401, index: 27, identifier: "OPS-27", project_id: 13, title: "dependent", done: false };
  const fake = fakeServer((request) => {
    if (request.method === "GET" && request.path === "/api/v1/tasks/400") {
      return Response.json({ id: 400, index: 99, title: "base", done: false, related_tasks: relationExists ? { blocking: [relatedTask] } : {} });
    }
    if (request.method === "DELETE" && request.path === "/api/v1/tasks/400/relations/blocking/401") {
      relationExists = false;
      return Response.json({ message: "relation removed" });
    }
    return new Response("unexpected", { status: 500 });
  });
  const { client } = await clientFor(fake.url);
  await expect(client.unrelate({ taskId: 400, otherTaskId: 401, relationKind: "blocking" })).resolves.toMatchObject({
    id: 400,
    index: 99,
  });
  expect(fake.requests).toHaveLength(3);
  expect(fake.requests[1]).toMatchObject({
    method: "DELETE",
    path: "/api/v1/tasks/400/relations/blocking/401",
    body: { task_id: 400, other_task_id: 401, relation_kind: "blocking" },
  });
});

test("unrelate refuses a reversed relation kind without issuing DELETE", async () => {
  const fake = fakeServer(() => Response.json({
    id: 400,
    title: "base",
    done: false,
    related_tasks: { blocked: [{ id: 401, title: "blocker" }] },
  }));
  const { client } = await clientFor(fake.url);
  await expect(client.unrelate({ taskId: 400, otherTaskId: 401, relationKind: "blocking" }))
    .rejects.toThrow("task 400 has no blocking relation to task 401");
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests.some(({ method }) => method === "DELETE")).toBe(false);
});

test("dependency graph fetches one batch per generation and prunes cycles", async () => {
  const tasks = new Map<number, JsonBody>([
    [400, { id: 400, index: 99, identifier: "OPS-99", project_id: 13, title: "root", done: false, related_tasks: { blocking: [{ id: 401, index: 100, identifier: "OPS-100", project_id: 13, title: "middle", done: false }] } }],
    [401, { id: 401, index: 100, identifier: "OPS-100", project_id: 13, title: "middle", done: false, related_tasks: { blocked: [{ id: 400, title: "root" }], blocking: [{ id: 402, index: 101, identifier: "OPS-101", project_id: 13, title: "leaf", done: false }] } }],
    [402, { id: 402, index: 101, identifier: "OPS-101", project_id: 13, title: "leaf", done: false, related_tasks: { blocked: [{ id: 401, title: "middle" }], blocking: [{ id: 400, title: "root" }] } }],
  ]);
  const filters: string[] = [];
  const fake = fakeServer((request) => {
    const filter = request.query.get("filter") ?? "";
    filters.push(filter);
    const ids = filter.replace("id in ", "").split(",").map((id) => Number(id.trim()));
    return Response.json(ids.map((id) => tasks.get(id)).filter(Boolean));
  });
  const { client } = await clientFor(fake.url);
  const graph = await client.graph({ taskId: 400, relationKinds: ["blocked"] });
  expect(filters).toEqual(["id in 400", "id in 401", "id in 402"]);
  expect(graph).toMatchObject({
    rootTaskId: 400,
    relationKinds: ["blocking", "blocked"],
    maxDepthReached: 2,
    truncated: false,
    nodes: [{ id: 400 }, { id: 401 }, { id: 402 }],
    edges: [
      { from: 400, to: 401, kind: "blocking" },
      { from: 401, to: 402, kind: "blocking" },
      { from: 402, to: 400, kind: "blocking" },
    ],
    unresolvedTaskIds: [],
  });
});

test("dependency graph reports a max-depth boundary without adding deeper nodes", async () => {
  const fake = fakeServer((request) => {
    const filter = request.query.get("filter");
    if (filter === "id in 400") {
      return Response.json([{ id: 400, title: "root", done: false, related_tasks: { blocking: [{ id: 401, title: "middle", done: false }] } }]);
    }
    if (filter === "id in 401") {
      return Response.json([{ id: 401, title: "middle", done: false, related_tasks: { blocked: [{ id: 400, title: "root" }], blocking: [{ id: 402, title: "too deep" }] } }]);
    }
    return new Response("unexpected", { status: 500 });
  });
  const { client } = await clientFor(fake.url);
  await expect(client.graph({ taskId: 400, maxDepth: 1 })).resolves.toMatchObject({
    maxDepthReached: 1,
    truncated: true,
    truncationReason: "maxDepth",
    nodes: [{ id: 400 }, { id: 401 }],
    edges: [{ from: 400, to: 401, kind: "blocking" }],
  });
  expect(fake.requests).toHaveLength(2);
});

test("graph expands the all shorthand to every relation kind", async () => {
  const fake = fakeServer(() => Response.json([{ id: 400, title: "root", done: false, related_tasks: {} }]));
  const { client } = await clientFor(fake.url);
  await expect(client.graph({ taskId: 400, relationKinds: "all", maxDepth: 0 })).resolves.toMatchObject({
    relationKinds: [...RELATION_KINDS],
  });
});

test("HTTP errors are actionable and do not disclose the bearer token", async () => {
  const fake = fakeServer(() => new Response("denied", { status: 403, statusText: "Forbidden" }));
  const { client } = await clientFor(fake.url);
  await expect(client.comments(1)).rejects.toThrow("Vikunja API request failed: 403 Forbidden");
  await expect(client.comments(1)).rejects.not.toThrow("secret");
});

/** Serves `total` synthetic tasks, clamping per_page the way a Vikunja server does. */
function pagedTaskServer(total: number, serverMaxPerPage = 50) {
  return fakeServer((request) => {
    if (request.path !== "/api/v1/tasks") return new Response("unexpected", { status: 500 });
    const size = Math.min(Number(request.query.get("per_page")), serverMaxPerPage);
    const page = Number(request.query.get("page"));
    const start = (page - 1) * size;
    const items = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, index) => ({
      id: start + index + 1,
      title: `task ${start + index + 1}`,
      done: false,
    }));
    return Response.json(items, { headers: { "x-pagination-total-pages": String(Math.max(1, Math.ceil(total / size))) } });
  });
}

test("list walks every page until the result set is exhausted", async () => {
  const fake = pagedTaskServer(120);
  const { client, config } = await clientFor(fake.url);
  const listed = await client.list(config, {}) as { tasks: Array<{ id: number }>; count: number; truncated: boolean };
  expect(listed.count).toBe(120);
  expect(listed.truncated).toBe(false);
  expect(listed.tasks.at(-1)).toMatchObject({ id: 120 });
  expect(fake.requests.map((request) => request.query.get("page"))).toEqual(["1", "2", "3"]);
  expect(fake.requests.every((request) => request.query.get("per_page") === "50")).toBe(true);
});

test("list stops at the limit and reports truncation instead of dropping results silently", async () => {
  const fake = pagedTaskServer(500);
  const { client, config } = await clientFor(fake.url);
  await expect(client.list(config, { limit: 60 })).resolves.toMatchObject({ count: 60, truncated: true, limit: 60 });
  expect(fake.requests).toHaveLength(2);
});

test("limit rejects values outside the supported range", async () => {
  const fake = pagedTaskServer(1);
  const { client, config } = await clientFor(fake.url);
  await expect(client.list(config, { limit: 501 })).rejects.toThrow("limit must be an integer between 1 and 500");
});

test("graph task batches page past the server per-page cap", async () => {
  const childIds = Array.from({ length: 59 }, (_, index) => 500 + index);
  const tasks = new Map<number, JsonBody>([
    [400, { id: 400, title: "root", done: false, related_tasks: { blocking: childIds.map((id) => ({ id, title: `child ${id}`, done: false })) } }],
    ...childIds.map((id): [number, JsonBody] => [id, { id, title: `child ${id}`, done: false }]),
  ]);
  const fake = fakeServer((request) => {
    if (request.path !== "/api/v1/tasks") return new Response("unexpected", { status: 500 });
    const requested = [...(request.query.get("filter") ?? "").matchAll(/\d+/g)].map((match) => Number(match[0]));
    const size = Math.min(Number(request.query.get("per_page")), 50);
    const page = Number(request.query.get("page"));
    const items = requested.slice((page - 1) * size, page * size).map((id) => tasks.get(id)).filter(Boolean);
    return Response.json(items, { headers: { "x-pagination-total-pages": String(Math.max(1, Math.ceil(requested.length / size))) } });
  });
  const { client } = await clientFor(fake.url);
  const graph = await client.graph({ taskId: 400, maxDepth: 1 }) as { nodes: unknown[]; unresolvedTaskIds: number[] };
  expect(graph.nodes).toHaveLength(60);
  expect(graph.unresolvedTaskIds).toEqual([]);
});

test("comments paginate and report their limit", async () => {
  const fake = fakeServer((request) => {
    const page = Number(request.query.get("page"));
    const items = page === 1
      ? Array.from({ length: 50 }, (_, index) => ({ id: index + 1, comment: `<p>note ${index + 1}</p>` }))
      : [{ id: 51, comment: "<p>note 51</p>" }];
    return Response.json(items, { headers: { "x-pagination-total-pages": "2" } });
  });
  const { client } = await clientFor(fake.url);
  const listed = await client.comments(9) as { comments: Array<{ id: number; comment: string }>; count: number; truncated: boolean };
  expect(listed.count).toBe(51);
  expect(listed.truncated).toBe(false);
  expect(listed.comments.at(-1)).toEqual({ id: 51, comment: "note 51" });
});
