# Agentic Brain - Telegram Bot (pa-telegram-bot)

The Agentic Brain for the Telegram bot interface.

## Intelligence Layers

1.  **Communication Layer**: `src/main.ts` (Entry Point)
    -   Handles Telegram long-polling via `getUpdates`.
    -   **Parallel Update Processing**: Processes a batch of updates in parallel using `Promise.all`.
    -   **Topic-Level Serialization**: Each update is processed in its own `processUpdate` call, which serializes access to its topic via the Locking Blackboard (`topic-{chatId}_{threadId}`).
    -   Manages per-chat and per-topic (forum thread) conversation state.
    -   Dispatches messages to workers (Gemini/Claude) with session persistence.
    -   Acknowledges user messages immediately with a thumbs-up (👍) via `setMessageReaction`.
2.  **Context Layer**: `src/context.ts`
    -   Builds the prompt for the AI, including conversation history (rolling 20-turn window).
    -   Handles IST timestamp injection and system instructions.
3.  **Logic Layer**: `src/logic.ts`
    -   Cleans agent output (strips thought blocks, planning headers).
    -   Handles `/model` switch commands (persisted via `preferred_worker` in `ConversationState` for per-topic model stickiness).
    -   Manages pending action confirmations (Reply *yes* to confirm).
    -   Parses `[PA_META]` for machine-readable actions (retry, run_skill).
4.  **Session Layer**: `src/session.ts`
    -   Manages AI session IDs for stateful conversations.
    -   Discovers active Gemini sessions on disk if not returned by the worker.
5.  **Keep-Awake Layer**: `src/keepawake.ts`
    -   Machine-wide sleep prevention via Windows API helper (`SetThreadExecutionState`).
    -   Bare toggle `/keepawake` slash command with global state in `PA_HOME`.
    -   Consolidated with model state into a unified pinned status card per topic.

## Brain Files

-   **State**: `~/.pa/telegram-bot-state.json` - Global state (e.g., `last_update_id`).
-   **Conversation State**: `~/.pa/conversation-history/<chat_id>_<thread_id>.json` - Per-topic history and session metadata.
-   **Conversation Archive**: `~/.pa/conversation-history.jsonl` - Permanent append-only log of every turn (processed by `ecosystem-kb` skill).
-   **Lock**: `~/.pa/telegram-bot.lock` - Prevents multiple instances.

## Connections

-   **Telegram -> Worker**: `main.ts` calls `pa/src/workers.ts` to execute Gemini/Claude.
-   **Worker -> Logic**: Worker output is cleaned and metadata is extracted.
-   **Metadata -> pa**: `run_skill` action triggers `pa run <skill>` via `spawn`.
-   **Archive -> KB**: `conversation-history.jsonl` is the source of truth for the nightly KB update.

## File Inventory

-   `src/main.ts`: Main poll loop and dispatch logic.
-   `src/telegram.ts`: Low-level Telegram API wrappers.
-   `src/conversation.ts`: History and session persistence.
-   `src/logic.ts`: Output cleaning and action resolution.
-   `src/context.ts`: Prompt building.
-   `src/session.ts`: Session management.
