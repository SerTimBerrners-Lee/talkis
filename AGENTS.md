# TalkFlow - AGENTS.md

TalkFlow is a macOS voice-to-text application built with Tauri v2 (Rust backend) and React (TypeScript frontend), with a companion cloud platform (Next.js).

## Project Structure

```
talk-flow/
├── src/                      # Frontend (React/TypeScript)
│   ├── windows/
│   │   ├── widget/           # Small floating widget window
│   │   └── settings/         # Settings window with tabs
│   ├── components/           # Shared React components
│   ├── lib/
│   │   ├── store.ts          # Persistent settings (tauri-plugin-store)
│   │   ├── logger.ts         # Logging utilities
│   │   ├── permissions.ts    # OS permission checks
│   │   ├── cloudAuth.ts      # Cloud auth client (talkis.ru API)
│   │   └── utils.ts          # Helper functions
│   └── main.tsx              # Entry point (routes to widget/settings)
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # Tauri commands, window management
│   │   ├── ai.rs             # Whisper + LLM API calls
│   │   ├── paste.rs          # Clipboard paste simulation
│   │   └── logger.rs         # File logging
│   └── Cargo.toml
├── talkflow-web/             # Cloud platform (Next.js 15)
│   ├── src/app/              # Pages: landing, auth, dashboard
│   ├── src/components/       # Landing, dashboard, shared components
│   ├── src/lib/              # Auth, Prisma, email
│   ├── prisma/schema.prisma  # DB schema (7 models)
│   └── .env.example          # Environment variables template
└── package.json
```

## Build Commands

```bash
# Development (hot reload)
bun run tauri dev

# Build for production
bun run tauri build

# Build signed local macOS release artifact
bun run build:release:macos

# TypeScript check
bunx tsc --noEmit

# Rust check
cd src-tauri && cargo check

# Release checks
bun run check:release

# View logs
bun run logs          # tail -f ~/.talkflow/talkflow.log
bun run logs:clear    # rm ~/.talkflow/talkflow.log

# ── talkflow-web ──
cd talkflow-web && bun run dev       # Next.js dev server
cd talkflow-web && bunx tsc --noEmit # TS check
cd talkflow-web && bunx prisma migrate dev --name <name>  # DB migration
```

## Design System

### Fonts

| Token | Font | Usage |
|-------|------|-------|
| `--font` / `--font-main` | Inter | Body text, UI elements |
| `--font-accent` | Manrope 800 | **All headings** — bold, sans-serif, `letter-spacing: -0.04em` |
| `--font-brand` | Manrope 800 | Logo wordmark, `letter-spacing: -0.06em`, uppercase |

> **Rule:** Headings are NEVER italic. Both the Tauri app and web use Manrope for headings — not Playfair Display.

### Color Palette (Cappuccino Theme)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` / `--bg-cappuccino` | `#faf9f6` | Page background |
| `--text-hi` | `#000000` | Primary text |
| `--text-mid` | `#39342d` / `#666` | Secondary text |
| `--text-low` | `#5d564d` / `#999` | Tertiary / hint text |
| `--border` | `rgba(0,0,0,0.09)` | Subtle borders |

### Interactive Elements Style

Nav items, cards, and interactive elements follow a **soft** style:
- **Border radius:** `10px` for nav items, cards, buttons in sidebar
- **Active state:** `background: rgba(0,0,0,0.04)` + `font-weight: 600` + `color: var(--text-hi)` — never inverted black
- **Hover:** `background: rgba(0,0,0,0.04)`
- **Icons:** `size={18}`, `strokeWidth` active `2.2`, inactive `1.6`

### Buttons

| Class | Style | Usage |
|-------|-------|-------|
| `btn-black` | Black bg, white text, uppercase, rounded-full | Primary CTA |
| `btn-outline` | Transparent, black border, uppercase, rounded-full | Secondary CTA |

### CTA Subscription Block

