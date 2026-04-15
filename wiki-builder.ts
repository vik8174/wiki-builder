#!/usr/bin/env tsx
/**
 * Wiki Builder — transforms Notion articles into an organized wiki using Claude.
 *
 * Usage:
 *   npm run add -- <notion-url>   # fetch from Notion, save to raw/, compile
 *   npm run compile               # build wiki from raw/
 *   npm run query -- "question"   # ask a question against the wiki
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import type {
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import "dotenv/config";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_DIR = __dirname;
const RAW_DIR = path.join(BASE_DIR, "raw");
const WIKI_DIR = path.join(BASE_DIR, "wiki");
const SUMMARIES_DIR = path.join(WIKI_DIR, "summaries");
const CONCEPTS_DIR = path.join(WIKI_DIR, "concepts");
const INDEX_FILE = path.join(WIKI_DIR, "index.md");

const CONCEPT_INDEX_FILE = path.join(WIKI_DIR, "concept_index.json");

// ---------------------------------------------------------------------------
// Concept index helpers
// ---------------------------------------------------------------------------

/**
 * Tracks which articles map to which concepts, and stores content hashes
 * to detect changes and enable incremental synthesis.
 */
interface ConceptIndex {
  /** SHA256 of each summary file: article stem → hash */
  articleHashes: Record<string, string>;
  /** Concepts each article contributes to: article stem → concept slugs[] */
  articleConcepts: Record<string, string[]>;
  /** Articles belonging to each concept: concept slug → article stems[] */
  conceptArticles: Record<string, string[]>;
}

/** Returns SHA256 hex digest of a string. */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Loads concept_index.json or returns an empty index if not present. */
function loadConceptIndex(): ConceptIndex {
  if (fs.existsSync(CONCEPT_INDEX_FILE)) {
    return JSON.parse(fs.readFileSync(CONCEPT_INDEX_FILE, "utf-8")) as ConceptIndex;
  }
  return { articleHashes: {}, articleConcepts: {}, conceptArticles: {} };
}

