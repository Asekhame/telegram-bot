/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers public status and contract
 * commands plus operator pause/resume controls. Operator controls only change
 * when the next polling cycle starts; they never edit cursors or touch chain
 * state. All chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { Bot, type Context } from "grammy";

import { escapeMd, previewMessage, safeErrorMessage } from "./notifications/format.js";
export { previewMessage } from "./notifications/format.js";
import { networkLabel, type BotConfig } from "./config.js";
import { contractExplorerUrl } from "./stellar/client.js";
import { buildHealthReport } from "./health.js";
import type { PollerPauseResult, PollerResumeResult, PollerStatus } from "./poller.js";

const HELP_BASE = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/contracts — the contract ids I watch and where to look them up",
  "/health — health assessment and operational readiness",
  "/preview — preview channel notification formatting",
  "/help — this message",
];

export function helpMessage(config: BotConfig): string {
  if (config.operatorTelegramUserId === null) return HELP_BASE.join("\n");
  return [
    ...HELP_BASE.slice(0, -1),
    "/pause — operator only: pause scheduling new scans",
    "/resume — operator only: resume polling now",
    HELP_BASE.at(-1) as string,
  ].join("\n");
}

export const TELEGRAM_OPTIONS = {
  parse_mode: "MarkdownV2" as const,
  link_preview_options: { is_disabled: true },
};

function ago(timestamp: number | null, nowMs: number = Date.now()): string {
  if (timestamp === null) return "never";
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function cursorPreview(cursor: string | null): string {
  if (cursor === null) return "none (cold start)";
  const compact = cursor.replace(/\s+/g, " ").replace(/[`\\]/g, "?").trim() || "empty";
  return compact.length <= 24 ? compact : `${compact.slice(0, 23)}…`;
}

function statusMessage(config: BotConfig, status: PollerStatus, nowMs: number = Date.now()): string {
  const lines: string[] = [
    `*Status* — ${status.paused ? "paused" : status.running ? "running" : "stopped"} on Stellar ${networkLabel(config)}`,
    `Channel preview: ${config.channelPreviewMode ? "enabled" : "disabled"}`,
    "",
    `Chain tip: ${status.latestLedger ?? "unknown"}`,
    `RPC retains from ledger: ${status.oldestLedger ?? "unknown"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Cycles: ${status.cycles} · sent ${status.notificationsSent} · failed sends ${status.notificationsFailed} · skipped ${status.eventsSkipped}`,
    "",
    "*Watching*",
  ];

  for (const target of status.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${cursorPreview(target.cursor)}\``,
    );
    if (target.lastError) lines.push(`  last error: ${escapeMd(target.lastError)}`);
  }

  if (status.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError.at, nowMs)}\\): ${escapeMd(status.lastError.message)}`,
    );
  }
  if (status.consecutiveFailures > 0) {
    lines.push(`Consecutive failed cycles: ${status.consecutiveFailures}`);
  }

  return lines.join("\n");
}

/**
 * The `/contracts` message: which two contracts this bot watches, and where to
 * look each one up independently — deliberately static (config only, no
 * poller state), so it answers the same whether the poller is mid-cycle,
 * between restarts, or wedged on a run of RPC failures. `/status` is for
 * "is it working"; this is for "what is it even watching".
 */
export function healthMessage(
  config: BotConfig,
  status: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const report = buildHealthReport(config, status, nowMs);
  const statusLabel = report.status.toUpperCase();

  const lines: string[] = [
    `*Health* — ${escapeMd(statusLabel)} on Stellar ${networkLabel(config)}`,
    "",
    `Status: \`${report.status}\` \\(${report.ok ? "ok" : "action required"}\\)`,
    `Poller: ${report.poller.running ? "running" : "stopped"}`,
    `Uptime: ${report.uptimeMs > 0 ? ago(nowMs - report.uptimeMs, nowMs) : "0s"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Last successful poll: ${ago(status.lastSuccessAt, nowMs)}`,
    `Chain tip: ${report.poller.latestLedger ?? "unknown"}`,
    `Cycles: ${report.poller.cycles} · consecutive failures: ${report.poller.consecutiveFailures}`,
    `Notifications: sent ${report.poller.notificationsSent} · failed ${report.poller.notificationsFailed} · skipped ${report.poller.eventsSkipped}`,
    "",
    "*Watched Contracts*",
  ];

  for (const target of report.poller.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${target.cursorPreview ?? "none (cold start)"}\``,
    );
    if (target.hasError) {
      const targetState = status.targets.find((t) => t.source === target.source);
      if (targetState?.lastError) {
        lines.push(`  last error: ${escapeMd(targetState.lastError)}`);
      }
    }
  }

  if (report.poller.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError?.at ?? null, nowMs)}\\): ${escapeMd(report.poller.lastError.message)}`,
    );
  }

  return lines.join("\n");
}

export function contractsMessage(config: BotConfig): string {
  const targets: Array<{ label: string; contractId: string }> = [
    { label: "mimir\\-market", contractId: config.marketContractId },
    { label: "mimir\\-squad", contractId: config.squadContractId },
  ];

  const lines: string[] = [
    `*Contracts* — Mimir on Stellar ${escapeMd(networkLabel(config))}`,
    "",
    "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.",
  ];

  for (const target of targets) {
    lines.push(
      "",
      `*${target.label}*`,
      `\`${escapeMd(target.contractId)}\``,
      `[View on stellar\\.expert](${contractExplorerUrl(config, target.contractId)})`,
    );
  }

  return lines.join("\n");
}

