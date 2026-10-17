// POST /api/supa-os/compliance/mask
//
// Masks a sensitive field for display (e.g. show last 4 digits of card
// number). Read-only — never logs the raw value.
//
// Body:
//   value: string
//   fieldType: SensitiveFieldType enum
//
// Returns: { masked: string, fieldType }
//
// Auth: admin (read_only — masking is read-only but PII access still requires admin).

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { maskSensitiveField } from "@/lib/supa-os/compliance-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  value: z.string().min(1).max(2048),
  fieldType: z.enum([
    "ssn", "bvn", "nin", "credit_score", "credit_rating", "bank_account",
    "card_number", "card_cvv", "date_of_birth", "national_id", "tax_id",
    "salary", "api_key", "private_key",
  ]),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const masked = maskSensitiveField({
    value: body.value,
    fieldType: body.fieldType,
  });
  return okResponse({ masked, fieldType: body.fieldType });
});