/** Persists concept_index.json to disk. */
function saveConceptIndex(index: ConceptIndex): void {
  fs.writeFileSync(CONCEPT_INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the Notion page ID from a URL or plain ID string.
 *
 * @param url - Notion page URL or raw page ID
 * @returns 32-char hex page ID without hyphens
 */
function extractPageId(url: string): string {
  const match = url.match(
    /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i
  );
  if (!match) {
    console.error(`Error: could not extract a Notion page ID from: ${url}`);
    process.exit(1);
  }
  return match[1].replace(/-/g, "");
}

/**
 * Converts an array of Notion block objects to plain markdown text.
 *
 * @param blocks - Array of Notion block API responses
 * @returns Markdown string
 */
function blocksToMarkdown(blocks: BlockObjectResponse[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const btype = block.type;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (block as any)[btype] ?? {};
    const rich: RichTextItemResponse[] = data.rich_text ?? [];
    const text = rich.map((t) => t.plain_text).join("");

    switch (btype) {
      case "heading_1":
        lines.push(`# ${text}`);
        break;
      case "heading_2":
        lines.push(`## ${text}`);
        break;
      case "heading_3":
        lines.push(`### ${text}`);
        break;
      case "paragraph":
        lines.push(text);
        break;
      case "bulleted_list_item":
        lines.push(`- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${text}`);
        break;
      case "quote":
        lines.push(`> ${text}`);
        break;
      case "code": {
        const lang: string = data.language ?? "";
        lines.push(`\`\`\`${lang}\n${text}\n\`\`\``);
        break;
      }
      case "divider":
        lines.push("---");
        break;
      case "image":
      case "video":
      case "file": {
        const url: string =
          (data.external?.url ?? data.file?.url ?? "");
        const caption: string = (data.caption as RichTextItemResponse[] ?? [])
          .map((t) => t.plain_text)
          .join("");
        lines.push(`![${caption}](${url})`);
        break;
      }
    }
  }

  return lines.filter((l) => l.trim()).join("\n\n");
}

/**
 * Fetches a Notion page and returns its content as markdown.
 *
 * @param pageId - Notion page ID (32 hex chars)
 * @returns Page content as markdown string
 */
async function fetchNotionPage(pageId: string): Promise<string> {
  const notionToken = process.env.NOTION_TOKEN;
  if (!notionToken) {
    console.error("Error: NOTION_TOKEN must be set in .env to use the add command");
    process.exit(1);
  }

  const notion = new NotionClient({ auth: notionToken });

  // Fetch page metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = (await notion.pages.retrieve({ page_id: pageId })) as any;
  const props = page.properties ?? {};

  // Title
  const titleProp = Object.values(props).find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any) => p.type === "title"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;
  const title: string = (titleProp?.title ?? [])
    .map((t: RichTextItemResponse) => t.plain_text)
    .join("");

  // Tags
  let tags: string[] = [];
  for (const prop of Object.values(props) as any[]) {
    if (prop.type === "multi_select") {
      tags = prop.multi_select.map((opt: { name: string }) => opt.name);
      break;
    }
  }

  // Category
  let category = "";
  for (const prop of Object.values(props) as any[]) {
    if (prop.type === "select" && prop.select) {
      category = prop.select.name;
      break;
    }
  }

  // Blocks (paginated)
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined;
  while (true) {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    blocks.push(...(response.results as BlockObjectResponse[]));
    if (!response.has_more) break;
    cursor = response.next_cursor ?? undefined;
  }

  const body = blocksToMarkdown(blocks);

  const header = [`# ${title}`];
  if (category) header.push(`**Category:** ${category}`);
  if (tags.length) header.push(`**Tags:** ${tags.join(", ")}`);
  header.push("");

  return header.join("\n") + "\n" + body;
}

/**
 * Converts a page title to a safe filename slug.
 *
 * @param title - Raw page title
 * @returns Lowercase hyphenated slug without special characters
 */
function titleToFilename(title: string): string {
  let slug = title.toLowerCase();
  slug = slug.replace(/[^\w\s-]/g, "");
  slug = slug.replace(/[\s_]+/g, "-");
  slug = slug.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return slug || "notion-page";
}

// ---------------------------------------------------------------------------
// add command
// ---------------------------------------------------------------------------

/**
 * Fetches a Notion page, saves it to raw/, then compiles the wiki.
 *
 * @param url - Notion page URL
 */
async function cmdAdd(url: string): Promise<void> {
  console.log(`Fetching: ${url}`);

  const pageId = extractPageId(url);
  const content = await fetchNotionPage(pageId);

  // Derive filename from title (first line: "# Title")
  const firstLine = content.split("\n")[0].replace(/^#\s*/, "").trim();
  const filename = titleToFilename(firstLine) + ".md";
  const rawPath = path.join(RAW_DIR, filename);

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(rawPath, content, "utf-8");
  console.log(`Saved: raw/${filename}`);

  console.log();
  await cmdCompile();
}

// ---------------------------------------------------------------------------
// compile command
// ---------------------------------------------------------------------------

/**
 * Builds wiki/ from raw/ using Claude.
 */
async function cmdCompile(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY must be set in .env");
    process.exit(1);
  }

  if (!fs.existsSync(RAW_DIR)) {
    console.log("No .md files found in raw/");
    console.log("Add articles via: npm run add -- <notion-url>");
    return;
  }

  const rawFiles = fs
    .readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(RAW_DIR, f))
    .sort();

  if (rawFiles.length === 0) {
    console.log("No .md files found in raw/");
    console.log("Add articles via: npm run add -- <notion-url>");
    return;
  }

  console.log(`Found ${rawFiles.length} articles in raw/`);

  fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
  fs.mkdirSync(CONCEPTS_DIR, { recursive: true });

  const client = new Anthropic({ apiKey });

  // Phase 1: Summarize each article (Haiku, cheap, one by one)
  console.log("\nPhase 1: Summarizing articles...");
  await phaseSummarize(client, rawFiles);

  // Phase 2: Build concept articles (Sonnet + prompt caching)
  console.log("\nPhase 2: Building concept articles...");
  await phaseSynthesize(client);

  // Phase 3: Update index (Haiku)
  console.log("\nPhase 3: Updating index...");
  await phaseIndex(client);

  // Phase 4: Enrich summaries with links to concept articles (Haiku)
  console.log("\nPhase 4: Enriching summaries with concept links...");
  await phaseEnrichSummaries(client);

  const conceptCount = fs.readdirSync(CONCEPTS_DIR).filter((f) => f.endsWith(".md")).length;
  const summaryCount = fs.readdirSync(SUMMARIES_DIR).filter((f) => f.endsWith(".md")).length;

  console.log("\nDone.");
  console.log(`  ${INDEX_FILE}`);
  console.log(`  ${conceptCount} concept articles in wiki/concepts/`);
  console.log(`  ${summaryCount} summaries in wiki/summaries/`);
}

