# TalkFlow - AGENTS.md

TalkFlow is a macOS voice-to-text application built with Tauri v2 (Rust backend) and React (TypeScript frontend).

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
│   │   └── utils.ts          # Helper functions
│   └── main.tsx              # Entry point (routes to widget/settings)
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # Tauri commands, window management
│   │   ├── ai.rs             # Whisper + LLM API calls
│   │   ├── paste.rs          # Clipboard paste simulation
│   │   └── logger.rs         # File logging
│   └── Cargo.toml
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
```

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
