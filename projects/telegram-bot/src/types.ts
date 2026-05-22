export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: TelegramMessage;
  quote?: { text: string; entities?: any[]; offset?: number; is_manual?: boolean };
  message_thread_id?: number;   // set on all messages in non-General forum topics
  forum_topic_created?: { name: string; icon_color: number; icon_custom_emoji_id?: string };
  forum_topic_edited?: { name?: string; icon_custom_emoji_id?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  message_id?: number;
  thread_id?: number;   // set when archiving to identify which topic this turn came from
  worker?: string;      // the specific model that generated this turn (e.g., 'claude', 'gemini')
  session_id?: string;  // the CLI session ID associated with this turn
  refId?: string;       // bot reply debug handle (e.g., 'c-a59a') — set on assistant turns; queryable via `pa ref`
}

export interface PendingAction {
  description: string;
  proposed_at: string;
}

export interface SessionInfo {
  session_id: string;  // UUID of the CLI session (Claude: JSONL filename; Gemini: UUID from session JSON)
  worker: string;      // 'claude' or 'gemini'
  started_at: string;  // ISO timestamp — session expires 24h after this
}

export type ModelStatusReasonCode =
  | 'default_active'
  | 'user_override'
  | 'user_selected_default'
  | 'default_changed'
  | 'failover'
  | 'recovery'
  | 'midnight_reset'
  | 'reset';

export interface ModelStatusSnapshot {
  current_worker: string;
  default_worker: string;
  reason_code: ModelStatusReasonCode;
  reason_text: string;
  changed_at: string;
}

export interface ConversationState {
  chat_id: number;
  last_update_id: number;         // only meaningful in the global state file; 0 in per-topic files
  thread_id: number;              // 0 = General / no-topic (private chat); N = forum topic ID
  turns: ConversationTurn[];
  pending_action?: PendingAction;
  session?: SessionInfo;          // Active CLI session for resumption
  preferred_worker?: string;      // 'claude' | 'gemini' | 'zclaude' — overrides config priority order
  preferred_worker_set_at?: string; // ISO timestamp when preferred_worker was set — cleared at IST midnight
  cwd_override?: string;          // absolute path — overrides BOT_CWD for all worker dispatches in this topic
  model_status?: ModelStatusSnapshot; // canonical snapshot for the topic status card
  pinned_worker?: string;         // legacy mirror of model_status.current_worker for backward compatibility
  pinned_status_message_id?: number; // message_id of the pinned status card (model + keep-awake) — unpinned when context is cleared
  last_codex_usage_pct?: number;    // Codex rate-limit window used_percent from last turn — debounces proactive warnings
  pendingDescription?: {            // AI-029: auto-suggest description awaiting user approval
    text: string;                   // suggested description text (empty string = open prompt only)
    proposedAt: string;             // ISO timestamp when suggestion was posted
    expiresAt: number;              // epoch ms — auto-accept if now > expiresAt
  };
  ancestry?: BranchAncestry;       // AI-028: branch relationship to a parent topic
}

export interface BranchAncestry {
  parentChatId: number;
  parentThreadId: number;
  branchName: string;    // name of THIS topic (the branch)
  mergedAt?: string;     // ISO timestamp set when /merge completes
}

export interface PAMetaAction {
  type: 'retry_with_worker' | 'run_skill' | 'confirm_required' | 'restart_bot' | string;
  worker?: string;   // ignored by dispatch — system picks next worker by config priority
  skill?: string;    // for run_skill: skill name to trigger
  reason?: string;   // human-readable explanation (optional)
}

export interface PAMeta {
  actions: PAMetaAction[];
}
