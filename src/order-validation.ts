import type { OrderRisk, SubmitOrderRequest } from "./types.js";

export function validateOrderReference(
  orderId: string,
  storeNumber: string,
): void {
  if (
    typeof orderId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      orderId,
    )
  )
    throw new Error("A priced order UUID is required");
  if (typeof storeNumber !== "string" || !/^\d+-\d+$/.test(storeNumber))
    throw new Error("Use a full store number, e.g. 17011-170949");
}

export function moneyCents(value: number): number {
  const cents = Math.round(value * 100);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(cents) ||
    Math.abs(value * 100 - cents) > 0.000001
  )
    throw new Error(
      "Amounts must be nonnegative numbers with at most two decimal places",
    );
  return cents;
}

export const TENDERS = new Set([
  "PAYPAL",
  "VISA",
  "MASTERCARD",
  "AMEX",
  "DISCOVER",
  "VENMO",
  "SVC",
]);

export function validateRisk(risk: OrderRisk): void {
  if (
    !risk ||
    risk.platform !== "Web" ||
    risk.market !== "US" ||
    risk.ccAgentName !== "WebApp" ||
    ![
      risk.deviceFingerprint,
      risk.reputation?.deviceFingerprint,
      risk.reputation?.ubaId,
    ].every((value) => typeof value === "string" && value.trim().length > 0)
  )
    throw new Error(
      "Fresh Web/US device-risk context is required; captured tokens must not be replayed",
    );
}

export function validateSubmissionRequest(request: SubmitOrderRequest): void {
  const input = request?.variables?.subInp;
  if (!input) throw new Error("Missing submission input");
  validateOrderReference(input.orderId, input.storeNumber);
  validateRisk(request.variables.risk);
  if (!Array.isArray(input.tenders) || input.tenders.length !== 1)
    throw new Error("Exactly one existing wallet tender is supported");
  const tender = input.tenders[0];
  if (
    !tender ||
    typeof tender.id !== "string" ||
    !tender.id.trim() ||
    !TENDERS.has(tender.tender)
  )
    throw new Error("Invalid order payment");
  moneyCents(tender.amount);
  moneyCents(input.tipAmount);
}
