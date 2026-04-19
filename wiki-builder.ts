#!/usr/bin/env tsx
/**
 * Wiki Builder — transforms Notion articles into an organized wiki using Claude CLI.
 *
 * Usage:
 *   npm run add -- <notion-url>                 # fetch from Notion, save to raw/, compile
 *   cat file.txt | npm run paste -- "Title"     # process raw text, translate, add to wiki
 *   npm run compile                             # build wiki from raw/
 *   npm run query -- "question"                 # ask a question against the wiki
 *   npm run linkedin                            # generate 10 LinkedIn post ideas from wiki
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
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
// Claude CLI helper
// ---------------------------------------------------------------------------

/**
 * Calls `claude -p <prompt>` as a subprocess and returns its stdout.
 * Uses the active Claude Code session — no API key required.
 *
 * @param prompt - Full prompt to send to Claude
 * @returns Claude's response as a string
 */
function callClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(out.trim());
      } else {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Runs async tasks over an array with a bounded concurrency pool.
 * Replaces sequential for-loops to scale to 1000+ articles.
 *
 * @param items - Items to process
 * @param fn - Async function to run for each item
 * @param limit - Max concurrent workers (default: 5)
 */
async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit = 5
): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const item = queue.shift()!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

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
        const url: string = data.external?.url ?? data.file?.url ?? "";
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = (await notion.pages.retrieve({ page_id: pageId })) as any;
  const props = page.properties ?? {};

  const titleProp = Object.values(props).find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any) => p.type === "title"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;
  const title: string = (titleProp?.title ?? [])
    .map((t: RichTextItemResponse) => t.plain_text)
    .join("");

  let tags: string[] = [];
  for (const prop of Object.values(props) as any[]) {
    if (prop.type === "multi_select") {
      tags = prop.multi_select.map((opt: { name: string }) => opt.name);
      break;
    }
  }

  let category = "";
  for (const prop of Object.values(props) as any[]) {
    if (prop.type === "select" && prop.select) {
      category = prop.select.name;
      break;
    }
  }

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
  return slug || "article";
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
// paste command
// ---------------------------------------------------------------------------

/** Reads all stdin until EOF and returns as a string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/**
 * Reads raw text from stdin, translates it to Ukrainian if needed,
 * saves to raw/, then compiles the wiki.
 *
 * @param title - Article title (used as filename slug)
 */
async function cmdPaste(title: string): Promise<void> {
  const rawContent = await readStdin();

  if (!rawContent) {
    console.error("Error: no content piped via stdin");
    console.error('Usage: cat file.txt | npm run paste -- "Article Title"');
    process.exit(1);
  }

  const slug = titleToFilename(title);
  if (slug === "article") {
    console.warn(`Warning: title "${title}" produced a generic slug. Consider a more descriptive title.`);
  }
  const filename = `${slug}.md`;
  const rawPath = path.join(RAW_DIR, filename);

  console.log(`Processing: "${title}"`);

  const result = await callClaude(
    `You received an article in any language. Prepare it for a Ukrainian knowledge wiki.

Tasks:
1. If the article is not in Ukrainian — translate it fully to Ukrainian (keep technical terms in English where natural)
2. Preserve all substance — do not summarize, translate the complete content
3. Format as markdown with this header:
   # ${title}

   [full article content in Ukrainian]

Return ONLY the formatted markdown article, nothing else.

Article:
${rawContent}`
  );

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(rawPath, result, "utf-8");
  console.log(`Saved: raw/${filename}`);
  console.log();

  await cmdCompile();
}

// ---------------------------------------------------------------------------
// compile command
// ---------------------------------------------------------------------------

/**
 * Builds wiki/ from raw/ using Claude CLI.
 */
async function cmdCompile(): Promise<void> {
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

  console.log("\nPhase 1: Summarizing articles...");
  await phaseSummarize(rawFiles);

  console.log("\nPhase 2: Building concept articles...");
  await phaseSynthesize();

  console.log("\nPhase 3: Updating index...");
  await phaseIndex();

  console.log("\nPhase 4: Enriching summaries with concept links...");
  await phaseEnrichSummaries();

  const conceptCount = fs.readdirSync(CONCEPTS_DIR).filter((f) => f.endsWith(".md")).length;
  const summaryCount = fs.readdirSync(SUMMARIES_DIR).filter((f) => f.endsWith(".md")).length;

  console.log("\nDone.");
  console.log(`  ${INDEX_FILE}`);
  console.log(`  ${conceptCount} concept articles in wiki/concepts/`);
  console.log(`  ${summaryCount} summaries in wiki/summaries/`);
}

/**
 * Summarizes each raw article in parallel (up to 5 concurrent).
 * Skips files whose summary is already up to date.
 *
 * @param rawFiles - Absolute paths to raw .md files
 */
