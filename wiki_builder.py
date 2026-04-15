#!/usr/bin/env python3
"""
Wiki Builder — transforms .md and .pdf articles in raw/ into an organized wiki using Claude.

Usage:
    python wiki_builder.py add <notion-url>   # fetch from Notion, save to raw/, compile
    python wiki_builder.py compile            # build wiki from raw/
    python wiki_builder.py query "question"   # ask a question against the wiki
"""

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path
from dotenv import load_dotenv
import anthropic

SUPPORTED_EXTENSIONS = {".md", ".pdf"}

load_dotenv()

BASE_DIR = Path(__file__).parent
RAW_DIR = BASE_DIR / "raw"
WIKI_DIR = BASE_DIR / "wiki"
SUMMARIES_DIR = WIKI_DIR / "summaries"
CONCEPTS_DIR = WIKI_DIR / "concepts"
INDEX_FILE = WIKI_DIR / "index.md"

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
NOTION_TOKEN = os.getenv("NOTION_TOKEN")


# ---------------------------------------------------------------------------
# Notion helpers
# ---------------------------------------------------------------------------

def _extract_page_id(url: str) -> str:
    """Extract Notion page ID from a URL or plain ID string."""
    # Match 32 hex chars (with or without hyphens)
    match = re.search(r"([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})", url, re.I)
    if not match:
        sys.exit(f"Error: could not extract a Notion page ID from: {url}")
    return match.group(1).replace("-", "")


def _blocks_to_markdown(blocks: list) -> str:
    """Convert Notion block objects to plain markdown text."""
    lines = []
    for block in blocks:
        btype = block.get("type")
        data = block.get(btype, {})
        rich = data.get("rich_text", [])
        text = "".join(t.get("plain_text", "") for t in rich)

        if btype == "heading_1":
            lines.append(f"# {text}")
        elif btype == "heading_2":
            lines.append(f"## {text}")
        elif btype == "heading_3":
            lines.append(f"### {text}")
        elif btype == "paragraph":
            lines.append(text)
        elif btype == "bulleted_list_item":
            lines.append(f"- {text}")
        elif btype == "numbered_list_item":
            lines.append(f"1. {text}")
        elif btype == "quote":
            lines.append(f"> {text}")
        elif btype == "code":
            lang = data.get("language", "")
            code = "".join(t.get("plain_text", "") for t in rich)
            lines.append(f"```{lang}\n{code}\n```")
        elif btype == "divider":
            lines.append("---")
        elif btype in ("image", "video", "file"):
            url = (data.get("external") or data.get("file") or {}).get("url", "")
            caption = "".join(t.get("plain_text", "") for t in data.get("caption", []))
            lines.append(f"![{caption}]({url})")
    return "\n\n".join(line for line in lines if line.strip())


def _fetch_notion_page(page_id: str) -> str:
    """Fetch a Notion page and return its content as markdown."""
    try:
        from notion_client import Client as NotionClient
    except ImportError:
        sys.exit("Error: notion-client not installed. Run: pip install notion-client")

    if not NOTION_TOKEN:
        sys.exit("Error: NOTION_TOKEN must be set in .env to use the add command")

    notion = NotionClient(auth=NOTION_TOKEN)

    # Fetch page metadata
    page = notion.pages.retrieve(page_id=page_id)
    props = page.get("properties", {})

    # Title
    title_prop = next((p for p in props.values() if p.get("type") == "title"), {})
    title = "".join(t.get("plain_text", "") for t in title_prop.get("title", []))

    # Tags
    tags = []
    for prop in props.values():
        if prop.get("type") == "multi_select":
            tags = [opt["name"] for opt in prop.get("multi_select", [])]
            break

    # Category
    category = ""
    for prop in props.values():
        if prop.get("type") == "select" and prop.get("select"):
            category = prop["select"]["name"]
            break

    # Blocks (paginated)
    blocks = []
    cursor = None
    while True:
        kwargs = {"block_id": page_id}
        if cursor:
            kwargs["start_cursor"] = cursor
        response = notion.blocks.children.list(**kwargs)
        blocks.extend(response.get("results", []))
        if not response.get("has_more"):
            break
        cursor = response.get("next_cursor")

    body = _blocks_to_markdown(blocks)

    header = [f"# {title}"]
    if category:
        header.append(f"**Category:** {category}")
    if tags:
        header.append(f"**Tags:** {', '.join(tags)}")
    header.append("")

    return "\n".join(header) + "\n" + body


def _title_to_filename(title: str) -> str:
    """Convert a page title to a safe filename slug."""
    slug = title.lower()
    slug = re.sub(r"[^\w\s-]", "", slug)       # remove special chars
    slug = re.sub(r"[\s_]+", "-", slug)         # spaces → hyphens
    slug = re.sub(r"-+", "-", slug).strip("-")  # collapse hyphens
    return slug or "notion-page"