/**
 * Builds the message content for summarizing a single .md file.
 *
 * @param rawPath - Absolute path to the source .md file
 * @returns Anthropic message content blocks
 */
function buildSummarizeContent(rawPath: string): Anthropic.MessageParam["content"] {
  const prompt = `Summarize this article. Write everything in Ukrainian.

Return exactly this format:
## Підсумок
[3-5 речень підсумку українською]

## Ключові концепти
- концепт 1
- концепт 2
- концепт 3`;

  return [{ type: "text", text: fs.readFileSync(rawPath, "utf-8") + "\n\n" + prompt }];
}

/**
 * Summarizes each article in raw/. Skips files whose summary is already up to date.
 *
 * @param client - Anthropic client instance
 * @param rawFiles - Array of absolute paths to source files
 */
async function phaseSummarize(client: Anthropic, rawFiles: string[]): Promise<void> {
  for (const rawPath of rawFiles) {
    const stem = path.basename(rawPath, path.extname(rawPath));
    const summaryPath = path.join(SUMMARIES_DIR, `${stem}.md`);

    if (
      fs.existsSync(summaryPath) &&
      fs.statSync(summaryPath).mtimeMs >= fs.statSync(rawPath).mtimeMs
    ) {
      console.log(`  skip (up to date): ${path.basename(rawPath)}`);
      continue;
    }

    console.log(`  summarizing: ${path.basename(rawPath)}`);

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: buildSummarizeContent(rawPath) }],
    });

    fs.writeFileSync(summaryPath, (response.content[0] as Anthropic.TextBlock).text, "utf-8");
  }
}

/**
 * Map phase: for each changed summary, uses Haiku to extract concept slugs
 * and updates the concept index. Returns changed article stems and affected concept slugs.
 *
 * @param client - Anthropic client instance
 * @param summaryFiles - Absolute paths to all summary files
 * @param index - Concept index (mutated in place)
 */
async function phaseMap(
  client: Anthropic,
  summaryFiles: string[],
  index: ConceptIndex
): Promise<{ changedStems: string[]; affectedConcepts: Set<string> }> {
  const changedStems: string[] = [];
  const affectedConcepts = new Set<string>();

  // Existing slugs help Haiku reuse canonical names instead of creating duplicates
  const existingSlugs = Object.keys(index.conceptArticles);

  for (const summaryPath of summaryFiles) {
    const stem = path.basename(summaryPath, ".md");
    const content = fs.readFileSync(summaryPath, "utf-8");
    const hash = hashContent(content);

    if (index.articleHashes[stem] === hash) continue;

    console.log(`  mapping: ${stem}`);
    changedStems.push(stem);

    const reuseHint =
      existingSlugs.length > 0
        ? `Existing concept slugs (reuse when relevant, don't create duplicates):\n${existingSlugs.join(", ")}\n\n`
        : "";

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `Extract 3-6 main concepts from this article summary.
Return ONLY a JSON array of slug strings.
${reuseHint}Rules: lowercase_underscores, English for tech terms, transliterated Ukrainian otherwise.
Examples: ["react_native", "animatsii", "worklets", "headless_rezhym"]

Summary:
${content}`,
        },
      ],
    });

    let slugs: string[] = [];
    const raw = (response.content[0] as Anthropic.TextBlock).text.trim();
    try {
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start !== -1 && end !== -1) slugs = JSON.parse(raw.slice(start, end + 1));
    } catch {
      slugs = [stem.replace(/-/g, "_")];
    }

    // Mark old concepts of this article as affected (they may need updating)
    for (const slug of index.articleConcepts[stem] ?? []) affectedConcepts.add(slug);
    // Mark new concepts as affected
    for (const slug of slugs) affectedConcepts.add(slug);

    index.articleConcepts[stem] = slugs;
    index.articleHashes[stem] = hash;
  }

  // Rebuild full conceptArticles map from scratch
  index.conceptArticles = {};
  for (const [articleStem, slugs] of Object.entries(index.articleConcepts)) {
    for (const slug of slugs) {
      (index.conceptArticles[slug] ??= []).push(articleStem);
    }
  }

  return { changedStems, affectedConcepts };
}

