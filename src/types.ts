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
