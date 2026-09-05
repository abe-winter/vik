import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RELATION_KINDS, VikunjaClient, limits, type RelationKind, type RelationKindsInput, type TaskState } from "./vikunja";

type ReadInput = {
  action: "list" | "show" | "comments" | "attachments" | "graph";
  projectId?: number;
  taskId?: number;
  state?: TaskState;
  filter?: string;
  search?: string;
  sortBy?: string;
  orderBy?: "asc" | "desc";
  perPage?: number;
  mine?: boolean;
  includeComments?: boolean;
  relationKinds?: RelationKindsInput;
  maxDepth?: number;
  maxNodes?: number;
};

type WriteInput = {
  action: "create" | "modify" | "comment" | "assign" | "attach" | "relate" | "unrelate";
  projectId?: number;
  taskId?: number;
  title?: string;
  description?: string;
  state?: TaskState;
  priority?: number;
  dueDate?: string;
  percentDone?: number;
  text?: string;
  mine?: boolean;
  assigneeId?: number;
  assigneeUsername?: string;
  files?: string[];
  embed?: boolean;
  otherTaskId?: number;
  relationKind?: RelationKind;
};

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { action: "vikunja" } };
}

function requiredTaskId(input: { taskId?: number }): number {
  if (input.taskId === undefined) throw new Error("taskId is required for this action");
  return input.taskId;
}

function requiredRelation(input: { otherTaskId?: number; relationKind?: RelationKind }): {
  otherTaskId: number;
  relationKind: RelationKind;
} {
  if (input.otherTaskId === undefined) throw new Error("otherTaskId is required for relation actions");
  if (input.relationKind === undefined) throw new Error("relationKind is required for relation actions");
  return { otherTaskId: input.otherTaskId, relationKind: input.relationKind };
}

export default function vikExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  const projectId = z.number().int().positive().optional().describe("Numeric Vikunja project id; otherwise uses numeric project: from config.");
  const taskId = z.number().int().positive().optional().describe("Numeric Vikunja task id.");
  const state = z.enum(["todo", "doing", "done"]).optional();

  pi.registerTool({
    name: "vik_read",
    label: "Vikunja Read",
    description: "List or show Vikunja tasks, comments, attachments, and bounded dependency graphs. Uses VIKUNJA_TOKEN and discovered Vikunja config.",
    approval: "read",
    strict: true,
    parameters: z.object({
      action: z.enum(["list", "show", "comments", "attachments", "graph"]),
      projectId,
      taskId,
      state,
      filter: z.string().max(512).optional().describe("Vikunja filter expression, ANDed with the project filter."),
      search: z.string().max(512).optional(),
      sortBy: z.string().max(64).optional(),
      orderBy: z.enum(["asc", "desc"]).optional(),
      perPage: z.number().int().min(1).max(limits.MAX_PER_PAGE).optional(),
      mine: z.boolean().optional().describe("Limit list results to the configured username."),
      includeComments: z.boolean().optional().describe("With show, also return the task's comments."),
      relationKinds: z.union([
        z.literal("all"),
        z.array(z.enum(RELATION_KINDS)).min(1).max(RELATION_KINDS.length),
      ]).optional().describe("Relation families to traverse; inverse kinds are included automatically. Pass 'all' for every kind; defaults to blocking."),
      maxDepth: z.number().int().min(0).max(limits.MAX_GRAPH_DEPTH).optional().describe("Maximum edge depth from the root; defaults to 10."),
      maxNodes: z.number().int().min(1).max(limits.MAX_GRAPH_NODES).optional().describe("Maximum nodes returned; defaults to 100."),
    }),
    async execute(_id, input: ReadInput, signal, _onUpdate, ctx) {
      const { client, config } = await VikunjaClient.create({ cwd: ctx.cwd });
      switch (input.action) {
        case "list":
          return result(await client.list(config, input, signal));
        case "show":
          return result(await client.show(requiredTaskId(input), input.includeComments === true, signal));
        case "comments":
          return result(await client.comments(requiredTaskId(input), signal));
        case "attachments":
          return result(await client.attachments(requiredTaskId(input), signal));
        case "graph":
          return result(await client.graph({
            taskId: requiredTaskId(input),
            relationKinds: input.relationKinds,
            maxDepth: input.maxDepth,
            maxNodes: input.maxNodes,
          }, signal));
      }
    },
  });

  pi.registerTool({
    name: "vik_write",
    label: "Vikunja Write",
    description: "Create, modify, assign, or relate Vikunja tasks; add comments or upload attachments. Uses VIKUNJA_TOKEN and discovered Vikunja config.",
    approval: "write",
    strict: true,
    parameters: z.object({
      action: z.enum(["create", "modify", "comment", "assign", "attach", "relate", "unrelate"]),
      projectId,
      taskId,
      title: z.string().min(1).max(512).optional(),
      description: z.string().max(20_000).optional().describe("Markdown task description."),
      state,
      priority: z.number().int().min(0).max(5).optional(),
      dueDate: z.string().max(64).optional().describe("RFC3339 due date."),
      percentDone: z.number().min(0).max(1).optional(),
      text: z.string().min(1).max(20_000).optional().describe("Markdown comment text."),
      mine: z.boolean().optional().describe("Assign the task to the configured user; user_id is preferred over username."),
      assigneeId: z.number().int().positive().optional().describe("Numeric user id to assign."),
      assigneeUsername: z.string().min(1).max(255).optional().describe("Exact username to resolve and assign; requires /users permission."),
      files: z.array(z.string().min(1).max(4_096)).min(1).max(20).optional().describe("Attachment paths relative to the OMP working directory."),
      embed: z.boolean().optional().describe("Append uploaded attachments as Markdown images in the task description."),
      otherTaskId: z.number().int().positive().optional().describe("Global id of the other task in a relation."),
      relationKind: z.enum(RELATION_KINDS).optional().describe("Describes taskId relative to otherTaskId; for example, blocking means taskId blocks otherTaskId."),
    }),
    async execute(_id, input: WriteInput, signal, _onUpdate, ctx) {
      const { client, config } = await VikunjaClient.create({ cwd: ctx.cwd });
      switch (input.action) {
        case "create": {
          const title = input.title;
          if (!title) throw new Error("title is required to create a task");
          return result(await client.create(config, { ...input, title }, signal));
        }
        case "modify":
          return result(await client.modify({ ...input, taskId: requiredTaskId(input) }, signal));
        case "comment":
          if (!input.text) throw new Error("text is required to add a comment");
          return result(await client.comment({ taskId: requiredTaskId(input), text: input.text }, signal));
        case "assign":
          return result(await client.assign(config, { ...input, taskId: requiredTaskId(input) }, signal));
        case "attach":
          if (!input.files?.length) throw new Error("files is required to attach files");
          return result(await client.attach({ taskId: requiredTaskId(input), files: input.files, embed: input.embed }, ctx.cwd, signal));
        case "relate":
          return result(await client.relate({ taskId: requiredTaskId(input), ...requiredRelation(input) }, signal));
        case "unrelate":
          return result(await client.unrelate({ taskId: requiredTaskId(input), ...requiredRelation(input) }, signal));
      }
    },
  });
}