async function phaseSummarize(rawFiles: string[]): Promise<void> {
  await runConcurrent(rawFiles, async (rawPath) => {
    const stem = path.basename(rawPath, ".md");
    const summaryPath = path.join(SUMMARIES_DIR, `${stem}.md`);

    if (
      fs.existsSync(summaryPath) &&
      fs.statSync(summaryPath).mtimeMs >= fs.statSync(rawPath).mtimeMs
    ) {
      console.log(`  skip (up to date): ${path.basename(rawPath)}`);
      return;
    }

    console.log(`  summarizing: ${path.basename(rawPath)}`);

    const content = fs.readFileSync(rawPath, "utf-8");
    const result = await callClaude(
      `Summarize this article. Write everything in Ukrainian.

Return exactly this format:
## Підсумок
[3-5 речень підсумку українською]

## Ключові концепти
- концепт 1
- концепт 2
- концепт 3

## Джерело
${stem}

Article:
${content}`
    );

    fs.writeFileSync(summaryPath, result, "utf-8");
  });
}

/**
 * Map phase: extracts concept slugs from changed summaries in parallel.
 * Writes results to the concept index atomically after all workers finish.
 *
 * @param summaryFiles - Absolute paths to all summary files
 * @param index - Concept index (mutated in place after all workers complete)
 */
async function phaseMap(
  summaryFiles: string[],
  index: ConceptIndex
): Promise<{ changedStems: string[]; affectedConcepts: Set<string> }> {
  const changedStems: string[] = [];
  const affectedConcepts = new Set<string>();

  // Snapshot existing slugs before any worker modifies the index
  const existingSlugs = Object.keys(index.conceptArticles);

  // Identify changed files and cache their content upfront (single read per file)
  const changedFiles: Array<{ summaryPath: string; content: string; hash: string }> = [];
  for (const summaryPath of summaryFiles) {
    const stem = path.basename(summaryPath, ".md");
    const content = fs.readFileSync(summaryPath, "utf-8");
    const hash = hashContent(content);
    if (index.articleHashes[stem] !== hash) changedFiles.push({ summaryPath, content, hash });
  }

  await runConcurrent(changedFiles, async ({ summaryPath, content, hash }) => {
    const stem = path.basename(summaryPath, ".md");

    console.log(`  mapping: ${stem}`);

    const reuseHint =
      existingSlugs.length > 0
        ? `Existing concept slugs (reuse when relevant, don't create duplicates):\n${existingSlugs.join(", ")}\n\n`
        : "";

    const raw = await callClaude(
      `Extract 3-6 main concepts from this article summary.
Return ONLY a JSON array of slug strings.
${reuseHint}Rules: lowercase_underscores, English for tech terms, transliterated Ukrainian otherwise.
Examples: ["react_native", "animatsii", "worklets", "headless_rezhym"]

Summary:
${content}`
    );

    let slugs: string[] = [];
    try {
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start !== -1 && end !== -1) slugs = JSON.parse(raw.slice(start, end + 1));
    } catch {
      console.warn(`  warn: failed to parse slugs for ${stem}, using fallback`);
      slugs = [stem.replace(/-/g, "_")];
    }

    // Safe in Node.js async — JS event loop is single-threaded between awaits
    changedStems.push(stem);
    for (const slug of index.articleConcepts[stem] ?? []) affectedConcepts.add(slug);
    for (const slug of slugs) affectedConcepts.add(slug);
    index.articleConcepts[stem] = slugs;
    index.articleHashes[stem] = hash;
  });

  // Rebuild conceptArticles after all workers have written to articleConcepts
  index.conceptArticles = {};
  for (const [articleStem, slugs] of Object.entries(index.articleConcepts)) {
    for (const slug of slugs) {
      (index.conceptArticles[slug] ??= []).push(articleStem);
    }
  }

  return { changedStems, affectedConcepts };
}

/**
 * Reduce phase: synthesizes a focused concept article for each affected concept
 * in parallel (up to 5 concurrent). Each concept is an independent Claude call.
 *
 * @param affectedConcepts - Concept slugs to (re)synthesize
 * @param index - Concept index with article mappings
 */
