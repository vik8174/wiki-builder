# File Naming Conventions

Rules for naming files in `raw/`.

---

## Rules

1. **Lowercase only** — no uppercase letters
2. **Hyphens instead of spaces** — never use spaces or underscores
3. **No special characters** — no parentheses, commas, quotes, slashes
4. **Technical names stay in English** — React Native, Reanimated, SwiftUI, etc.
5. **Descriptive but short** — capture the topic, not the full title
6. **Supported formats** — `.md` and `.pdf`

---

## Examples

| Article title | Filename |
|---------------|----------|
| Використовуй React Native Reanimated для плавних анімацій | `react-native-reanimated-animations.md` |
| Як налаштувати CI/CD для iOS (з прикладами) | `ios-cicd-setup.md` |
| SwiftUI vs UIKit — що обрати у 2025 | `swiftui-vs-uikit.md` |
| Архітектура мобільного застосунку | `mobile-app-architecture.md` |
| Clean Architecture в React Native | `clean-architecture-react-native.md` |
| Design Patterns (книга, PDF) | `design-patterns.pdf` |

---

## What to avoid

| Bad | Why | Good |
|-----|-----|------|
| `React Native Reanimated.md` | spaces, uppercase | `react-native-reanimated.md` |
| `стаття_про_анімації.md` | Ukrainian, underscores | `animations-guide.md` |
| `react-native-(animations).md` | parentheses | `react-native-animations.md` |
| `article1.md` | not descriptive | `redux-state-management.md` |
| `my new article.md` | spaces | `my-new-article.md` |

---

## Why these rules

- The filename becomes the **source ID** in wiki summaries and backlinks
- Consistent names make it easy to find articles and trace references
- Hyphens are URL-safe and work across all operating systems