/**
 * Reduce phase: for each affected concept slug, synthesizes a focused concept
 * article using only the relevant summaries. Each article is a separate Sonnet call,
 * which removes the max_tokens ceiling and enables incremental updates.
 *
 * @param client - Anthropic client instance
 * @param affectedConcepts - Set of concept slugs to (re)synthesize
 * @param index - Concept index with article mappings
 */
async function phaseReduce(
  client: Anthropic,
  affectedConcepts: Set<string>,
  index: ConceptIndex
): Promise<void> {
  for (const slug of affectedConcepts) {
    const articleStems = index.conceptArticles[slug] ?? [];
    if (articleStems.length === 0) continue;

    const summaries = articleStems
      .map((stem) => {
        const p = path.join(SUMMARIES_DIR, `${stem}.md`);
        return fs.existsSync(p) ? `### ${stem}\n\n${fs.readFileSync(p, "utf-8")}` : null;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");

    if (!summaries) continue;

    const conceptFilename = `${slug}.md`;
    const conceptPath = path.join(CONCEPTS_DIR, conceptFilename);
    const existing = fs.existsSync(conceptPath) ? fs.readFileSync(conceptPath, "utf-8") : "";

    const contentBlocks: Anthropic.MessageParam["content"] = [];

    if (existing) {
      contentBlocks.push({
        type: "text",
        text: `## Existing concept article (update if needed):\n\n${existing}`,
        cache_control: { type: "ephemeral" },
      } as Anthropic.TextBlockParam & { cache_control: { type: "ephemeral" } });
    }

    contentBlocks.push({
      type: "text",
      text: `Write or update the concept article for "${slug.replace(/_/g, " ")}" in Ukrainian.

Relevant article summaries:
${summaries}

Requirements:
- Write entirely in Ukrainian
- First paragraph: clear definition of the concept
- Add backlinks to source articles: [article name](../summaries/stem.md)
- Explain connections to related concepts
- Return ONLY the markdown content, no JSON, no code fences`,
    });

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: contentBlocks }],
    });

    fs.writeFileSync(
      conceptPath,
      (response.content[0] as Anthropic.TextBlock).text.trim(),
      "utf-8"
    );
    console.log(`  → ${conceptFilename}`);
  }
}

/**
 * Orchestrates Map-Reduce synthesis of concept articles.
 * Only processes summaries that have changed since the last compile,
 * and re-synthesizes only the concepts affected by those changes.
 *
 * @param client - Anthropic client instance
 */
async function phaseSynthesize(client: Anthropic): Promise<void> {
  const summaryFiles = fs
    .readdirSync(SUMMARIES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(SUMMARIES_DIR, f))
    .sort();

  if (summaryFiles.length === 0) return;

  const index = loadConceptIndex();

  console.log("  Step 1/2: Mapping articles to concepts (Haiku)...");
  const { changedStems, affectedConcepts } = await phaseMap(client, summaryFiles, index);
  saveConceptIndex(index);

  if (changedStems.length === 0) {
    console.log("  All concepts up to date — skipping synthesis.");
    return;
  }

  console.log(`  Step 2/2: Synthesizing ${affectedConcepts.size} affected concepts (Sonnet)...`);
  await phaseReduce(client, affectedConcepts, index);
}

/**
 * Generates index.md from all concept articles.
 *
 * @param client - Anthropic client instance
 */