# ---------------------------------------------------------------------------
# add command
# ---------------------------------------------------------------------------

def cmd_add(url: str) -> None:
    """Fetch a Notion page, save to raw/, then compile the wiki."""
    print(f"Fetching: {url}")

    page_id = _extract_page_id(url)
    content = _fetch_notion_page(page_id)

    # Derive filename from title (first line: "# Title")
    first_line = content.splitlines()[0].lstrip("# ").strip()
    filename = _title_to_filename(first_line) + ".md"
    raw_path = RAW_DIR / filename

    raw_path.write_text(content, encoding="utf-8")
    print(f"Saved: raw/{filename}")

    print()
    cmd_compile()


# ---------------------------------------------------------------------------
# compile command
# ---------------------------------------------------------------------------

def cmd_compile() -> None:
    """Build wiki/ from raw/ using Claude."""
    if not ANTHROPIC_API_KEY:
        sys.exit("Error: ANTHROPIC_API_KEY must be set in .env")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    raw_files = sorted(
        f for f in RAW_DIR.iterdir()
        if f.suffix.lower() in SUPPORTED_EXTENSIONS
    )

    if not raw_files:
        print(f"No .md or .pdf files found in {RAW_DIR}/")
        print("Add some articles to raw/ and run compile again.")
        return

    md_count = sum(1 for f in raw_files if f.suffix.lower() == ".md")
    pdf_count = sum(1 for f in raw_files if f.suffix.lower() == ".pdf")
    print(f"Found {len(raw_files)} articles in raw/ ({md_count} md, {pdf_count} pdf)")

    # Phase 1: Summarize each article (Haiku, cheap, one by one)
    print("\nPhase 1: Summarizing articles...")
    _phase_summarize(client, raw_files)

    # Phase 2: Build concept articles (Sonnet + prompt caching)
    print("\nPhase 2: Building concept articles...")
    _phase_synthesize(client)

    # Phase 3: Update index (Haiku)
    print("\nPhase 3: Updating index...")
    _phase_index(client)

    print("\nDone.")
    print(f"  {INDEX_FILE}")
    print(f"  {len(list(CONCEPTS_DIR.glob('*.md')))} concept articles in wiki/concepts/")
    print(f"  {len(list(SUMMARIES_DIR.glob('*.md')))} summaries in wiki/summaries/")


def _build_summarize_content(raw_path: Path) -> list:
    """Build the message content blocks for a single file (md or pdf)."""
    prompt = f"""Summarize this article. Write everything in Ukrainian.

Return exactly this format:
## Підсумок
[3-5 речень підсумку українською]

## Ключові концепти
- концепт 1
- концепт 2
- концепт 3

## Джерело
{raw_path.stem}"""

    if raw_path.suffix.lower() == ".pdf":
        pdf_data = base64.standard_b64encode(raw_path.read_bytes()).decode("utf-8")
        return [
            {
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": pdf_data,
                },
            },
            {"type": "text", "text": prompt},
        ]

    # .md — plain text
    return [{"type": "text", "text": raw_path.read_text(encoding="utf-8") + "\n\n" + prompt}]


def _phase_summarize(client: anthropic.Anthropic, raw_files: list) -> None:
    """Summarize each article. Skip if summary is already up to date."""
    for raw_path in raw_files:
        # Summaries always stored as .md regardless of source format
        summary_path = SUMMARIES_DIR / (raw_path.stem + ".md")
        if (
            summary_path.exists()
            and summary_path.stat().st_mtime >= raw_path.stat().st_mtime
        ):
            print(f"  skip (up to date): {raw_path.name}")
            continue

        print(f"  summarizing: {raw_path.name}")

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": _build_summarize_content(raw_path)}],
        )

        summary_path.write_text(response.content[0].text, encoding="utf-8")


