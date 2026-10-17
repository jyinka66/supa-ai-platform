import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.EMAIL_FROM ?? "no-reply@supa-ai.example";
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const client = apiKey ? new Resend(apiKey) : null;

/**
 * Sends the workspace-invite email.
 *
 * The raw token is included ONLY in the email link — never logged,
 * never persisted in the database (only sha256(token) is stored).
 *
 * If no RESEND_API_KEY is configured (e.g. local dev), the function
 * logs the URL instead of sending — useful for clicking through during tests.
 */
export async function sendInviteEmail(
  to: string,
  workspaceName: string,
  inviterName: string,
  rawToken: string,
): Promise<void> {
  const acceptUrl = `${appUrl}/invite/accept?token=${rawToken}`;

  if (!client) {
    // Local-dev fallback — print the link so the developer can click through.
    console.info(
      JSON.stringify({
        event: "invite_email_skipped_no_provider",
        to,
        accept_url: acceptUrl,
      }),
    );
    return;
  }

  const { error } = await client.emails.send({
    from: fromAddress,
    to,
    subject: `${inviterName} invited you to join "${workspaceName}"`,
    html: inviteEmailHtml(workspaceName, inviterName, acceptUrl),
    text: `${inviterName} invited you to join "${workspaceName}". Accept: ${acceptUrl}`,
  });

  if (error) {
    console.warn(
      JSON.stringify({
        event: "invite_email_failed",
        to,
        error_code: error.name,
      }),
    );
    throw error;
  }
}

function inviteEmailHtml(workspaceName: string, inviterName: string, acceptUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 40px auto; padding: 0 24px; color: #0a0a0a;">
    <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 16px;">You're invited to ${escapeHtml(workspaceName)}</h1>
    <p style="margin: 0 0 16px; color: #525252; line-height: 1.5;">
      <strong>${escapeHtml(inviterName)}</strong> has invited you to join the workspace
      <strong>${escapeHtml(workspaceName)}</strong>. This invite expires in 7 days.
    </p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(acceptUrl)}"
         style="display: inline-block; padding: 10px 20px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
        Accept invite
      </a>
    </p>
    <p style="margin: 24px 0 0; font-size: 12px; color: #737373; line-height: 1.5;">
      If you weren't expecting this invite, you can ignore this email.
      The link is single-use and bound to your email address.
    </p>
  </body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
