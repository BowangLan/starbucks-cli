import type { StarbucksClient } from "./client.js";
import { toOrder } from "./cart.js";
import {
  moneyCents,
  TENDERS,
  validateOrderReference,
  validateRisk,
} from "./order-validation.js";
import type {
  Cart,
  MenuCategory,
  OrderPayment,
  OrderRisk,
  PreparedOrder,
  PriceQuote,
  SubmitOrderRequest,
} from "./types.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const mopAction = (item: RecordValue): RecordValue | undefined =>
  Array.isArray(item.starpayActions)
    ? item.starpayActions.map(record).find((action) => action.type === "MOP")
    : undefined;

/** Only instruments explicitly usable for Mobile Order and Pay are selectable. */
export function orderPayments(wallet: RecordValue): OrderPayment[] {
  if (
    !Array.isArray(wallet.paymentInstruments) ||
    !Array.isArray(wallet.storedValueCards)
  )
    throw new Error("Wallet payment information unavailable");
  const payments: OrderPayment[] = [];
  for (const raw of wallet.paymentInstruments) {
    const item = record(raw),
      action = mopAction(item);
    const tender =
      typeof item.paymentType === "string"
        ? item.paymentType.toUpperCase()
        : "";
    if (
      !action ||
      String(item.instrumentStatusCode).toLowerCase() !== "active" ||
      !TENDERS.has(tender) ||
      tender === "SVC" ||
      typeof item.paymentInstrumentId !== "string" ||
      !item.paymentInstrumentId
    )
      continue;
    payments.push({
      id: item.paymentInstrumentId,
      tender: tender as OrderPayment["tender"],
      lastFour:
        typeof item.accountNumberLastFour === "string"
          ? item.accountNumberLastFour.slice(-4)
          : null,
      default: action.isDefault === true,
    });
  }
  for (const raw of wallet.storedValueCards) {
    const item = record(raw),
      action = mopAction(item),
      balance = record(item.balance);
    if (
      !action ||
      typeof item.cardId !== "string" ||
      !item.cardId ||
      typeof balance.amount !== "number" ||
      !Number.isFinite(balance.amount) ||
      balance.amount < 0 ||
      typeof balance.currency !== "string"
    )
      continue;
    payments.push({
      id: item.cardId,
      tender: "SVC",
      lastFour:
        typeof item.cardNumber === "string" ? item.cardNumber.slice(-4) : null,
      default: action.isDefault === true,
      balance: { amount: balance.amount, currency: balance.currency },
    });
  }
  return payments;
}

export function summarizeOrderPayments(payments: OrderPayment[]) {
  return payments.map(({ id: _id, ...payment }, index) => ({
    index,
    ...payment,
  }));
}

export function validatePreparedOrder(
  prepared: PreparedOrder,
  now = Date.now(),
): void {
  if (
    !prepared ||
    prepared.version !== 1 ||
    prepared.state !== "prepared" ||
    typeof prepared.accountId !== "string" ||
    !prepared.accountId
  )
    throw new Error("Invalid prepared order");
  const order = toOrder(prepared.cart);
  if (JSON.stringify(order) !== JSON.stringify(prepared.pricedOrder))
    throw new Error(
      "Cart or fulfillment changed after pricing; prepare the order again",
    );
  const quote = prepared.quote;
  validateOrderReference(quote?.orderId ?? "", order.storeNumber);
  if (
    quote.__typename !== "PricedOrderV2" ||
    quote.currency !== "USD" ||
    typeof quote.expiresIn !== "number" ||
    !Number.isFinite(quote.expiresIn) ||
    quote.expiresIn <= 0 ||
    !Number.isFinite(prepared.pricedAt) ||
    !Number.isFinite(prepared.expiresAt) ||
    !Number.isFinite(now) ||
    prepared.pricedAt > now ||
    prepared.expiresAt !== prepared.pricedAt + quote.expiresIn * 1000 ||
    now >= prepared.expiresAt
  )
    throw new Error(
      "Order pricing is invalid or expired; prepare the order again",
    );
  const items = quote.cart?.items;
  if (!Array.isArray(items) || items.length !== order.cart.items.length)
    throw new Error("Quoted cart does not match the prepared cart");
  for (const expected of order.cart.items) {
    const matches = items
      .map(record)
      .filter((item) => item.key === expected.key);
    const item = matches[0];
    if (
      matches.length !== 1 ||
      item.sku !== expected.commerce.sku ||
      item.quantity !== expected.quantity ||
      item.isAvailable !== true ||
      item.availability !== "PURCHASABLE"
    )
      throw new Error("An item is unavailable or the quoted cart changed");
  }
  const amount = moneyCents(quote.summary?.price),
    tip = moneyCents(prepared.tipAmount);
  const payment = prepared.payment;
  if (
    !payment ||
    !TENDERS.has(payment.tender) ||
    typeof payment.id !== "string" ||
    !payment.id
  )
    throw new Error("Invalid order payment");
  if (
    payment.tender !== "SVC" &&
    prepared.cart.selectedStore?.acceptsNonSvcMop !== true
  )
    throw new Error(
      "This store has not confirmed support for this payment type",
    );
  if (
    payment.tender === "SVC" &&
    (!payment.balance ||
      payment.balance.currency !== quote.currency ||
      moneyCents(payment.balance.amount) < amount + tip)
  )
    throw new Error(
      "Insufficient Starbucks Card balance; automatic reload is not supported",
    );
}

