// Bid approval bot — sends generated proposals to Slack or Telegram for
// human-in-the-loop approval before auto-submitting.
//
// Flow:
//   1. Auto-bid engine generates a proposal (via freelance-ai/proposal.ts)
//   2. If the proposal's confidence is below the auto-submit threshold
//      (e.g. 90%), it goes to this module for human review
//   3. This module formats the proposal as a Slack/Telegram message with
//      [Approve & Send] / [Edit] / [Skip] buttons
//   4. The human clicks a button → the webhook callback updates the
//      proposal status in the DB
//
// Phase 1: we generate the message payloads (Slack Block Kit JSON +
// Telegram message text). We DON'T actually send them (no Slack bot token
// in dev) — the API route handler is responsible for calling the Slack/
// Telegram API with the generated payload.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

// Types — we define local types instead of importing from @supa/freelance-ai
// (which isn't a dependency of the web app). The shapes match.

export interface ProposalDraft {
  coverLetter?: string;
  estimatedBudget?: string;
  estimatedTimeline?: string;
  [key: string]: unknown;
}

export interface BidEvaluation {
  matchScore: number;
  decision: "submit" | "skip";
  [key: string]: unknown;
}

export type ApprovalChannel = "slack" | "telegram";

export type ApprovalAction = "approve" | "edit" | "skip";

export interface ApprovalRequest {
  proposalId: string;
  jobId: string;
  jobTitle: string;
  platform: "upwork" | "fiverr" | "direct" | "other";
  proposal: ProposalDraft;
  evaluation: BidEvaluation;
  /** Where to send the approval request. */
  channel: ApprovalChannel;
  /** Callback URL for the action buttons. */
  callbackUrl: string;
}

export interface ApprovalMessage {
  channel: ApprovalChannel;
  /** Slack: Block Kit JSON payload. Telegram: plain text + inline keyboard JSON. */
  payload: unknown;
  /** Plain-text preview (for logging + testing). */
  preview: string;
}

export interface ApprovalCallback {
  proposalId: string;
  action: ApprovalAction;
  /** If action=edit, the edited proposal text. */
  editedText?: string;
  /** Who approved (admin id). */
  approvedBy: string;
  approvedAt: string;
}

// ───────────────────────────────────────────────
// Slack Block Kit message builder
// ───────────────────────────────────────────────

export function buildSlackApprovalMessage(req: ApprovalRequest): ApprovalMessage {
  const { proposalId, jobId, jobTitle, platform, proposal, evaluation, callbackUrl } = req;
  const scoreEmoji = evaluation.matchScore >= 80 ? "🟢" : evaluation.matchScore >= 60 ? "🟡" : "🔴";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${scoreEmoji} New Proposal Ready for Review` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Job:* ${jobTitle}` },
        { type: "mrkdwn", text: `*Platform:* ${platform}` },
        { type: "mrkdwn", text: `*Match Score:* ${evaluation.matchScore}%` },
        { type: "mrkdwn", text: `*Bid Decision:* ${evaluation.decision}` },
        { type: "mrkdwn", text: `*Budget:* ${proposal.estimatedBudget ?? "TBD"}` },
        { type: "mrkdwn", text: `*Timeline:* ${proposal.estimatedTimeline ?? "TBD"}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Proposal Draft:*\n>>> ${proposal.coverLetter?.slice(0, 800) ?? "No cover letter"}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Approve & Send" },
          style: "primary",
          url: `${callbackUrl}?proposalId=${proposalId}&action=approve`,
          action_id: `approve_${proposalId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✏️ Edit" },
          url: `${callbackUrl}?proposalId=${proposalId}&action=edit`,
          action_id: `edit_${proposalId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "⏭️ Skip" },
          style: "danger",
          url: `${callbackUrl}?proposalId=${proposalId}&action=skip`,
          action_id: `skip_${proposalId}`,
        },
      ],
    },
  ];

  const preview = `[${scoreEmoji} ${evaluation.matchScore}%] ${jobTitle} on ${platform}\n\n${proposal.coverLetter?.slice(0, 500) ?? ""}\n\nButtons: Approve & Send | Edit | Skip`;

  return {
    channel: "slack",
    payload: { text: `Proposal for ${jobTitle}`, blocks },
    preview,
  };
}

// ───────────────────────────────────────────────
// Telegram message builder
// ───────────────────────────────────────────────

export function buildTelegramApprovalMessage(req: ApprovalRequest): ApprovalMessage {
  const { proposalId, jobTitle, platform, proposal, evaluation, callbackUrl } = req;
  const scoreEmoji = evaluation.matchScore >= 80 ? "🟢" : evaluation.matchScore >= 60 ? "🟡" : "🔴";

  const text = [
    `${scoreEmoji} *New Proposal Ready for Review*`,
    ``,
    `*Job:* ${jobTitle}`,
    `*Platform:* ${platform}`,
    `*Match Score:* ${evaluation.matchScore}%`,
    `*Bid Decision:* ${evaluation.decision}`,
    `*Budget:* ${proposal.estimatedBudget ?? "TBD"}`,
    ``,
    `*Proposal Draft:*`,
    `${proposal.coverLetter?.slice(0, 1000) ?? "No cover letter"}`,
    ``,
    `Tap a button to continue:`,
  ].join("\n");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Approve & Send", callback_data: `approve:${proposalId}` },
        { text: "✏️ Edit", callback_data: `edit:${proposalId}` },
      ],
      [
        { text: "⏭️ Skip", callback_data: `skip:${proposalId}` },
      ],
    ],
  };

  // Telegram doesn't support URL buttons in inline keyboards for callback_data,
  // so we include the callback URL as a separate text line.
  const fullText = `${text}\n\n_${callbackUrl}_`;

  return {
    channel: "telegram",
    payload: {
      text: fullText,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    },
    preview: fullText,
  };
}

// ───────────────────────────────────────────────
// Dispatcher
// ───────────────────────────────────────────────

export function buildApprovalMessage(req: ApprovalRequest): ApprovalMessage {
  switch (req.channel) {
    case "slack":
      return buildSlackApprovalMessage(req);
    case "telegram":
      return buildTelegramApprovalMessage(req);
    default:
      throw new Error(`Unknown approval channel: ${req.channel as string}`);
  }
}

// ───────────────────────────────────────────────
// Callback parser — parses the action from a Slack/Telegram callback.
// ───────────────────────────────────────────────

export function parseApprovalCallback(
  rawCallback: string,
  channel: ApprovalChannel,
): { proposalId: string; action: ApprovalAction } | null {
  // Slack: callback_data = "approve_<proposalId>" (from action_id)
  // Telegram: callback_data = "approve:<proposalId>"
  if (channel === "slack") {
    const match = rawCallback.match(/^(approve|edit|skip)_(.+)$/);
    if (!match || !match[1] || !match[2]) return null;
    return { action: match[1] as ApprovalAction, proposalId: match[2] };
  }
  if (channel === "telegram") {
    const match = rawCallback.match(/^(approve|edit|skip):(.+)$/);
    if (!match || !match[1] || !match[2]) return null;
    return { action: match[1] as ApprovalAction, proposalId: match[2] };
  }
  return null;
}