The sidebar CTA is a **light card** (not inverted black):
- `background: rgba(0,0,0,0.03)`, `border: 1px solid rgba(0,0,0,0.06)`
- Dark text, dark icons
- Button inside is `btn-black` style (black bg, white text)

## Code Style

### TypeScript/React

**Imports:** Group by external → internal, use explicit file extensions for clarity when needed.

```typescript
// External
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Internal - use relative paths
import { getSettings } from "../../lib/store";
import { logInfo } from "../../lib/logger";
```

**Components:** Use function components with explicit return types.

```typescript
export function MyComponent({ prop }: { prop: string }): JSX.Element {
  // hooks at the top
  const [state, setState] = useState<string>("");
  
  // early returns for loading/error states
  if (!state) return null;
  
  // main render
  return <div>{prop}</div>;
}
```

**Styles:** Use inline styles with CSS variables. No CSS modules or styled-components.

```typescript
// Good
<div style={{
  display: "flex",
  padding: "16px 20px",
  background: "var(--surface)",
}}>
```

**Types:** Prefer explicit interfaces over type aliases. Use union types for finite states.

```typescript
type WidgetState = "idle" | "recording" | "processing" | "error";

interface AppSettings {
  apiKey: string;
  hotkey: string;
  // ...
}
```

**Error handling:** Always handle errors gracefully, show user-friendly messages.

```typescript
try {
  await someAsyncOperation();
} catch (e) {
  const msg = e instanceof Error ? e.message : "Unknown error";
  showError(`Операция не удалась: ${msg}`);
}
```

**Logging:** Use the logger utility for important events.

```typescript
import { logInfo, logError } from "../../lib/logger";

logInfo("HOTKEY", "Registered successfully");
logError("API", `Failed: ${e}`);
```

### Rust

**Commands:** Use `#[tauri::command]` with async when needed.

```rust
#[tauri::command]
pub async fn my_command(param: String) -> Result<MyResponse, String> {
    // implementation
}
```

**Error handling:** Use `Result<T, String>` for commands, convert errors with `.map_err(|e| e.to_string())`.

```rust
let result = some_operation()
    .map_err(|e| format!("Operation failed: {}", e))?;
```

**Logging:** Use the logger module.

```rust
logger::log_info("TAG", "message");
logger::log_error("TAG", &format!("error: {}", e));
```

## Architecture Notes

- **Two windows:** Widget (50x18px floating) and Settings (separate window)
- **Global shortcuts:** Use `tauri-plugin-global-shortcut` for hotkey registration
- **Persistent storage:** Use `tauri-plugin-store` with JSON file
- **Permissions:** Check microphone via `getUserMedia()`, accessibility via system dialog
- **API calls:** Whisper for transcription, GPT-4o-mini for text cleanup
- **Cloud platform:** `talkflow-web/` — Next.js 15, Auth.js v5, Prisma, PostgreSQL
- **Auth flow:** Email OTP + Yandex OAuth → deep link `talkflow://auth?token=xxx`
- **Subscription:** Free (own API key) or paid (cloud, 390₽/mo)

## Release Workflow

- Follow `docs/release/rule.md` for every release
- Always update `README.md` before publishing a release
- Create a per-release review file from `docs/release/review-template.md`
- Push release work to `release/vX.Y.Z` first, then to `main`, then push tag `vX.Y.Z`
- Treat `.github/workflows/release.yml` as the release automation source of truth

## Key Conventions

1. **Language:** UI text in Russian, code/comments in English
2. **Hotkeys:** Format is `Modifier+Key` (e.g., `Ctrl+Alt+Space`), always validate with `validateHotkey()`
3. **Settings:** Load once at startup via `getSettings()`, save immediately on change
4. **Window sizes:** Widget is 50x18 in its compact state; keep window sizing in sync with `src/windows/widget/widgetConstants.ts`
5. **Logs location:** `~/.talkflow/talkflow.log`
6. **Package manager:** Use `bun` everywhere (not npm/yarn)
7. **Dev-only features:** Gate behind `import.meta.env.DEV` (e.g., Prompt Preview)
