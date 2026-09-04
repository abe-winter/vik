import { expect, test } from "bun:test";
import { htmlToMarkdown, markdownToHtml } from "../src/vikunja";

const markdownFixture = `# Heading

- item
- [x] completed

| Name | Value |
| --- | --- |
| one | two |

[a link](https://example.test) and ![an image](https://example.test/image.png)

\`inline\`

\`\`\`ts
const value = 1;
\`\`\``;

test("Markdown input renders GFM constructs for Vikunja HTML", () => {
  const html = markdownToHtml(markdownFixture);
  expect(html).toContain("<h1>Heading</h1>");
  expect(html).toContain("<ul>");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("checked");
  expect(html).toContain("<table>");
  expect(html).toContain('<a href="https://example.test">a link</a>');
  expect(html).toContain('<img src="https://example.test/image.png" alt="an image">');
  expect(html).toContain("<code>inline</code>");
  expect(html).toContain("<pre><code class=\"language-ts\">");
});

test("Vikunja-style HTML normalizes to useful Markdown", () => {
  const html = `<h2>Plan</h2><p>Read <a href="https://example.test">the docs</a>.</p><ul><li>first</li><li>second</li></ul><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p><img src="/api/v1/tasks/1/attachments/2" alt="diagram"></p><pre><code class="language-ts">const x = 1;\n</code></pre>`;
  const markdown = htmlToMarkdown(html);
  expect(markdown).toContain("## Plan");
  expect(markdown).toContain("[the docs](https://example.test)");
  expect(markdown).toContain("-   first");
  expect(markdown).toContain("| A | B |");
  expect(markdown).toContain("![diagram](/api/v1/tasks/1/attachments/2)");
  expect(markdown).toContain("```ts");
  expect(markdown).toContain("const x = 1;");
});
