# Wiki Builder

Transform your Notion articles into an organized knowledge base using Claude.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
# Add ANTHROPIC_API_KEY and NOTION_TOKEN to .env

# 3. Add a Notion article and build
npm run add -- <notion-url>
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
- Notion integration token — [notion.so/my-integrations](https://www.notion.so/my-integrations)

## Configuration

Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=sk-ant-...
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
├── raw/               # Source articles fetched from Notion
├── wiki/
│   ├── index.md       # Auto-generated master index
│   ├── concepts/      # Concept articles (written by Claude)
│   └── summaries/     # Per-article summaries (written by Claude)
├── wiki-builder.ts    # Main script
└── .env               # API keys (not committed)
```

## How It Works

1. **Add** — fetch a Notion page with `add`, saved to `raw/` as markdown
2. **Summarize** — Claude Haiku summarizes each article individually
3. **Synthesize** — Claude Sonnet groups summaries into concept articles with backlinks
4. **Index** — Claude Haiku builds a master index grouped by theme

Prompt caching keeps incremental runs cheap — only new or changed articles are processed each time.
