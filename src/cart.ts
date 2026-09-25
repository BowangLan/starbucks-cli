import type {
  Cart,
  CartItem,
  Modifier,
  OptionCategory,
  OrderInput,
  Product,
} from "./types.js";
export interface Customization {
  size?: string;
  milk?: string;
  shots?: number;
  quantity?: number;
}
export function createItem(
  product: Product,
  options: Customization = {},
): CartItem {
  const size = options.size
    ? product.sizes.find(
        (s) => s.sizeCode.toLowerCase() === options.size!.toLowerCase(),
      )
    : (product.sizes.find((s) => s.default) ?? product.sizes[0]);
  if (!size) throw new Error(`Unknown size: ${options.size}`);
  const quantity = options.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)
    throw new Error("Quantity must be an integer from 1 to 20");
  const categories: OptionCategory[] = [];
  const visit = (xs: OptionCategory[]) => {
    for (const x of xs) {
      categories.push(x);
      visit(x.children ?? []);
    }
  };
  visit(product.productOptions);
  const modifiers: Modifier[] = [];
  if (options.milk) {
    const group = categories.find((c) => c.name === "Milk Options");
    const milk = group?.products.find(
      (p) => p.form.name.toLowerCase() === options.milk!.toLowerCase(),
    );
    const selected = milk?.form.sizes.find((s) => s.sizeCode === "add");
    if (!milk || !selected)
      throw new Error(`Unsupported milk: ${options.milk}`);
    const isDefault = size.recipe?.default.some(
      (r) => r.productOption.productNumber === milk.productNumber,
    );
    if (!isDefault)
      modifiers.push({
        productNumber: milk.productNumber,
        name: milk.form.name,
        sku: selected.sku,
        sizeCode: selected.sizeCode,
        quantity: 1,
      });
  }
  if (options.shots !== undefined) {
    if (
      !Number.isInteger(options.shots) ||
      options.shots < 1 ||
      options.shots > 12
    )
      throw new Error("Shots must be an integer from 1 to 12");
    const shot = categories
      .flatMap((c) => c.products)
      .find((p) => p.form.name === "Shots");
    const selected = shot?.form.sizes.find((s) => s.sizeCode === "add");
    if (!shot || !selected) throw new Error("This product has no Shots option");
    const defaultShots = size.recipe?.default.find(
      (r) => r.productOption.productNumber === shot.productNumber,
    )?.quantity;
    if (options.shots !== defaultShots)
      modifiers.push({
        productNumber: shot.productNumber,
        name: shot.form.name,
        sku: selected.sku,
        sizeCode: selected.sizeCode,
        quantity: options.shots,
      });
  }
  modifiers.sort((a, b) => a.productNumber - b.productNumber);
  const formCode = product.formCode.toLowerCase();
  const key =
    `${product.productNumber}/${formCode}:${size.sizeCode}` +
    modifiers
      .map(
        (m) => `::${m.productNumber}(${m.quantity})(${m.sizeCode.charAt(0)})`,
      )
      .join("");
  return {
    key,
    productNumber: product.productNumber,
    name: product.name,
    formCode,
    sizeCode: size.sizeCode,
    sku: size.sku,
    quantity,
    modifiers,
  };
}
export function toOrder(cart: Cart): OrderInput {
  if (cart.version !== 1 || !/^\d+-\d+$/.test(cart.storeNumber))
    throw new Error("Use a full store number, e.g. 114-101752");
  if (!cart.items.length) throw new Error("Cart is empty");
  for (const item of cart.items) {
    if (
      !/^\d+$/.test(item.sku) ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 20
    )
      throw new Error("Invalid cart item");
    for (const m of item.modifiers)
      if (
        !/^\d+$/.test(m.sku) ||
        !Number.isInteger(m.quantity) ||
        m.quantity < 1 ||
        m.quantity > 12
      )
        throw new Error("Invalid modifier");
  }
  return {
    cart: {
      items: cart.items.map((i, index) => ({
        quantity: i.quantity,
        commerce: { sku: i.sku },
        childItems: i.modifiers.map((m) => ({
          quantity: m.quantity,
          commerce: { sku: m.sku },
        })),
        key: `${i.key}-${index}`,
      })),
      offers: [],
    },
    fulfillment: {
      consumptionType: "CONSUME_OUT_OF_STORE",
      collectionType: "IN_STORE",
    },
    storeNumber: cart.storeNumber,
    enableTransparentPricing: true,
    enableNextGenLoyalty: true,
  };
}

/** Starbucks' web cart is client-side state, not a server-side cart resource. */
export function createCart(storeNumber = ""): Cart {
  if (storeNumber && !/^\d+-\d+$/.test(storeNumber))
    throw new Error("Use a full store number, e.g. 114-101752");
  return { version: 1, storeNumber, items: [] };
}
export function addItem(cart: Cart, item: CartItem): Cart {
  const next = structuredClone(cart);
  const existing = next.items.find((i) => i.key === item.key);
  if (existing) existing.quantity += item.quantity;
  else next.items.push(structuredClone(item));
  // Validate items even before a pickup café has been chosen.
  toOrder({ ...next, storeNumber: next.storeNumber || "0-0" });
  return next;
}
export function decreaseItem(cart: Cart, index: number): Cart {
  if (!Number.isInteger(index) || index < 0 || index >= cart.items.length)
    throw new Error("Invalid cart item index");
  const next = structuredClone(cart);
  if (--next.items[index].quantity === 0) next.items.splice(index, 1);
  return next;
}
