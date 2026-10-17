export const AUTH_CONFIG = {
  mfaRequired: ["owner", "admin"] as const,
  inviteTokenTtlDays: 7,
  deletionGraceDays: 30,
  rateLimits: {
    login: { points: 5, durationSec: 300 },       // per IP+email
    signup: { points: 3, durationSec: 3600 },     // per IP
    magicLink: { points: 5, durationSec: 600 },
    otp: { points: 5, durationSec: 600 },
    inviteAccept: { points: 10, durationSec: 600 },
  },
} as const;