export interface PrepareOrderOptions {
  /** Index from orderPayments; otherwise use the wallet's single MOP default. */
  paymentIndex?: number;
  tipAmount?: number;
  risk?: OrderRisk;
  now?: () => number;
}

/** Reads only. Pricing is deliberately last to maximize its short validity window. */
export async function prepareOrder(
  client: Pick<
    StarbucksClient,
    | "user"
    | "stores"
    | "menu"
    | "wallet"
    | "rewardPrograms"
    | "pickupEstimate"
    | "quote"
  >,
  input: Cart,
  options: PrepareOrderOptions = {},
): Promise<PreparedOrder> {
  const cart = structuredClone(input);
  toOrder(cart);
  moneyCents(options.tipAmount ?? 0);
  if (options.risk) validateRisk(options.risk);
  if (
    options.paymentIndex !== undefined &&
    (!Number.isSafeInteger(options.paymentIndex) || options.paymentIndex < 0)
  )
    throw new Error("Payment index must be a nonnegative integer");
  const selected = cart.selectedStore;
  if (!selected || selected.storeNumber !== cart.storeNumber)
    throw new Error(
      "Select a pickup café with the store command before preparing an order",
    );
  const user = await client.user();
  if (typeof user.exId !== "string" || !user.exId)
    throw new Error("Consumer sign-in is required");
  const stores = await client.stores(selected.address.singleLine, {
    lat: selected.coordinates.latitude,
    lng: selected.coordinates.longitude,
  });
  const store = stores.find(
    (location) => location.store.storeNumber === cart.storeNumber,
  )?.store;
  if (
    !store ||
    !store.open ||
    store.mobileOrdering?.availability !== "READY" ||
    !store.pickUpOptions?.some(
      (option) => option.code === "16" && option.available,
    )
  )
    throw new Error(
      "Selected café is not available for in-store mobile pickup",
    );
  cart.selectedStore = store;
  const menu = await client.menu(store);
  const products = new Map<string, string | undefined>();
  const visit = (nodes: MenuCategory[]) => {
    for (const node of nodes) {
      for (const product of node.products ?? [])
        products.set(
          `${product.productNumber}/${product.formCode.toLowerCase()}`,
          product.availability,
        );
      visit(node.children ?? []);
    }
  };
  visit(menu.menus);
  for (const item of cart.items)
    if (
      products.get(`${item.productNumber}/${item.formCode.toLowerCase()}`) !==
      "Available"
    )
      throw new Error("A cart product is unavailable at the selected café");
  const payments = orderPayments(await client.wallet(options.risk));
  const defaults = payments.filter((payment) => payment.default);
  const payment =
    options.paymentIndex === undefined
      ? defaults.length === 1
        ? defaults[0]
        : undefined
      : payments[options.paymentIndex];
  if (!payment)
    throw new Error(
      "Select an eligible payment with order payments and --payment-index",
    );
  await client.rewardPrograms();
  const pickupEstimate = await client.pickupEstimate(cart.storeNumber);
  const now = options.now ?? Date.now;
  const pricedAt = now();
  const quote: PriceQuote = await client.quote(cart);
  const prepared: PreparedOrder = {
    version: 1,
    state: "prepared",
    accountId: user.exId,
    cart,
    pricedOrder: toOrder(cart),
    quote,
    pricedAt,
    expiresAt: pricedAt + (quote.expiresIn ?? 0) * 1000,
    payment,
    tipAmount: options.tipAmount ?? 0,
    pickupEstimate,
  };
  validatePreparedOrder(prepared, now());
  return prepared;
}

/** Build the captured submit-order envelope locally, without a network request. */
export function buildSubmissionRequest(
  prepared: PreparedOrder,
  risk: OrderRisk,
  now = Date.now(),
): SubmitOrderRequest {
  validatePreparedOrder(prepared, now);
  validateRisk(risk);
  return {
    variables: {
      subInp: {
        orderId: prepared.quote.orderId!,
        storeNumber: prepared.cart.storeNumber,
        tenders: [
          {
            id: prepared.payment.id,
            tender: prepared.payment.tender,
            amount: prepared.quote.summary.price,
          },
        ],
        tipAmount: prepared.tipAmount,
      },
      risk: structuredClone(risk),
    },
  };
}

export function summarizePreparedOrder(prepared: PreparedOrder) {
  return {
    state: prepared.state,
    orderSubmitted: false,
    orderId: prepared.quote.orderId,
    storeNumber: prepared.cart.storeNumber,
    store: prepared.cart.selectedStore?.name,
    items: prepared.cart.items.map((item) => ({
      name: item.name,
      size: item.sizeCode,
      quantity: item.quantity,
    })),
    currency: prepared.quote.currency,
    amount: prepared.quote.summary.price,
    tipAmount: prepared.tipAmount,
    total:
      (moneyCents(prepared.quote.summary.price) +
        moneyCents(prepared.tipAmount)) /
      100,
    payment: {
      tender: prepared.payment.tender,
      lastFour: prepared.payment.lastFour,
    },
    expiresAt: new Date(prepared.expiresAt).toISOString(),
    pickupEstimate: prepared.pickupEstimate,
  };
}
