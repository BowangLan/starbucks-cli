import type {
  Cart,
  HistoryOptions,
  Menu,
  MenuProduct,
  OrderPickupTime,
  OrderRisk,
  OrderStatus,
  PickupEstimate,
  PriceQuote,
  Product,
  Store,
  StoreLocation,
  SubmitOrderRequest,
  SubmittedOrder,
  TransactionHistory,
} from "./types.js";

export interface LoginCredentials {
  username: string;
  password: string;
}
export interface LoginOptions {
  /** Prepare the sign-in page and stop before sending credentials. */
  prepareOnly?: boolean;
  staySignedIn?: boolean;
  /** Private directory for the attempt cooldown and a redacted trace. Omit to write no files. */
  stateDir?: string;
  onProgress?: (message: string) => void;
  /** Redacted per-request diagnostics. */
  onDiagnostic?: (entry: Record<string, unknown>) => void;
}
export interface LoginResult {
  /** False only for a successful prepareOnly run. */
  authenticated: boolean;
  traceFile?: string;
}

/**
 * Everything the SDK and CLI can do against Starbucks. The client owns its
 * sign-in state: login, importSession, and the cookies every call sends.
 */
export interface StarbucksClient {
  login(
    credentials: LoginCredentials,
    options?: LoginOptions,
  ): Promise<LoginResult>;
  /** Verify exported cookies (jar, storage state, or cookie array) and adopt them. */
  importSession(input: unknown): Promise<void>;
  /** Verify the existing session with get-user and persist returned cookie updates. */
  refreshSession(): Promise<void>;
  hasSession(): Promise<boolean>;
  /** Persist refreshed cookies and release page contexts. */
  close(): Promise<void>;

  // Browsing works with or without a session.
  menu(store?: Store): Promise<Menu>;
  searchMenu(term: string, store?: Store): Promise<MenuProduct[]>;
  product(id: number, form?: string): Promise<Product>;
  stores(
    place: string,
    coordinates?: { lat: number; lng: number },
  ): Promise<StoreLocation[]>;
  pickupEstimate(storeNumber: string): Promise<PickupEstimate>;

  // Account reads require a session.
  user(): Promise<Record<string, unknown>>;
  wallet(risk?: OrderRisk): Promise<Record<string, unknown>>;
  cards(): Promise<unknown>;
  rewardPrograms(): Promise<Record<string, unknown>[]>;
  transactionHistory(options?: HistoryOptions): Promise<TransactionHistory>;
  transactionHistoryPages(
    options?: HistoryOptions,
  ): AsyncIterable<TransactionHistory>;
  historyReceipt(historyId: string): Promise<Record<string, unknown>>;
  giftOrderHistory(): Promise<Record<string, unknown>[]>;
  giftOrderDetails(orderId: string): Promise<Record<string, unknown>>;
  previousOrders(
    storeNumber: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>;

  // Ordering requires a session.
  quote(cart: Cart, mode?: "member" | "guest"): Promise<PriceQuote>;
  orderRisk(): Promise<OrderRisk>;
  /** One attempt only. A timeout or invalid response must be reconciled, never retried. */
  submitOrder(
    request: SubmitOrderRequest,
    options: { confirm: boolean },
  ): Promise<SubmittedOrder>;
  orderPickupTime(
    orderId: string,
    storeNumber: string,
  ): Promise<OrderPickupTime>;
  orderStatus(orderId: string, storeNumber: string): Promise<OrderStatus>;
}