/** Exact operator replies, exported for deterministic Telegram payload tests. */
export function pauseMessage(result: PollerPauseResult): string {
  switch (result) {
    case "paused":
      return "*Polling paused*\nThe current scan may finish, but no new cycle will start\\. Cursors were not changed\\.";
    case "already-paused":
      return "*Polling is already paused*";
    case "stopped":
      return "*Polling cannot pause* — the process is stopping\\.";
  }
}

export function resumeMessage(result: PollerResumeResult): string {
  switch (result) {
    case "resumed":
      return "*Polling resumed*\nThe next scan starts now\\. Cursors were not changed\\.";
    case "already-running":
      return "*Polling is already running*";
    case "stopped":
      return "*Polling cannot resume* — the process is stopping\\.";
  }
}

export interface BotDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /**
   * Pre-populated bot info. When provided (e.g. in tests) grammy skips the
   * getMe() call so `bot.handleUpdate()` works without a real Telegram token.
   */
  botInfo?: UserFromGetMe;
}

/**
 * Returns true when the chat is permitted to use restricted commands.
 *
 * Rules:
 * - If `allowedChatIds` is empty the list is open (any chat may use /status).
 * - Otherwise the incoming chat id must appear in the list. Both the numeric
 *   id (stored as a number in grammy's ctx.chat.id) and its string form are
 *   compared so that negative group ids such as -1001234567890 match correctly.
 */
function isChatAllowed(allowedChatIds: string[], chatId: number): boolean {
  if (allowedChatIds.length === 0) return true;
  const asString = String(chatId);
  return allowedChatIds.some((allowed) => allowed === asString);
}

export function createBot(deps: BotDeps): Bot {
  const { config, status } = deps;
  const bot = new Bot(config.botToken, deps.botInfo !== undefined ? { botInfo: deps.botInfo } : undefined);
  pause: () => PollerPauseResult;
  resume: () => PollerResumeResult;
}

export function isOperator(ctx: Context, config: BotConfig): boolean {
  const operatorId = config.operatorTelegramUserId;
  return operatorId !== null && ctx.from?.id.toString() === operatorId;
}

function isMessageNotModified(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(msg);
}

export async function safeAnswerCallback(
  ctx: Context,
  config: BotConfig,
  params: { text?: string; show_alert?: boolean } = {},
): Promise<void> {
  if (ctx.callbackQuery?.id) {
    try {
      await ctx.answerCallbackQuery(params);
    } catch (err) {
      console.warn(
        `[bot] answerCallbackQuery failed: ${safeErrorMessage(err, [config.botToken])}`,
      );
    }
  }
}