async function phaseIndex(client: Anthropic): Promise<void> {
  const conceptFiles = fs
    .readdirSync(CONCEPTS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "_raw_response.md")
    .map((f) => path.join(CONCEPTS_DIR, f))
    .sort();

  if (conceptFiles.length === 0) return;

  const conceptsOverview = conceptFiles
    .map((f) => {
      const stem = path.basename(f, ".md");
      const snippet = fs.readFileSync(f, "utf-8").slice(0, 300);
      return `### ${stem}\n${snippet}...`;
    })
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Create a master index for this knowledge base. Write everything in Ukrainian.

Concepts:
${conceptsOverview}

Return a well-structured index.md in Ukrainian with:
1. A brief description of this knowledge base
2. Table of contents grouped by theme
3. Each concept links to its file: [Назва Концепту](concepts/filename.md)
4. One-line description per concept`,
      },
    ],
  });

  fs.writeFileSync(INDEX_FILE, (response.content[0] as Anthropic.TextBlock).text, "utf-8");
  console.log(`  → index.md`);
}

/**
 * Enriches summaries by replacing plain concept names in "Ключові концепти"
 * with markdown links to the actual concept files.
 * Skips summaries that already contain links.
 *
 * @param client - Anthropic client instance
 */
async function phaseEnrichSummaries(client: Anthropic): Promise<void> {
  const summaryFiles = fs
    .readdirSync(SUMMARIES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(SUMMARIES_DIR, f))
    .sort();

  if (summaryFiles.length === 0) return;

  const conceptStems = fs
    .readdirSync(CONCEPTS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "_raw_response.md")
    .map((f) => path.basename(f, ".md"));

  if (conceptStems.length === 0) return;

  const conceptList = conceptStems.map((s) => `${s}.md`).join(", ");

  for (const summaryPath of summaryFiles) {
    const content = fs.readFileSync(summaryPath, "utf-8");

    // Skip if links already present
    if (content.includes("](../concepts/")) {
      console.log(`  skip (already linked): ${path.basename(summaryPath)}`);
      continue;
    }

    console.log(`  linking: ${path.basename(summaryPath)}`);

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You have this summary file:

${content}

Available concept files: ${conceptList}

In the "## Ключові концепти" section, replace each plain concept name with a markdown link to the matching concept file using relative path "../concepts/filename.md".
Only link concepts that have a clearly matching file. Keep the display text in Ukrainian as-is.
Return the complete updated summary file content, nothing else.`,
        },
      ],
    });

    fs.writeFileSync(
      summaryPath,
      (response.content[0] as Anthropic.TextBlock).text,
      "utf-8"
    );
  }
}

// ---------------------------------------------------------------------------
// query command
// ---------------------------------------------------------------------------

/**
 * Answers a question using the wiki as cached context.
 *
 * @param question - The question to answer
 */
async function cmdQuery(question: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY must be set in .env");
    process.exit(1);
  }

  if (!fs.existsSync(INDEX_FILE)) {
    console.error("Wiki not built yet. Run: npm run compile");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  const index = fs.readFileSync(INDEX_FILE, "utf-8");
  const conceptFiles = fs
    .readdirSync(CONCEPTS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "_raw_response.md")
    .map((f) => path.join(CONCEPTS_DIR, f))
    .sort();

  const wikiContext =
    `# Index\n\n${index}\n\n---\n\n` +
    conceptFiles
      .map((f) => {
        const name = path.basename(f, ".md");
        return `# ${name}\n\n${fs.readFileSync(f, "utf-8")}`;
      })
      .join("\n\n---\n\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: wikiContext,
            cache_control: { type: "ephemeral" },
          } as Anthropic.TextBlockParam & { cache_control: { type: "ephemeral" } },
          {
            type: "text",
            text: `Based on the knowledge base above, answer in Ukrainian:\n\n${question}`,
          },
        ],
      },
    ],
  });

  console.log((response.content[0] as Anthropic.TextBlock).text);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry point — parses process.argv and dispatches to command handlers.
 */
async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "add": {
      const url = args[0];
      if (!url) {
        console.error("Usage: npm run add -- <notion-url>");
        process.exit(1);
      }
      await cmdAdd(url);
      break;
    }
    case "compile":
      await cmdCompile();
      break;
    case "query": {
      const question = args.join(" ");
      if (!question) {
        console.error('Usage: npm run query -- "your question"');
        process.exit(1);
      }
      await cmdQuery(question);
      break;
    }
    default:
      console.log(`Wiki Builder

Usage:
  npm run add -- <notion-url>   Fetch a Notion page, save to raw/, compile
  npm run compile               Process raw/*.md → wiki/
  npm run query -- "question"   Ask a question against the wiki`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