def _phase_synthesize(client: anthropic.Anthropic) -> None:
    """Build concept articles from all summaries using Sonnet with prompt caching."""
    summary_files = sorted(SUMMARIES_DIR.glob("*.md"))
    if not summary_files:
        return

    all_summaries = "\n\n---\n\n".join(
        f.read_text(encoding="utf-8") for f in summary_files
    )

    # Existing concepts become cached context — pay only for new summaries next run
    existing_concepts = ""
    concept_files = sorted(CONCEPTS_DIR.glob("*.md"))
    if concept_files:
        existing_concepts = "\n\n---\n\n".join(
            f"<!-- {f.stem} -->\n" + f.read_text(encoding="utf-8")
            for f in concept_files
        )

    system_prompt = """You are a knowledge base curator. Your job is to maintain a wiki of concept articles.

IMPORTANT: Write ALL content exclusively in Ukrainian. This includes titles, descriptions, explanations, and all text.

Each concept article should:
- Define the concept clearly in the first paragraph (in Ukrainian)
- List related articles (by source filename) as backlinks
- Explain how this concept connects to others
- Use clear, concise markdown

Return ONLY a JSON array, nothing else:
[
  {
    "filename": "concept_name.md",
    "content": "# Назва Концепту\\n\\nзміст українською..."
  }
]"""

    content_blocks = []

    if existing_concepts:
        content_blocks.append({
            "type": "text",
            "text": f"## Existing wiki concepts:\n\n{existing_concepts}",
            "cache_control": {"type": "ephemeral"},
        })

    content_blocks.append({
        "type": "text",
        "text": f"""## Article summaries:

{all_summaries}

Create or update concept articles based on these summaries.
All content must be written in Ukrainian.
Group related articles under shared concepts.
Filenames: lowercase with underscores, transliterated if needed (e.g. "mashynne_navchannia.md").""",
    })

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=8192,
        system=system_prompt,
        messages=[{"role": "user", "content": content_blocks}],
    )

    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = "\n".join(raw.split("\n")[1:])
        raw = raw[: raw.rfind("```")] if raw.endswith("```") else raw

    try:
        concepts = json.loads(raw)
        for concept in concepts:
            filename = concept.get("filename", "").strip()
            content = concept.get("content", "").strip()
            if filename and content:
                (CONCEPTS_DIR / filename).write_text(content, encoding="utf-8")
                print(f"  → {filename}")
    except json.JSONDecodeError as e:
        print(f"  Warning: could not parse response: {e}")
        (CONCEPTS_DIR / "_raw_response.md").write_text(raw, encoding="utf-8")


def _phase_index(client: anthropic.Anthropic) -> None:
    """Generate index.md from all concept articles."""
    concept_files = [
        f for f in sorted(CONCEPTS_DIR.glob("*.md")) if f.stem != "_raw_response"
    ]
    if not concept_files:
        return

    concepts_overview = "\n\n".join(
        f"### {f.stem}\n{f.read_text(encoding='utf-8')[:300]}..."
        for f in concept_files
    )

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2048,
        messages=[
            {
                "role": "user",
                "content": f"""Create a master index for this knowledge base. Write everything in Ukrainian.

Concepts:
{concepts_overview}

Return a well-structured index.md in Ukrainian with:
1. A brief description of this knowledge base
2. Table of contents grouped by theme
3. Each concept links to its file: [Назва Концепту](concepts/filename.md)
4. One-line description per concept""",
            }
        ],
    )

    INDEX_FILE.write_text(response.content[0].text, encoding="utf-8")
    print(f"  → index.md")


# ---------------------------------------------------------------------------
# query command
# ---------------------------------------------------------------------------

def cmd_query(question: str) -> None:
    """Answer a question using the wiki as context."""
    if not ANTHROPIC_API_KEY:
        sys.exit("Error: ANTHROPIC_API_KEY must be set in .env")

    if not INDEX_FILE.exists():
        sys.exit("Wiki not built yet. Run: python wiki_builder.py compile")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    index = INDEX_FILE.read_text(encoding="utf-8")
    concepts = {
        f.stem: f.read_text(encoding="utf-8")
        for f in sorted(CONCEPTS_DIR.glob("*.md"))
        if f.stem != "_raw_response"
    }

    wiki_context = f"# Index\n\n{index}\n\n---\n\n"
    wiki_context += "\n\n---\n\n".join(
        f"# {name}\n\n{content}" for name, content in concepts.items()
    )

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": wiki_context,
                        "cache_control": {"type": "ephemeral"},
                    },
                    {
                        "type": "text",
                        "text": f"Based on the knowledge base above, answer in Ukrainian:\n\n{question}",
                    },
                ],
            }
        ],
    )

    print(response.content[0].text)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a local wiki from markdown articles using Claude."
    )
    sub = parser.add_subparsers(dest="command")

    add_p = sub.add_parser("add", help="Fetch a Notion page, save to raw/, compile")
    add_p.add_argument("url", help="Notion page URL")

    sub.add_parser("compile", help="Process raw/*.md and raw/*.pdf → wiki/")

    q = sub.add_parser("query", help="Ask a question against the wiki")
    q.add_argument("question", help="The question to answer")

    args = parser.parse_args()

    if args.command == "add":
        cmd_add(args.url)
    elif args.command == "compile":
        cmd_compile()
    elif args.command == "query":
        cmd_query(args.question)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