export async function updateOrReplyMessage(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  const options = {
    ...TELEGRAM_OPTIONS,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      if (isMessageNotModified(err)) {
        return;
      }
      // If edit failed (e.g. message too old or deleted), fall through to reply
    }
  }

  if (ctx.chat) {
    await ctx.reply(text, options);
    return;
  }

  // no-op: callers that need to target the configured chat should call
  // `ctx.api.sendMessage(config.chatId, ...)` directly when `ctx.chat` is
  // unavailable. handleCallbackQuery does this.
}

export async function handleCallbackQuery(
  ctx: Context,
  deps: BotDeps,
): Promise<void> {
  const { config, status } = deps;
  const pause = deps.pause ?? (() => "stopped");
  const resume = deps.resume ?? (() => "stopped");
  const rawData = ctx.callbackQuery?.data;

  // Validate callback query data before acting
  const validation = validateCallbackData(rawData);

  if (!validation.ok) {
    console.warn(
      `[bot] rejected invalid callback query (${validation.reason}) on update ${ctx.update.update_id}`,
    );
    await safeAnswerCallback(ctx, config, {
      text: validation.fallbackText,
      show_alert: false,
    });
    return;
  }

  const { action } = validation;

  // Enforce operator role authorization
  if (action.type === "pause" || action.type === "resume") {
    if (!isOperator(ctx, config)) {
      console.warn(
        `[bot] ignored unauthorized callback /${action.type} on update ${ctx.update.update_id}`,
      );
      await safeAnswerCallback(ctx, config, {
        text: CALLBACK_UNAUTHORIZED_FEEDBACK,
        show_alert: true,
      });
      return;
    }
  }

  // Execute validated action
  try {
    switch (action.type) {
      case "status": {
        const text = statusMessage(config, status());
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, statusKeyboard(config));
        } else {
          await ctx.api.sendMessage(config.chatId, text, {
            ...TELEGRAM_OPTIONS,
            reply_markup: statusKeyboard(config),
          });
        }
        await safeAnswerCallback(ctx, config, { text: "Status refreshed" });
        break;
      }

      case "contracts": {
        const text = contractsMessage(config);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, contractsKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, { text: "Contracts" });
        break;
      }

      case "help": {
        const text = helpMessage(config);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text);
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, { text: "Help" });
        break;
      }

      case "pause": {
        const result = pause();
        const text = pauseMessage(result);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, operatorKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, {
          text: result === "paused" ? "Polling paused" : result === "already-paused" ? "Already paused" : "Cannot pause",
        });
        break;
      }

      case "resume": {
        const result = resume();
        const text = resumeMessage(result);
        if (ctx.callbackQuery?.message) {
          await updateOrReplyMessage(ctx, text, operatorKeyboard());
        } else {
          await ctx.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
        }
        await safeAnswerCallback(ctx, config, {
          text: result === "resumed" ? "Polling resumed" : result === "already-running" ? "Already running" : "Cannot resume",
        });
        break;
      }
    }
  } catch (err) {
    console.error(
      `[bot] callback error on action ${action.type}: ${safeErrorMessage(err, [config.botToken])}`,
    );
    await safeAnswerCallback(ctx, config, { text: "Action failed" });
  }
}

/** Register callback handlers on a grammy-compatible bot or mock. */
export function registerCallbackHandlers(
  bot: Bot | { on: (event: string, handler: (ctx: Context) => Promise<void>) => void },
  deps: BotDeps,
): void {
  (bot as { on: (event: string, handler: (ctx: Context) => Promise<void>) => void }).on(
    "callback_query",
    async (ctx: Context) => {
      await handleCallbackQuery(ctx, deps);
    },
  );
}

