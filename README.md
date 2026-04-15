# Wiki Builder

Transform your articles into an organized knowledge base using Claude.

## Quick Start

```bash
# 1. Install dependencies
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 2. Configure
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

# 3. Add an article and build
.venv/bin/python wiki_builder.py compile
```

## Tech Stack

- Python 3
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-python) — Claude API with prompt caching
- [Notion Client](https://github.com/ramnes/notion-sdk-py) — fetch pages from Notion
- [python-dotenv](https://github.com/theskumar/python-dotenv) — environment variables

## Prerequisites

- Python 3.10+
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
| `python wiki_builder.py add <url>` | Fetch a Notion page, save to `raw/`, compile |
| `python wiki_builder.py compile` | Process all files in `raw/` → build `wiki/` |
| `python wiki_builder.py query "question"` | Ask a question against the wiki |

## Project Structure

```
wiki/
├── raw/               # Source articles (.md and .pdf)
├── wiki/
│   ├── index.md       # Auto-generated master index
│   ├── concepts/      # Concept articles (written by Claude)
│   └── summaries/     # Per-article summaries (written by Claude)
├── wiki_builder.py    # Main script
├── CONVENTIONS.md     # File naming rules for raw/
└── .env               # API keys (not committed)
```

## How It Works

1. **Add** — drop `.md` or `.pdf` files into `raw/`, or use `add` to fetch from Notion
2. **Summarize** — Claude Haiku summarizes each article individually
3. **Synthesize** — Claude Sonnet groups summaries into concept articles with backlinks
4. **Index** — Claude Haiku builds a master index grouped by theme

Prompt caching keeps incremental runs cheap — only new articles are processed each time.
