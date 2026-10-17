// POST /api/supa-os/compliance/encrypt
//
// Encrypts a sensitive field using AES-256-GCM. Used by fintech builds that
// handle PII (BVN, NIN, SSN, card numbers, etc.) — never store these raw.
//
// Body:
//   value: string (the raw value; JavaScript strings cannot be reliably zeroized)
//   fieldType: SensitiveFieldType enum
//   The encryption key is read from SENSITIVE_DATA_ENCRYPTION_KEY on the server.
//   Client-supplied keys are never accepted or logged.
//
// Returns:
//   { encrypted: string, iv: string, tag: string, fieldType, algorithm: "aes-256-gcm" }
//
// Auth: admin (senior — encryption keys are sensitive).

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { ApiError } from "@/lib/http/middleware";
import { encryptSensitiveField, SENSITIVE_FIELDS } from "@/lib/supa-os/compliance-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fieldTypeEnum = z.enum([
  "ssn", "bvn", "nin", "credit_score", "credit_rating", "bank_account",
  "card_number", "card_cvv", "date_of_birth", "national_id", "tax_id",
  "salary", "api_key", "private_key",
]);

const BodySchema = z.object({
  value: z.string().min(1).max(2048),
  fieldType: fieldTypeEnum,
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  // Reject tokenized field types — they must never be stored locally.
  const config = SENSITIVE_FIELDS.find((f) => f.type === body.fieldType);
  if (config?.tokenized) {
    throw new ApiError("field_must_be_tokenized", 400, {
      fieldType: body.fieldType,
      hint: "Use the payment provider's tokenization API — never store this field locally.",
    });
  }

  const encryptionKey = process.env.SENSITIVE_DATA_ENCRYPTION_KEY;
  if (!encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    throw new ApiError("encryption_not_configured", 503, {
      hint: "Configure SENSITIVE_DATA_ENCRYPTION_KEY as 64 hex characters in the server secret store.",
    });
  }

  const result = encryptSensitiveField({
    value: body.value,
    fieldType: body.fieldType,
    encryptionKey,
  });

  return okResponse({
    encrypted: result.ciphertext,
    iv: result.iv,
    tag: result.tag,
    fieldType: body.fieldType,
    algorithm: "aes-256-gcm",
    encryptedBy: ctx.admin!.adminId,
    encryptedAt: new Date().toISOString(),
  });
});