async function phaseReduce(
  affectedConcepts: Set<string>,
  index: ConceptIndex
): Promise<void> {
  await runConcurrent([...affectedConcepts], async (slug) => {
    const articleStems = index.conceptArticles[slug] ?? [];
    if (articleStems.length === 0) return;

    const summaries = articleStems
      .map((stem) => {
        const p = path.join(SUMMARIES_DIR, `${stem}.md`);
        return fs.existsSync(p) ? `### ${stem}\n\n${fs.readFileSync(p, "utf-8")}` : null;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");

    if (!summaries) return;

    const conceptFilename = `${slug}.md`;
    const conceptPath = path.join(CONCEPTS_DIR, conceptFilename);
    const existing = fs.existsSync(conceptPath) ? fs.readFileSync(conceptPath, "utf-8") : "";

    const existingSection = existing
      ? `## Existing concept article (update if needed):\n\n${existing}\n\n---\n\n`
      : "";

    const result = await callClaude(
      `${existingSection}Write or update the concept article for "${slug.replace(/_/g, " ")}" in Ukrainian.

Relevant article summaries:
${summaries}

Requirements:
- Write entirely in Ukrainian
- First paragraph: clear definition of the concept
- Add backlinks to source articles: [article name](../summaries/stem.md)
- Explain connections to related concepts
- Return ONLY the markdown content, no JSON, no code fences`
    );

    fs.writeFileSync(conceptPath, result.trim(), "utf-8");
    console.log(`  → ${conceptFilename}`);
  });
}

/**
 * Orchestrates Map-Reduce synthesis of concept articles.
 * Only processes changed summaries and affected concepts.
 */
async function phaseSynthesize(): Promise<void> {
  const summaryFiles = fs
    .readdirSync(SUMMARIES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(SUMMARIES_DIR, f))
    .sort();

  if (summaryFiles.length === 0) return;

  const index = loadConceptIndex();

  console.log("  Step 1/2: Mapping articles to concepts...");
  const { changedStems, affectedConcepts } = await phaseMap(summaryFiles, index);
  saveConceptIndex(index);

  if (changedStems.length === 0) {
    console.log("  All concepts up to date — skipping synthesis.");
    return;
  }

  console.log(`  Step 2/2: Synthesizing ${affectedConcepts.size} affected concepts...`);
  await phaseReduce(affectedConcepts, index);
}

/**
 * Generates wiki/index.md from all concept articles.
 */
async function phaseIndex(): Promise<void> {
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

  const result = await callClaude(
    `Create a master index for this knowledge base. Write everything in Ukrainian.

Concepts:
${conceptsOverview}

Return a well-structured index.md in Ukrainian with:
1. A brief description of this knowledge base
2. Table of contents grouped by theme
3. Each concept links to its file: [Назва Концепту](concepts/filename.md)
4. One-line description per concept`
  );

  fs.writeFileSync(INDEX_FILE, result, "utf-8");
  console.log(`  → index.md`);
}

/**
 * Enriches summaries by replacing plain concept names with markdown links.
 * Skips summaries that already contain links. Runs in parallel (up to 5 concurrent).
 */
async function phaseEnrichSummaries(): Promise<void> {
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

  await runConcurrent(summaryFiles, async (summaryPath) => {
    const content = fs.readFileSync(summaryPath, "utf-8");

    if (content.includes("](../concepts/")) {
      console.log(`  skip (already linked): ${path.basename(summaryPath)}`);
      return;
    }

    console.log(`  linking: ${path.basename(summaryPath)}`);

    const result = await callClaude(
      `You have this summary file:

${content}

Available concept files: ${conceptList}

In the "## Ключові концепти" section, replace each plain concept name with a markdown link to the matching concept file using relative path "../concepts/filename.md".
Only link concepts that have a clearly matching file. Keep the display text in Ukrainian as-is.
Return the complete updated summary file content, nothing else.`
    );

    fs.writeFileSync(summaryPath, result, "utf-8");
  });
}

// ---------------------------------------------------------------------------
// query command
// ---------------------------------------------------------------------------

/**
 * Answers a question using the wiki as context.
 *
 * @param question - The question to answer
 */
async function cmdQuery(question: string): Promise<void> {
  if (!fs.existsSync(INDEX_FILE)) {
    console.error("Wiki not built yet. Run: npm run compile");
    process.exit(1);
  }

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

  const result = await callClaude(
    `${wikiContext}

---

Based on the knowledge base above, answer in Ukrainian:

${question}`
  );

  console.log(result);
}

// ---------------------------------------------------------------------------
// linkedin command
// ---------------------------------------------------------------------------

/**
 * Generates 10 creative, unexpected LinkedIn post ideas based on the wiki.
 * Focuses on cross-concept combinations, contrarian takes, and novel angles.
 */
async function cmdLinkedIn(): Promise<void> {
  if (!fs.existsSync(INDEX_FILE)) {
    console.error("Wiki not built yet. Run: npm run compile");
    process.exit(1);
  }

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

  const result = await callClaude(
    `${wikiContext}

---

You are a creative LinkedIn content strategist. Based on this knowledge base, generate 10 LinkedIn post ideas.

Rules:
- Be UNEXPECTED — avoid obvious, generic takes
- Cross-pollinate concepts from different domains in this wiki
- Use contrarian angles, surprising analogies, "what nobody talks about" framings
- Think: what connection between two topics would make someone stop scrolling?
- Each idea must be distinct — no repetition of angles
- Respond entirely in Ukrainian

Format each idea as:
**N. [Заголовок поста]**
[2 речення: чому це несподівано і який кут зору відкриває пост]

Generate 10 ideas:`
  );

  console.log(result);
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
    case "paste": {
      const title = args.join(" ");
      if (!title) {
        console.error('Usage: cat file.txt | npm run paste -- "Article Title"');
        process.exit(1);
      }
      await cmdPaste(title);
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
    case "linkedin":
      await cmdLinkedIn();
      break;
    default:
      console.log(`Wiki Builder

Usage:
  npm run add -- <notion-url>              Fetch a Notion page, save to raw/, compile
  cat file.txt | npm run paste -- "Title"  Process raw text, translate to Ukrainian, add to wiki
  npm run compile                          Process raw/*.md → wiki/
  npm run query -- "question"              Ask a question against the wiki
  npm run linkedin                         Generate 10 LinkedIn post ideas from wiki`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
