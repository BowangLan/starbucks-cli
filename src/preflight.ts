import { StarbucksError } from "./errors.js";
import type { StarbucksClient } from "./client.js";
import type { Cart, PreflightCheck, PreflightReport } from "./types.js";

/** Select display fields explicitly so wallet tokens and full card numbers stay private. */
export function summarizeWallet(wallet: Record<string, unknown>) {
  if (
    !Array.isArray(wallet.paymentInstruments) ||
    !Array.isArray(wallet.storedValueCards)
  )
    throw new StarbucksError("Wallet payment information unavailable");
  return {
    paymentInstruments: wallet.paymentInstruments.map((instrument: unknown) => {
      if (!instrument || typeof instrument !== "object")
        throw new StarbucksError("Invalid payment instrument");
      const item = instrument as Record<string, unknown>;
      return {
        paymentType:
          typeof item.paymentType === "string" ? item.paymentType : null,
        lastFour:
          typeof item.accountNumberLastFour === "string"
            ? item.accountNumberLastFour.slice(-4)
            : null,
        default: item.default === true,
        status:
          typeof item.instrumentStatusCode === "string"
            ? item.instrumentStatusCode
            : null,
      };
    }),
    storedValueCardCount: wallet.storedValueCards.length,
  };
}

/** Run the documented account, quote, and wallet reads; stop requests at the first failure. */
export async function preflight(
  client: Pick<StarbucksClient, "user" | "quote" | "wallet">,
  cart: Cart,
): Promise<PreflightReport> {
  const steps: Array<{
    step: PreflightCheck["step"];
    run: () => Promise<unknown>;
  }> = [
    {
      step: "account",
      run: async () => {
        await client.user();
        return { authenticated: true };
      },
    },
    {
      step: "quote",
      run: async () => {
        const quote = await client.quote(cart);
        return { currency: quote.currency, summary: quote.summary };
      },
    },
    { step: "wallet", run: async () => summarizeWallet(await client.wallet()) },
  ];
  const checks: PreflightCheck[] = [];
  let failed = false;
  for (const { step, run } of steps) {
    if (failed) {
      checks.push({ step, status: "skipped" });
      continue;
    }
    try {
      checks.push({ step, status: "passed", detail: await run() });
    } catch (error) {
      failed = true;
      checks.push({
        step,
        status: "failed",
        error: error instanceof Error ? error.message : "Check failed",
        ...(error instanceof StarbucksError && error.status !== undefined
          ? { httpStatus: error.status }
          : {}),
      });
    }
  }
  return {
    checks,
    checksPassed: !failed,
    orderSubmitted: false,
    note: "Account, pricing, and wallet reads only; checkout acceptance is not verified.",
  };
}
