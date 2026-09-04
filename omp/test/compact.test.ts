import { expect, test } from "bun:test";
import { compactTask, compactTasks } from "../src/vikunja";

test("compactTask matches the Rust high-signal field set", () => {
  expect(compactTask({
    assignees: [{ id: 1, username: "awinter" }],
    attachments: null,
    bucket_id: 0,
    description: "<p>(user does this manually)</p>",
    done: false,
    due_date: "0001-01-01T00:00:00Z",
    id: 4,
    index: 99,
    priority: 0,
    related_tasks: {},
    title: "decide initial test layout",
  })).toEqual({
    id: 4,
    index: 99,
    title: "decide initial test layout",
    done: false,
    description: "(user does this manually)",
    assignees: ["awinter"],
  });
});

test("compactTask retains priority, attachments, and related task identity", () => {
  expect(compactTask({
    id: 7,
    title: "build",
    done: true,
    priority: 4,
    attachments: [{ id: 9, file: { name: "diagram.png", size: 70 } }],
    related_tasks: { blocking: [{ id: 8, title: "ship", description: "ignored" }] },
  })).toEqual({
    id: 7,
    title: "build",
    done: true,
    priority: 4,
    attachments: [{ id: 9, name: "diagram.png" }],
    related_tasks: { blocking: [{ id: 8, title: "ship" }] },
  });
});

test("compactTasks compacts every task in a list", () => {
  expect(compactTasks([{ id: 1, title: "one", done: false }, { id: 2, title: "two", done: true }])).toEqual([
    { id: 1, title: "one", done: false },
    { id: 2, title: "two", done: true },
  ]);
});
