// GET /api/supa-os/catalog/payment-gateways
//
// Returns the payment gateway catalog (Stripe, PayPal, Flutterwave, Paystack,
// Mpesa, Razorpay, Square, Adyen, etc.) used by fintech builds.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { PAYMENT_GATEWAYS } from "@/lib/supa-os/fintech-primitives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    gateways: PAYMENT_GATEWAYS,
    total: PAYMENT_GATEWAYS.length,
  });
});
