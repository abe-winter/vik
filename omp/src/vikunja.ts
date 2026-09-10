import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { marked } from "marked";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { parse } from "yaml";

export type TaskState = "todo" | "doing" | "done";

export const RELATION_KINDS = [
  "subtask",
  "parenttask",
  "related",
  "duplicateof",
  "duplicates",
  "blocking",
  "blocked",
  "precedes",
  "follows",
  "copiedfrom",
  "copiedto",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export type RelationKindsInput = RelationKind[] | "all";

const INVERSE_RELATION_KIND: Record<RelationKind, RelationKind> = {
  subtask: "parenttask",
  parenttask: "subtask",
  related: "related",
  duplicateof: "duplicates",
  duplicates: "duplicateof",
  blocking: "blocked",
  blocked: "blocking",
  precedes: "follows",
  follows: "precedes",
  copiedfrom: "copiedto",
  copiedto: "copiedfrom",
};

function normalizeRelationKinds(input: RelationKindsInput | undefined): RelationKind[] {
  if (input === "all") return [...RELATION_KINDS];
  const requested = input ?? ["blocking"];
  if (requested.length === 0 || requested.some((kind) => !RELATION_KINDS.includes(kind))) {
    throw new Error("relationKinds must be 'all' or contain supported Vikunja relation kinds");
  }
  const normalized = new Set<RelationKind>();
  for (const kind of requested) {
    normalized.add(kind);
    normalized.add(INVERSE_RELATION_KIND[kind]);
  }
  return RELATION_KINDS.filter((kind) => normalized.has(kind));
}

export interface VikunjaConfig {
  server?: string;
  project?: string | number;
  username?: string;
  userId?: number;
}

export interface VikunjaClientOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => Promise<string>;
  fetch?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

const PAGE_SIZE = 50;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_PAGES = 50;
const DEFAULT_GRAPH_DEPTH = 10;
const DEFAULT_GRAPH_NODES = 100;
const MAX_GRAPH_DEPTH = 20;
const MAX_GRAPH_NODES = 100;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type PagedResult = { items: unknown[]; truncated: boolean; limit: number };

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function totalPagesHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function paged(result: PagedResult, key: string, items: unknown): JsonObject {
  return { [key]: items, count: result.items.length, truncated: result.truncated, limit: result.limit };
}

type GraphEdge = { from: number; to: number; kind: RelationKind };

function normalizeRelationEdge(from: number, to: number, kind: RelationKind): GraphEdge {
  switch (kind) {
    case "parenttask": return { from: to, to: from, kind: "subtask" };
    case "duplicates": return { from: to, to: from, kind: "duplicateof" };
    case "blocked": return { from: to, to: from, kind: "blocking" };
    case "follows": return { from: to, to: from, kind: "precedes" };
    case "copiedto": return { from: to, to: from, kind: "copiedfrom" };
    case "related": return from <= to
      ? { from, to, kind }
      : { from: to, to: from, kind };
    default: return { from, to, kind };
  }
}

function compactGraphNode(value: unknown): JsonObject {
  const task = asObject(value) ?? {};
  const node: JsonObject = {};
  for (const field of ["id", "index", "identifier", "project_id", "title", "done", "priority"] as const) {
    if (field in task) node[field] = task[field];
  }
  return node;
}

export function normalizeServer(server: string): string {
  const withScheme = server.includes("://") ? server : `https://${server}`;
  const stripped = withScheme.replace(/\/+$/, "").replace(/(?:\/api\/v1)+$/, "");
  return `${stripped}/api/v1`;
}

export async function loadConfig(options: Pick<VikunjaClientOptions, "cwd" | "env" | "readFile">): Promise<VikunjaConfig> {
  const readFile = options.readFile ?? ((path: string) => Bun.file(path).text());
  const home = options.env?.HOME ?? process.env.HOME;
  const paths = [
    `${options.cwd}/.vikunja.yaml`,
    `${options.cwd}/vikunja.yaml`,
    ...(home ? [`${home}/.vikunja.yaml`, `${home}/vikunja.yaml`] : []),
  ];

  for (const path of paths) {
    try {
      const parsed = parse(await readFile(path));
      const config = asObject(parsed);
      if (!config) throw new Error("configuration must be a YAML object");
      const configuredUserId = numberField(config.user_id);
      return {
        server: stringField(config.server),
        project: typeof config.project === "string" || typeof config.project === "number" ? config.project : undefined,
        username: stringField(config.username),
        userId: configuredUserId !== undefined && Number.isInteger(configuredUserId) && configuredUserId > 0
          ? configuredUserId
          : undefined,
      };
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) continue;
      throw new Error(`unable to read Vikunja config ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {};
}

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { gfm: true, breaks: false }) as string;
}

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  headingStyle: "atx",
});
turndown.use(gfm);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trimEnd();
}


export function compactTask(value: unknown): JsonObject {
  const task = asObject(value);
  if (!task) return {};
  const compact: JsonObject = {};
  for (const field of ["id", "index", "title", "done"] as const) {
    if (field in task) compact[field] = task[field];
  }
  if (numberField(task.priority) !== undefined && task.priority !== 0) compact.priority = task.priority;
  if (stringField(task.description)) compact.description = htmlToMarkdown(task.description as string);

  const assignees = Array.isArray(task.assignees)
    ? task.assignees.map(asObject).map((user) => user && stringField(user.username)).filter((name): name is string => Boolean(name))
    : [];
  if (assignees.length) compact.assignees = assignees;

  const attachments = Array.isArray(task.attachments)
    ? task.attachments.map(asObject).filter((attachment): attachment is JsonObject => Boolean(attachment)).map((attachment) => ({
        id: attachment.id,
        name: stringField(asObject(attachment.file)?.name),
      }))
    : [];
  if (attachments.length) compact.attachments = attachments;

  const related = asObject(task.related_tasks);
  if (related) {
    const compactRelated: JsonObject = {};
    for (const [kind, tasks] of Object.entries(related)) {
      if (!Array.isArray(tasks) || tasks.length === 0) continue;
      compactRelated[kind] = tasks
        .map(asObject)
        .filter((relatedTask): relatedTask is JsonObject => Boolean(relatedTask))
        .map((relatedTask) => {
          const item: JsonObject = {};
          for (const field of ["id", "index", "identifier", "project_id", "title", "done"] as const) {
            if (field in relatedTask) item[field] = relatedTask[field];
          }
          return item;
        });
    }
    if (Object.keys(compactRelated).length) compact.related_tasks = compactRelated;
  }
  return compact;
}

export function compactTasks(value: unknown): unknown {
  return Array.isArray(value) ? value.map(compactTask) : compactTask(value);
}

export function compactComments(value: unknown): unknown {
  const compact = (comment: unknown): JsonObject => {
    const source = asObject(comment) ?? {};
    const result: JsonObject = {};
    for (const field of ["id", "created", "updated"] as const) if (field in source) result[field] = source[field];
    const author = asObject(source.author);
    if (author && stringField(author.username)) result.author = author.username;
    if (stringField(source.comment)) result.comment = htmlToMarkdown(source.comment as string);
    return result;
  };
  return Array.isArray(value) ? value.map(compact) : compact(value);
}

export function compactAttachments(value: unknown): unknown {
  const compact = (attachment: unknown): JsonObject => {
    const source = asObject(attachment) ?? {};
    const result: JsonObject = {};
    for (const field of ["id", "task_id", "created"] as const) {
      if (field in source) result[field] = source[field];
    }
    const file = asObject(source.file);
    if (file) {
      const compactFile: JsonObject = {};
      for (const field of ["id", "name", "mime", "size"] as const) {
        if (field in file) compactFile[field] = file[field];
      }
      if (Object.keys(compactFile).length) result.file = compactFile;
    }
    const creator = asObject(source.created_by);
    if (creator && stringField(creator.username)) result.created_by = creator.username;
    return result;
  };
  return Array.isArray(value) ? value.map(compact) : compact(value);
}

function uploadedAttachments(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const response = asObject(value);
  const items = response?.success ?? response?.attachments;
  if (Array.isArray(items)) return items;
  throw new Error("Vikunja attachment upload returned an unexpected response");
}

export class VikunjaClient {
  private constructor(private readonly baseUrl: string, private readonly token: string, private readonly http: typeof fetch) {}

  static async create(options: VikunjaClientOptions): Promise<{ client: VikunjaClient; config: VikunjaConfig }> {
    const env = options.env ?? process.env;
    const config = await loadConfig({ cwd: options.cwd, env, readFile: options.readFile });
    if (!config.server) throw new Error("no Vikunja server: set server: in a discovered config file");
    const token = env.VIKUNJA_TOKEN;
    if (!token) throw new Error("no Vikunja token: set VIKUNJA_TOKEN in the environment");
    return { client: new VikunjaClient(normalizeServer(config.server), token, options.fetch ?? fetch), config };
  }

  private async send(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined>; jsonBody?: boolean } = {},
  ): Promise<{ data: unknown; headers: Headers }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const response = await this.http(url, {
      method: init.method,
      body: init.body,
      signal: init.signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body && init.jsonBody !== false ? { "Content-Type": "application/json" } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim();
      throw new Error(`Vikunja API request failed: ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 4_096)}` : ""}`);
    }
    if (!text.trim()) return { data: null, headers: response.headers };
    try { return { data: JSON.parse(text), headers: response.headers }; }
    catch { throw new Error("Vikunja API returned malformed JSON"); }
  }

  private async request(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined>; jsonBody?: boolean } = {},
  ): Promise<unknown> {
    return (await this.send(path, init)).data;
  }

  /** Walks Vikunja's paginated list endpoints until exhausted, the limit is hit, or MAX_PAGES pages are read. */
  private async requestAll(
    path: string,
    init: { label: string; query?: Record<string, string | undefined>; signal?: AbortSignal; limit?: number },
  ): Promise<PagedResult> {
    const limit = resolveLimit(init.limit);
    const perPage = Math.min(PAGE_SIZE, limit);
    const items: unknown[] = [];
    let truncated = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { data, headers } = await this.send(path, {
        signal: init.signal,
        query: { ...init.query, page: String(page), per_page: String(perPage) },
      });
      if (!Array.isArray(data)) throw new Error(`Vikunja API returned a non-array ${init.label}`);
      items.push(...data);

      const totalPages = totalPagesHeader(headers.get("x-pagination-total-pages"));
      // Without the header, a full page is the only evidence that more may follow.
      const morePages = totalPages !== undefined ? page < totalPages : data.length >= perPage && data.length > 0;
      if (items.length >= limit) {
        truncated = morePages || items.length > limit;
        items.length = limit;
        break;
      }
      if (!morePages) break;
      if (page === MAX_PAGES) truncated = true;
    }
    return { items, truncated, limit };
  }

  private projectId(config: VikunjaConfig, projectId?: number): number {
    const candidate = projectId ?? config.project;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
    if (typeof candidate === "string" && /^\d+$/.test(candidate) && Number(candidate) > 0) return Number(candidate);
    throw new Error("no numeric project: pass projectId or set numeric project: in the config file");
  }

  private async tasksByIds(taskIds: number[], signal?: AbortSignal): Promise<JsonObject[]> {
    const batch = await this.requestAll("/tasks", {
      signal,
      label: "task batch",
      limit: taskIds.length,
      query: { filter: `id in ${taskIds.join(", ")}` },
    });
    return batch.items.map(asObject).filter((task): task is JsonObject => Boolean(task));
  }

  private async resolveUser(username: string, signal?: AbortSignal): Promise<number> {
    const users = await this.request("/users", { signal, query: { s: username } });
    if (!Array.isArray(users)) throw new Error("Vikunja API returned a non-array user search result");
    for (const candidate of users) {
      const user = asObject(candidate);
      if (user?.username === username && Number.isInteger(user.id) && Number(user.id) > 0) {
        return Number(user.id);
      }
    }
    throw new Error(`no user matching '${username}'`);
  }

  private async assertProjectAccessible(projectId: number, signal?: AbortSignal): Promise<void> {
    try { await this.request(`/projects/${projectId}`, { signal }); }
    catch (error) {
      if (error instanceof Error && /Vikunja API request failed: (403|404)\b/.test(error.message)) {
        throw new Error(`no access to project ${projectId} (it may not exist, or your token lacks permission)`);
      }
      throw error;
    }
  }

  async list(config: VikunjaConfig, input: { projectId?: number; state?: TaskState; filter?: string; search?: string; sortBy?: string; orderBy?: "asc" | "desc"; limit?: number; mine?: boolean }, signal?: AbortSignal): Promise<unknown> {
    const projectId = this.projectId(config, input.projectId);
    const clauses = [`project_id = ${projectId}`];
    if (input.state === "todo") clauses.push("done = false && percent_done = 0");
    if (input.state === "doing") clauses.push("done = false && percent_done > 0");
    if (input.state === "done") clauses.push("done = true");
    if (input.mine) {
      if (!config.username || !/^[A-Za-z0-9_.-]+$/.test(config.username)) throw new Error("mine requires a clean username: in the config file");
      clauses.push(`assignees in ${config.username}`);
    }
    if (input.filter) clauses.push(`(${input.filter})`);
    const tasks = await this.requestAll("/tasks", {
      signal,
      label: "task list",
      limit: input.limit,
      query: { filter: clauses.join(" && "), s: input.search, sort_by: input.sortBy, order_by: input.orderBy },
    });
    if (tasks.items.length === 0) await this.assertProjectAccessible(projectId, signal);
    return paged(tasks, "tasks", compactTasks(tasks.items));
  }

  async graph(
    input: { taskId: number; relationKinds?: RelationKindsInput; maxDepth?: number; maxNodes?: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const relationKinds = normalizeRelationKinds(input.relationKinds);
    const maxDepth = input.maxDepth ?? DEFAULT_GRAPH_DEPTH;
    const maxNodes = input.maxNodes ?? DEFAULT_GRAPH_NODES;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_GRAPH_DEPTH) {
      throw new Error(`maxDepth must be an integer between 0 and ${MAX_GRAPH_DEPTH}`);
    }
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_GRAPH_NODES) {
      throw new Error(`maxNodes must be an integer between 1 and ${MAX_GRAPH_NODES}`);
    }

    const requestedKinds = new Set<RelationKind>(relationKinds);
    const nodes = new Map<number, JsonObject>();
    const edges = new Map<string, GraphEdge>();
    const visited = new Set<number>();
    const unresolved = new Set<number>();
    const truncationReasons = new Set<"maxDepth" | "maxNodes">();
    let frontier = [input.taskId];
    let maxDepthReached = 0;

    for (let depth = 0; frontier.length > 0; depth += 1) {
      const current = [...new Set(frontier)].filter((taskId) => !visited.has(taskId));
      if (current.length === 0) break;
      current.forEach((taskId) => visited.add(taskId));
      const tasks = await this.tasksByIds(current, signal);
      const returned = new Set<number>();
      const next = new Set<number>();

      for (const task of tasks) {
        const taskId = numberField(task.id);
        if (taskId === undefined) continue;
        returned.add(taskId);
        nodes.set(taskId, compactGraphNode(task));
        maxDepthReached = Math.max(maxDepthReached, depth);

        const related = asObject(task.related_tasks);
        if (!related) continue;
        for (const [kind, candidates] of Object.entries(related)) {
          if (!requestedKinds.has(kind as RelationKind) || !Array.isArray(candidates)) continue;
          for (const candidate of candidates) {
            const relatedTask = asObject(candidate);
            const otherTaskId = numberField(relatedTask?.id);
            if (otherTaskId === undefined) continue;

            if (depth >= maxDepth && !nodes.has(otherTaskId)) {
              truncationReasons.add("maxDepth");
              continue;
            }
            if (!nodes.has(otherTaskId)) {
              if (nodes.size >= maxNodes) {
                truncationReasons.add("maxNodes");
                continue;
              }
              nodes.set(otherTaskId, compactGraphNode(relatedTask));
            }

            const edge = normalizeRelationEdge(taskId, otherTaskId, kind as RelationKind);
            edges.set(`${edge.kind}:${edge.from}:${edge.to}`, edge);
            if (depth < maxDepth && !visited.has(otherTaskId)) next.add(otherTaskId);
          }
        }
      }

      for (const taskId of current) {
        if (!returned.has(taskId)) unresolved.add(taskId);
      }
      if (depth >= maxDepth) break;
      frontier = [...next];
    }

    if (!nodes.has(input.taskId)) throw new Error(`task ${input.taskId} was not returned by Vikunja`);
    const reasons = [...truncationReasons].sort();
    return {
      rootTaskId: input.taskId,
      relationKinds,
      maxDepth,
      maxNodes,
      maxDepthReached,
      truncated: reasons.length > 0,
      ...(reasons.length ? { truncationReason: reasons.join(",") } : {}),
      nodes: [...nodes.entries()].sort(([left], [right]) => left - right).map(([, node]) => node),
      edges: [...edges.values()].sort((left, right) => left.from - right.from || left.to - right.to || left.kind.localeCompare(right.kind)),
      unresolvedTaskIds: [...unresolved].sort((left, right) => left - right),
    };
  }

  async show(taskId: number, options: { includeComments?: boolean; limit?: number } = {}, signal?: AbortSignal): Promise<unknown> {
    const task = asObject(await this.request(`/tasks/${taskId}`, { signal }));
    if (!task) throw new Error(`task ${taskId} response is not a JSON object`);
    const compact = compactTask(task);
    if (options.includeComments) {
      const comments = await this.requestAll(`/tasks/${taskId}/comments`, { signal, label: "comment list", limit: options.limit });
      compact.comments = compactComments(comments.items);
      if (comments.truncated) compact.commentsTruncated = true;
    }
    return compact;
  }

  async comments(taskId: number, options: { limit?: number } = {}, signal?: AbortSignal): Promise<unknown> {
    const comments = await this.requestAll(`/tasks/${taskId}/comments`, { signal, label: "comment list", limit: options.limit });
    return paged(comments, "comments", compactComments(comments.items));
  }

  async attachments(taskId: number, options: { limit?: number } = {}, signal?: AbortSignal): Promise<unknown> {
    const attachments = await this.requestAll(`/tasks/${taskId}/attachments`, { signal, label: "attachment list", limit: options.limit });
    return paged(attachments, "attachments", compactAttachments(attachments.items));
  }

  async assign(
    config: VikunjaConfig,
    input: { taskId: number; mine?: boolean; assigneeId?: number; assigneeUsername?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const choices = Number(input.mine === true) + Number(input.assigneeId !== undefined) + Number(input.assigneeUsername !== undefined);
    if (choices !== 1) throw new Error("assignment requires exactly one of mine, assigneeId, or assigneeUsername");

    let userId: number;
    if (input.mine) {
      if (config.userId !== undefined) {
        userId = config.userId;
      } else if (config.username) {
        userId = await this.resolveUser(config.username, signal);
      } else {
        throw new Error("mine requires user_id or username in the config file");
      }
    } else if (input.assigneeId !== undefined) {
      userId = input.assigneeId;
    } else if (input.assigneeUsername) {
      userId = await this.resolveUser(input.assigneeUsername, signal);
    } else {
      throw new Error("assignment requires an assignee");
    }

    try {
      await this.request(`/tasks/${input.taskId}/assignees`, {
        method: "PUT",
        body: JSON.stringify({ user_id: userId }),
        signal,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("4021")) throw error;
    }
    return this.show(input.taskId, {}, signal);
  }

  async relate(
    input: { taskId: number; otherTaskId: number; relationKind: RelationKind },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (input.taskId === input.otherTaskId) throw new Error("a task cannot be related to itself");
    await this.request(`/tasks/${input.taskId}/relations`, {
      method: "PUT",
      body: JSON.stringify({ other_task_id: input.otherTaskId, relation_kind: input.relationKind }),
      signal,
    });
    return this.show(input.taskId, {}, signal);
  }

  async unrelate(
    input: { taskId: number; otherTaskId: number; relationKind: RelationKind },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const task = asObject(await this.request(`/tasks/${input.taskId}`, { signal }));
    if (!task) throw new Error(`task ${input.taskId} response is not a JSON object`);
    const relations = asObject(task.related_tasks);
    const candidates = relations?.[input.relationKind];
    const exists = Array.isArray(candidates) && candidates.some((candidate) => {
      const relatedTask = asObject(candidate);
      return numberField(relatedTask?.id) === input.otherTaskId;
    });
    if (!exists) {
      throw new Error(`task ${input.taskId} has no ${input.relationKind} relation to task ${input.otherTaskId}`);
    }

    await this.request(`/tasks/${input.taskId}/relations/${input.relationKind}/${input.otherTaskId}`, {
      method: "DELETE",
      body: JSON.stringify({
        task_id: input.taskId,
        other_task_id: input.otherTaskId,
        relation_kind: input.relationKind,
      }),
      signal,
    });
    return this.show(input.taskId, {}, signal);
  }

  async create(config: VikunjaConfig, input: { projectId?: number; title: string; description?: string; priority?: number; dueDate?: string; percentDone?: number }, signal?: AbortSignal): Promise<unknown> {
    const body: JsonObject = { title: input.title };
    if (input.description !== undefined) body.description = markdownToHtml(input.description);
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.dueDate !== undefined) body.due_date = input.dueDate;
    if (input.percentDone !== undefined) body.percent_done = input.percentDone;
    return compactTask(await this.request(`/projects/${this.projectId(config, input.projectId)}/tasks`, { method: "PUT", body: JSON.stringify(body), signal }));
  }

  async modify(input: { taskId: number; title?: string; description?: string; state?: TaskState; priority?: number; dueDate?: string; percentDone?: number }, signal?: AbortSignal): Promise<unknown> {
    const overrides: JsonObject = {};
    if (input.title !== undefined) overrides.title = input.title;
    if (input.description !== undefined) overrides.description = markdownToHtml(input.description);
    if (input.priority !== undefined) overrides.priority = input.priority;
    if (input.dueDate !== undefined) overrides.due_date = input.dueDate;
    if (input.state !== undefined) {
      overrides.done = input.state === "done";
      overrides.percent_done = input.state === "todo" ? 0 : input.state === "doing" ? 0.5 : 1;
    }
    if (input.percentDone !== undefined) overrides.percent_done = input.percentDone;
    if (Object.keys(overrides).length === 0) throw new Error("nothing to modify: pass at least one field");
    const current = asObject(await this.request(`/tasks/${input.taskId}`, { signal }));
    if (!current) throw new Error(`task ${input.taskId} response is not a JSON object`);
    return compactTask(await this.request(`/tasks/${input.taskId}`, { method: "POST", body: JSON.stringify({ ...current, ...overrides }), signal }));
  }

  async comment(input: { taskId: number; text: string }, signal?: AbortSignal): Promise<unknown> {
    return compactComments(await this.request(`/tasks/${input.taskId}/comments`, { method: "PUT", body: JSON.stringify({ comment: markdownToHtml(input.text) }), signal }));
  }

  async attach(
    input: { taskId: number; files: string[]; embed?: boolean },
    cwd: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const form = new FormData();
    for (const requestedPath of input.files) {
      const path = resolve(cwd, requestedPath.startsWith("@") ? requestedPath.slice(1) : requestedPath);
      let metadata;
      try {
        metadata = await stat(path);
      } catch (error) {
        throw new Error(`unable to read attachment ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!metadata.isFile()) throw new Error(`attachment is not a file: ${requestedPath}`);
      form.append("files", Bun.file(path), basename(path));
    }

    const uploaded = await this.request(`/tasks/${input.taskId}/attachments`, {
      method: "PUT",
      body: form,
      jsonBody: false,
      signal,
    });
    const attachments = uploadedAttachments(uploaded);
    const compactUploaded = compactAttachments(attachments);
    if (!input.embed) return compactUploaded;

    const task = asObject(await this.request(`/tasks/${input.taskId}`, { signal }));
    if (!task) throw new Error(`task ${input.taskId} response is not a JSON object`);
    const description = stringField(task.description) ? htmlToMarkdown(task.description as string) : "";
    const embeds = attachments.map((attachment) => {
      const item = asObject(attachment);
      const attachmentId = numberField(item?.id);
      if (attachmentId === undefined) throw new Error("uploaded attachment is missing its id");
      const name = stringField(asObject(item?.file)?.name) ?? "attachment";
      const escapedName = name.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
      return `![${escapedName}](/api/v1/tasks/${input.taskId}/attachments/${attachmentId})`;
    });
    const markdown = [description, embeds.join("\n")].filter(Boolean).join("\n\n");
    const updated = await this.request(`/tasks/${input.taskId}`, {
      method: "POST",
      body: JSON.stringify({ ...task, description: markdownToHtml(markdown) }),
      signal,
    });
    return { attachments: compactUploaded, task: compactTask(updated) };
  }
}

export const limits = { PAGE_SIZE, DEFAULT_LIMIT, MAX_LIMIT, MAX_GRAPH_DEPTH, MAX_GRAPH_NODES };