/** Register command handlers on a grammy-compatible bot (also useful in tests). */
export function registerCommandHandlers(
  bot: Bot | { command: (name: string, handler: (ctx: Context) => Promise<void>) => void },
  deps: BotDeps,
): void {
  const { config, status } = deps;
  const pause = deps.pause ?? (() => "stopped");
  const resume = deps.resume ?? (() => "stopped");

  bot.command("start", async (ctx) => {
    await ctx.reply(helpMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("status", async (ctx) => {
    if (!isChatAllowed(config.allowedChatIds, ctx.chat.id)) {
      // Silently ignore requests from unapproved chats. Responding with an
      // error would leak the existence of the restriction; not responding at
      // all is consistent with privacy-mode bots that simply never see most
      // messages. Log so operators can diagnose misconfigured chat ids.
      console.warn(
        `[bot] /status denied for chat ${ctx.chat.id} (not in ALLOWED_CHAT_IDS)`,
      );
      return;
    }
    await ctx.reply(statusMessage(config, status()), {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
    await ctx.reply(statusMessage(config, status()), TELEGRAM_OPTIONS);
  });

  // Config-only, so this never fails on account of poller or RPC state —
  // unlike /status, it has nothing to report failure on.
  bot.command("health", async (ctx) => {
    await ctx.reply(healthMessage(config, status()), TELEGRAM_OPTIONS);
  });

  bot.command("contracts", async (ctx) => {
    await ctx.reply(contractsMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("preview", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const spaceIndex = text.indexOf(" ");
    const arg = spaceIndex !== -1 ? text.slice(spaceIndex + 1).trim() : "";
    await ctx.reply(previewMessage(config, arg || "market"), TELEGRAM_OPTIONS);
  });

  bot.command("pause", async (ctx) => {
    if (!isOperator(ctx, config)) {
      console.warn(`[bot] ignored unauthorized /pause on update ${ctx.update.update_id}`);
      return;
    }
    await ctx.reply(pauseMessage(pause()), TELEGRAM_OPTIONS);
  });

  bot.command("resume", async (ctx) => {
    if (!isOperator(ctx, config)) {
      console.warn(`[bot] ignored unauthorized /resume on update ${ctx.update.update_id}`);
      return;
    }
    await ctx.reply(resumeMessage(resume()), TELEGRAM_OPTIONS);
  });
}

export function createBot(deps: BotDeps): Bot {
  // Allow tests and partial harness overrides to omit a real token by using a
  // harmless placeholder. In production `config.botToken` should always be
  // provided; this only prevents grammy from throwing during certain unit
  // tests where the test harness accidentally passes a partial config.
  const token = deps.config?.botToken ?? process.env.BOT_TOKEN ?? "TEST-BOT-TOKEN";
  const bot = new Bot(token);
  registerCommandHandlers(bot, deps);
  registerCallbackHandlers(bot, deps);

  // grammy rethrows handler errors by default, which would take the process
  // with it. Keep Telegram/RPC error text bounded and redact known secrets.
  bot.catch((err) => {
    console.error(
      `[bot] handler error on update ${err.ctx.update.update_id}: ` +
        safeErrorMessage(err.error, [deps.config.botToken]),
    );
  });

  return bot;
}

/** The poller's send path: one message to the configured chat. */
export function createNotifier(bot: Bot, config: BotConfig) {
  return async (text: string): Promise<void> => {
    await bot.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
  };
}

/** Registers the command list so Telegram's UI offers autocompletion. */
export async function registerCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "What this bot does" },
      { command: "help", description: "Show help" },
      { command: "status", description: "Last-seen ledger and watched contracts" },
      { command: "contracts", description: "Contract ids and explorer links" },
      { command: "health", description: "Health assessment and operational readiness" },
      { command: "preview", description: "Preview channel notification formatting" },
      { command: "pause", description: "Operator only: pause new scans" },
      { command: "resume", description: "Operator only: resume polling now" },
    ]);
  } catch (err) {
    // Cosmetic. Never worth failing a boot over, and never log an unbounded API error.
    console.warn(`[bot] setMyCommands failed: ${safeErrorMessage(err)}`);
  }
}

