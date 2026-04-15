# Wiki Builder

Transform your articles into an organized knowledge base using Claude.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

# 3. Add an article and build
npm run compile
```

## Tech Stack

- Node.js 22 + TypeScript
- [tsx](https://github.com/privatenumber/tsx) — run TypeScript without compilation
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-python) — Claude API with prompt caching
- [Notion Client](https://github.com/ramnes/notion-sdk-py) — fetch pages from Notion
- [dotenv](https://github.com/motdotla/dotenv) — environment variables

## Prerequisites

- Node.js 22+
- Anthropic API key — [console.anthropic.com](https://console.anthropic.com)
- Notion integration token *(optional, for `add` command)* — [notion.so/my-integrations](https://www.notion.so/my-integrations)

## Configuration

Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=sk-ant-...

# Optional — required only for the `add` command
NOTION_TOKEN=secret_...
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run add -- <url>` | Fetch a Notion page, save to `raw/`, compile |
| `npm run compile` | Process all files in `raw/` → build `wiki/` |
| `npm run query -- "question"` | Ask a question against the wiki |

## Project Structure

```
wiki/
├── raw/               # Source articles (.md and .pdf)
├── wiki/
│   ├── index.md       # Auto-generated master index
│   ├── concepts/      # Concept articles (written by Claude)
│   └── summaries/     # Per-article summaries (written by Claude)
├── wiki-builder.ts    # Main script
├── CONVENTIONS.md     # File naming rules for raw/
└── .env               # API keys (not committed)
```

## How It Works

1. **Add** — drop `.md` or `.pdf` files into `raw/`, or use `add` to fetch from Notion
2. **Summarize** — Claude Haiku summarizes each article individually
3. **Synthesize** — Claude Sonnet groups summaries into concept articles with backlinks
4. **Index** — Claude Haiku builds a master index grouped by theme

Prompt caching keeps incremental runs cheap — only new articles are processed each time.
