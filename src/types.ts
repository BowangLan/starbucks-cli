export interface MenuProduct {
  productNumber: number;
  name: string;
  formCode: string;
  availability?: string;
  uri?: string;
  defaultSize?: { sku: string; displayName: string };
}
export interface MenuCategory {
  name: string;
  id?: string;
  uri?: string;
  categoryImageURL?: string | null;
  products: MenuProduct[];
  children: MenuCategory[];
}
export interface Menu {
  menus: MenuCategory[];
}
export interface OptionSize {
  sku: string;
  sizeCode: string;
  name?: string;
  default?: boolean;
}
export interface ProductOption {
  productNumber: number;
  form: {
    name: string;
    formCode: string;
    availability?: string;
    sizes: OptionSize[];
  };
}
export interface OptionCategory {
  categoryNumber: number;
  name: string;
  products: ProductOption[];
  children?: OptionCategory[];
}
export interface RecipeOption {
  productOption: { productNumber: number; form: { sizes: OptionSize[] } };
  formCode: string;
  quantity: number;
  sizeCode: string;
}
export interface ProductSize {
  sku: string;
  name: string;
  sizeCode: string;
  default?: boolean;
  recipe?: { default: RecipeOption[] };
  nutrition?: unknown | null;
}
export interface Product extends MenuProduct {
  productOptions: OptionCategory[];
  sizes: ProductSize[];
  description?: string;
}
export interface Store {
  id: string;
  storeNumber: string;
  name: string;
  ownershipTypeCode: string;
  open: boolean;
  address: { singleLine: string };
  coordinates: { latitude: number; longitude: number };
  timeZone?: { timeZoneId: string };
  mobileOrdering?: { availability: string; guestOrdering?: boolean };
  pickUpOptions?: Array<{ code: string; available: boolean }>;
  acceptsNonSvcMop?: boolean;
}
export interface StoreLocation {
  distance: number;
  store: Store;
}
export interface Modifier {
  productNumber: number;
  name: string;
  sku: string;
  sizeCode: string;
  quantity: number;
}
export interface CartItem {
  key: string;
  productNumber: number;
  name: string;
  formCode: string;
  sizeCode: string;
  sku: string;
  quantity: number;
  modifiers: Modifier[];
}
export interface Cart {
  version: 1;
  storeNumber: string;
  items: CartItem[];
  selectedStore?: Store;
}
export interface OrderInput {
  cart: {
    items: Array<{
      key: string;
      quantity: number;
      commerce: { sku: string };
      childItems: Array<{ quantity: number; commerce: { sku: string } }>;
    }>;
    offers: unknown[];
  };
  fulfillment: {
    consumptionType: "CONSUME_OUT_OF_STORE";
    collectionType: "IN_STORE";
  };
  storeNumber: string;
  enableTransparentPricing: true;
  enableNextGenLoyalty: true;
}
export interface PriceQuote {
  __typename: string;
  orderId?: string;
  expiresIn?: number;
  currency?: string;
  cart: { items: unknown[] };
  summary: {
    price: number;
    priceLabel: string;
    lineItems: Array<{ key: string; price: number; priceLabel: string }>;
  };
}
export interface Transport {
  request(path: string, body?: unknown): Promise<unknown>;
}

export interface HistoryOptions {
  offset?: number;
  /** The client supports the captured page size of up to 50 records. */
  limit?: number;
}
export interface HistoryPaging {
  total: number;
  offset: number;
  limit: number;
  /** Advance by this value; it can exceed historyItems.length. */
  returned: number;
}
export interface TransactionHistory {
  paging: HistoryPaging;
  historyItems: Array<Record<string, unknown>>;
}

/** Raw estimate values as returned by Starbucks; no inferred unit conversion. */
export interface PickupEstimate {
  locationId: string;
  preOrderEstimateMin: number;
  preOrderEstimateMax: number;
  preOrderEstimate: number;
}
export interface PreflightCheck {
  step: "account" | "store" | "availability" | "pickup" | "quote" | "wallet";
  status: "passed" | "failed" | "skipped";
  detail?: unknown;
  error?: string;
  httpStatus?: number;
}
export interface PreflightReport {
  checks: PreflightCheck[];
  checksPassed: boolean;
  orderSubmitted: false;
  note: string;
}

/** Fresh, caller-supplied context from the current Starbucks web session. */
export interface OrderRisk {
  ccAgentName: "WebApp";
  platform: "Web";
  market: "US";
  deviceFingerprint: string;
  reputation: { deviceFingerprint: string; ubaId: string };
}
export interface OrderPayment {
  id: string;
  tender:
    | "PAYPAL"
    | "VISA"
    | "MASTERCARD"
    | "AMEX"
    | "DISCOVER"
    | "VENMO"
    | "SVC";
  lastFour: string | null;
  default: boolean;
  balance?: { amount: number; currency: string };
}
export interface PreparedOrder {
  version: 1;
  state: "prepared";
  accountId: string;
  cart: Cart;
  /** Exact cart/fulfillment input whose pricing produced quote.orderId. */
  pricedOrder: OrderInput;
  quote: PriceQuote;
  /** Epoch milliseconds; expiresIn from pricing is in seconds. */
  pricedAt: number;
  expiresAt: number;
  payment: OrderPayment;
  tipAmount: number;
  pickupEstimate: PickupEstimate;
}
export interface SubmitOrderRequest {
  variables: {
    subInp: {
      orderId: string;
      storeNumber: string;
      tenders: Array<{
        id: string;
        tender: OrderPayment["tender"];
        amount: number;
      }>;
      tipAmount: number;
    };
    risk: OrderRisk;
  };
}
export interface SubmittedOrder {
  state: "submitted";
  orderId: string;
  storeNumber: string;
  serviceTime: { __typename: "ServiceTime" };
}
/** This endpoint reports an estimate, not a ready/collected lifecycle status. */
export interface OrderPickupTime {
  orderId: string;
  locationId: string;
  pickupTime: string;
  waitTimeEstimate: number;
  waitTimeEstimateMin: number;
  waitTimeEstimateMax: number;
  source: string;
  channel: string;
  created: string;
  orderCreated: string;
}
export interface OrderStatus {
  orderId: string;
  storeNumber: string;
  status: "pickup-estimate-available";
  pickup: OrderPickupTime;
}
