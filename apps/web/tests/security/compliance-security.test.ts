import { createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptSensitiveField } from "@/lib/supa-os/compliance-security";

describe("sensitive-field encryption", () => {
  const key = "ab".repeat(32);

  it("uses authenticated AES-256-GCM encryption and can be decrypted with the field AAD", () => {
    const plaintext = "123456789";
    const encrypted = encryptSensitiveField({ value: plaintext, fieldType: "bvn", encryptionKey: key });
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(encrypted.iv, "base64"));
    decipher.setAAD(Buffer.from("supa-os:bvn", "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
    expect(decrypted).toBe(plaintext);
    expect(encrypted.ciphertext).not.toBe(Buffer.from(plaintext).toString("base64"));
    expect(Buffer.from(encrypted.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(encrypted.tag, "base64")).toHaveLength(16);
  });

  it("generates a unique IV for every encryption", () => {
    const one = encryptSensitiveField({ value: "123456789", fieldType: "bvn", encryptionKey: key });
    const two = encryptSensitiveField({ value: "123456789", fieldType: "bvn", encryptionKey: key });
    expect(one.iv).not.toBe(two.iv);
    expect(one.blindIndex).toBe(two.blindIndex);
  });

  it("rejects tokenized data and malformed keys", () => {
    expect(() => encryptSensitiveField({ value: "4111111111111111", fieldType: "card_number", encryptionKey: key })).toThrow(/must be tokenized/i);
    expect(() => encryptSensitiveField({ value: "123456789", fieldType: "bvn", encryptionKey: "too-short" })).toThrow(/32-byte hexadecimal/i);
  });
});
