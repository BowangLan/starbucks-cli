#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs/promises";
import { CookieJar } from "tough-cookie";
import { importCookieJar } from "./auth.js";
import { writePrivate } from "./files.js";
import { StarbucksClient, HttpTransport } from "./client.js";
import {
  createItem,
  toOrder,
  createCart,
  addItem,
  decreaseItem,
  setItemQuantity,
} from "./cart.js";
import { preflight, summarizeWallet } from "./preflight.js";
import {
  buildSubmissionRequest,
  orderPayments,
  prepareOrder,
  summarizeOrderPayments,
  summarizePreparedOrder,
  validatePreparedOrder,
} from "./order.js";
import type {
  Cart,
  OptionCategory,
  OrderRisk,
  PreparedOrder,
} from "./types.js";
const program = new Command()
  .name("starbucks")
  .description(
    "Starbucks web SDK: browse, customize, review checkout, and check status. Submission requires explicit opt-in.",
  )
  .version("0.1.0")
  .option(
    "--session <file>",
    "private HTTP cookie jar",
    ".starbucks/http-fetch-session.json",
  )
  .option("--cart <file>", "local SDK cart", ".starbucks/http-cart.json");
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function session<T>(
  fn: (client: StarbucksClient) => Promise<T>,
  allowOrderSubmission = false,
): Promise<T> {
  const file = program.opts().session;
  let jar: CookieJar;
  try {
    jar = await CookieJar.deserialize(
      JSON.parse(await fs.readFile(file, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "No HTTP session. Use bun run auth:fetch or auth import --file <file>.",
      );
    throw new Error("Invalid HTTP cookie jar");
  }
  const transport = new HttpTransport({
    cookieJar: jar,
    allowOrderSubmission,
  });
  try {
    return await fn(new StarbucksClient(transport));
  } finally {
    await transport.close();
    await writePrivate(file, await jar.serialize());
  }
}
async function readCart(): Promise<Cart> {
  try {
    return JSON.parse(await fs.readFile(program.opts().cart, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createCart();
    throw error;
  }
}
async function saveCart(cart: Cart): Promise<void> {
  await writePrivate(program.opts().cart, cart);
}
const api = new StarbucksClient();
program
  .command("stores")
  .requiredOption("--place <place>")
  .option("--lat <number>")
  .option("--lng <number>")
  .action(async (o) => {
    if ((o.lat === undefined) !== (o.lng === undefined))
      throw new Error("Provide both --lat and --lng");
    const stores = await api.stores(
      o.place,
      o.lat === undefined
        ? undefined
        : { lat: Number(o.lat), lng: Number(o.lng) },
    );
    print(
      stores.map((s) => ({
        storeNumber: s.store.storeNumber,
        name: s.store.name,
        address: s.store.address.singleLine,
        distance: s.distance,
        open: s.store.open,
        mobileOrdering: s.store.mobileOrdering,
      })),
    );
  });
program
  .command("menu")
  .option("--search <term>")
  .option("--selected-store", "use the pickup café saved by the store command")
  .action(async (o) => {
    const current = o.selectedStore ? await readCart() : undefined;
    const store = current?.selectedStore;
    if (
      o.selectedStore &&
      (!store || store.storeNumber !== current?.storeNumber)
    )
      throw new Error("Select a pickup café with the store command first");
    print(
      o.search ? await api.searchMenu(o.search, store) : await api.menu(store),
    );
  });
program
  .command("product")
  .argument("<id>")
  .option("--form <form>", "product form", "hot")
  .option("--options", "show sizes and customization options")
  .action(async (id, o) => {
    const p = await api.product(Number(id), o.form);
    if (!o.options) {
      print(p);
      return;
    }
    const categories: unknown[] = [];
    const walk = (cs: OptionCategory[]) => {
      for (const c of cs) {
        if (c.products.length)
          categories.push({
            category: c.name,
            options: c.products.map((p) => ({
              id: p.productNumber,
              name: p.form.name,
              form: p.form.formCode,
              sizes: p.form.sizes,
            })),
          });
        walk(c.children ?? []);
      }
    };
    walk(p.productOptions);
    print({
      id: p.productNumber,
      name: p.name,
      sizes: p.sizes.map((s) => ({
        name: s.name,
        sku: s.sku,
        default: s.default,
      })),
      categories,
    });
  });
const auth = program.command("auth");
auth.command("status").action(() =>
  session(async (s) => {
    await s.user();
    print({ authenticated: true, session: program.opts().session });
  }),
);
program
  .command("whoami")
  .description("Show the signed-in user profile")
  .action(() => session(async (s) => print(await s.user())));
auth
  .command("import")
  .requiredOption(
    "--file <file>",
    "cookie jar, storage-state JSON, or exported cookie array",
  )
  .action(async (o) => {
    const jar = await importCookieJar(
      JSON.parse(await fs.readFile(o.file, "utf8")),
    );
    // Verify via direct fetch before replacing the existing session file.
    await new StarbucksClient(new HttpTransport({ cookieJar: jar })).user();
    await writePrivate(program.opts().session, await jar.serialize());
    print({ authenticated: true, session: program.opts().session });
  });
program.command("cards").action(() =>
  session(async (s) => {
    const cards = await s.cards();
    if (!Array.isArray(cards)) throw new Error("Card list unavailable");
    print(
      cards.map((c) => ({
        nickname: c.nickname,
        lastFour: String(c.cardNumber ?? "").slice(-4),
        isPrimary: c.isPrimary,
        balance: c.balance,
      })),
    );
  }),
);
program.command("wallet").action(() =>
  session(async (s) => {
    const w = await s.wallet();
    print(summarizeWallet(w));
  }),
);
program
  .command("history")
  .description("Read account history, receipts, and eGift orders")
  .option("--offset <number>", "history offset", "0")
  .option("--limit <number>", "history page size, 1–50", "50")
  .option("--all", "read remaining history pages sequentially")
  .option(
    "--receipt <historyId>",
    "read the receipt for an owned history entry",
  )
  .option("--gifts", "read eGift order history")
  .option("--gift-order <orderId>", "read an owned eGift order")
  .option(
    "--output <file>",
    "save the full result privately; print only a summary",
  )
  .action((o) => {
    if ([o.all, o.receipt, o.gifts, o.giftOrder].filter(Boolean).length > 1)
      throw new Error(
        "Choose only one of --all, --receipt, --gifts, or --gift-order",
      );
    return session(async (s) => {
      let result: unknown, summary: Record<string, unknown>;
      if (o.receipt) {
        result = await s.historyReceipt(o.receipt);
        summary = { kind: "receipt", found: true };
      } else if (o.gifts) {
        const orders = await s.giftOrderHistory();
        result = orders;
        summary = { kind: "eGift-history", orderCount: orders.length };
      } else if (o.giftOrder) {
        result = await s.giftOrderDetails(o.giftOrder);
        summary = { kind: "eGift-order", found: true };
      } else {
        const paging = { offset: Number(o.offset), limit: Number(o.limit) };
        if (o.all) {
          const pages = [];
          const historyItems = [];
          for await (const page of s.transactionHistoryPages(paging)) {
            pages.push(page.paging);
            historyItems.push(...page.historyItems);
          }
          result = { pages, historyItems };
          summary = {
            kind: "history",
            pageCount: pages.length,
            itemCount: historyItems.length,
            serverTotal: pages.at(-1)?.total,
          };
        } else {
          const page = await s.transactionHistory(paging);
          result = page;
          summary = {
            kind: "history",
            itemCount: page.historyItems.length,
            paging: page.paging,
          };
        }
      }
      if (o.output) {
        await writePrivate(o.output, result);
        print({ ...summary, outputFile: o.output });
      } else print(result);
    });
  });
program
  .command("store")
  .requiredOption("--place <place>")
  .requiredOption("--name <name>")
  .requiredOption("--lat <number>")
  .requiredOption("--lng <number>")
  .description("Select the pickup café")
  .action(async (o) => {
    const locations = await api.stores(o.place, {
      lat: Number(o.lat),
      lng: Number(o.lng),
    });
    const location = locations.find(
      (l) => l.store.name.toLowerCase() === o.name.toLowerCase(),
    );
    if (!location) throw new Error("Named store not found");
    if (location.store.mobileOrdering?.availability !== "READY")
      throw new Error("Store is not ready for mobile ordering");
    const cart = await readCart();
    cart.storeNumber = location.store.storeNumber;
    cart.selectedStore = location.store;
    await saveCart(cart);
    print({ selected: location.store.name, storeNumber: cart.storeNumber });
  });
const cart = program.command("cart");
cart.command("show").action(async () => print(await readCart()));
cart
  .command("add")
  .requiredOption("--product <id>")
  .option("--form <form>", "product form", "hot")
  .option("--size <size>", "size (defaults to the product default)")
  .option("--milk <milk>")
  .option("--shots <count>")
  .option("--quantity <count>", "quantity", "1")
  .action(async (o) => {
    const product = await api.product(Number(o.product), o.form);
    const result = addItem(
      await readCart(),
      createItem(product, {
        size: o.size,
        milk: o.milk,
        shots: o.shots === undefined ? undefined : Number(o.shots),
        quantity: Number(o.quantity),
      }),
    );
    await saveCart(result);
    print(result);
  });
cart
  .command("decrease")
  .argument("<index>")
  .action(async (index) => {
    const result = decreaseItem(await readCart(), Number(index));
    await saveCart(result);
    print(result);
  });
cart
  .command("quantity")
  .argument("<index>")
  .argument("<count>")
  .description("Set item quantity (0 removes it)")
  .action(async (index, count) => {
    const result = setItemQuantity(
      await readCart(),
      Number(index),
      Number(count),
    );
    await saveCart(result);
    print(result);
  });
cart
  .command("remove")
  .argument("<index>")
  .action(async (index) => {
    const result = setItemQuantity(await readCart(), Number(index), 0);
    await saveCart(result);
    print(result);
  });
cart
  .command("clear")
  .description("Remove all items, keeping the selected café")
  .action(async () => {
    const result = { ...(await readCart()), items: [] };
    await saveCart(result);
    print(result);
  });
cart
  .command("request")
  .description("Preview the pricing request without sending it")
  .action(async () => {
    print({ variables: { order: toOrder(await readCart()) } });
  });
cart
  .command("pickup")
  .description("Read the current pickup estimate for the selected café")
  .action(async () => {
    print(await api.pickupEstimate((await readCart()).storeNumber));
  });
cart
  .command("build")
  .requiredOption("--product <id>")
  .requiredOption("--store <number>", "full store number, such as 114-101752")
  .option("--form <form>", "product form", "hot")
  .option("--size <size>", "size (defaults to the product default)")
  .option("--milk <milk>")
  .option("--shots <count>")
  .option("--quantity <count>", "quantity", "1")
  .option("--out <file>", "local draft cart", ".starbucks/draft-cart.json")
  .action(async (o) => {
    const product = await api.product(Number(o.product), o.form);
    const result: Cart = {
      version: 1,
      storeNumber: o.store,
      items: [
        createItem(product, {
          size: o.size,
          milk: o.milk,
          shots: o.shots === undefined ? undefined : Number(o.shots),
          quantity: Number(o.quantity),
        }),
      ],
    };
    toOrder(result);
    await writePrivate(o.out, result);
    print({ file: o.out, cart: result, localOnly: true });
  });
cart
  .command("quote")
  .option("--file <file>", "price a different local cart file")
  .option("--guest", "explicitly use guest pricing")
  .action((o) =>
    session(async (s) => {
      const input: Cart = o.file
        ? JSON.parse(await fs.readFile(o.file, "utf8"))
        : await readCart();
      const quote = await s.quote(input, o.guest ? "guest" : "member");
      await writePrivate(".starbucks/latest-quote.json", quote);
      print(quote);
    }),
  );
cart
  .command("preflight")
  .description("Check account, price, and wallet; never submit")
  .action(() =>
    session(async (s) => {
      const report = await preflight(s, await readCart());
      print(report);
      if (!report.checksPassed) process.exitCode = 1;
    }),
  );
const order = program
  .command("order")
  .description("Review checkout, build a submit request, or submit an order")
  .action(() => {
    throw new Error(
      "Use order review to review a checkout. No order was placed.",
    );
  });
order
  .command("payments")
  .description(
    "List eligible existing MOP payments with safe selection indexes",
  )
  .option("--risk-file <file>", "optional fresh Web/US risk context")
  .action((o) =>
    session(async (s) => {
      const risk = o.riskFile
        ? JSON.parse(await fs.readFile(o.riskFile, "utf8"))
        : undefined;
      print(summarizeOrderPayments(orderPayments(await s.wallet(risk))));
    }),
  );
order
  .command("review")
  .description("Check checkout details and save a review; stop before submit")
  .option(
    "--payment-index <number>",
    "index from order payments; otherwise use MOP default",
  )
  .option("--tip <amount>", "tip amount", "0")
  .option(
    "--risk-file <file>",
    "optional fresh Web/US risk context for the wallet read",
  )
  .option(
    "--out <file>",
    "private prepared checkout",
    ".starbucks/prepared-order.json",
  )
  .action((o) =>
    session(async (s) => {
      const risk = o.riskFile
        ? (JSON.parse(await fs.readFile(o.riskFile, "utf8")) as OrderRisk)
        : undefined;
      const prepared = await prepareOrder(s, await readCart(), {
        paymentIndex:
          o.paymentIndex === undefined ? undefined : Number(o.paymentIndex),
        tipAmount: Number(o.tip),
        risk,
      });
      await writePrivate(o.out, prepared);
      print({ ...summarizePreparedOrder(prepared), file: o.out });
    }),
  );
order
  .command("build-submit")
  .description("Build the actual submission payload locally; never submit")
  .option(
    "--file <file>",
    "prepared checkout",
    ".starbucks/prepared-order.json",
  )
  .option(
    "--risk-file <file>",
    "optional fresh risk override; otherwise generated from the auth session",
  )
  .option(
    "--out <file>",
    "private submission request",
    ".starbucks/submit-order-request.json",
  )
  .action(async (o) => {
    const prepared = JSON.parse(
      await fs.readFile(o.file, "utf8"),
    ) as PreparedOrder;
    validatePreparedOrder(prepared);
    const risk = o.riskFile
      ? JSON.parse(await fs.readFile(o.riskFile, "utf8"))
      : await session((s) => s.orderRisk());
    const request = buildSubmissionRequest(prepared, risk);
    await writePrivate(o.out, request);
    print({
      ...summarizePreparedOrder(prepared),
      requestFile: o.out,
      ...(o.riskFile
        ? { networkRequests: 0 }
        : { contextGenerated: true, orderApiRequests: 0 }),
    });
  });
order
  .command("status")
  .requiredOption("--id <uuid>", "priced/submitted order ID")
  .requiredOption("--store <number>", "full store number")
  .description("Read the pickup estimate; this is not a ready/collected status")
  .action((o) =>
    session(async (s) => print(await s.orderStatus(o.id, o.store))),
  );
order
  .command("previous")
  .requiredOption("--store <number>", "full store number")
  .option("--limit <number>", "up to 40 previous orders", "40")
  .option("--out <file>", "save full results privately and print a count")
  .action((o) =>
    session(async (s) => {
      const previous = await s.previousOrders(o.store, Number(o.limit));
      if (o.out) {
        await writePrivate(o.out, previous);
        print({ count: previous.length, file: o.out });
      } else print(previous);
    }),
  );
order
  .command("submit")
  .description(
    "Place a real order once; requires --confirm and fresh risk context",
  )
  .option(
    "--file <file>",
    "prepared checkout",
    ".starbucks/prepared-order.json",
  )
  .option(
    "--risk-file <file>",
    "optional fresh risk override; otherwise generated from the auth session",
  )
  .option("--confirm", "authorize the real purchase shown by order review")
  .action(async (o) => {
    if (o.confirm !== true)
      throw new Error("Submission requires --confirm. No order was placed.");
    const prepared = JSON.parse(
      await fs.readFile(o.file, "utf8"),
    ) as PreparedOrder;
    validatePreparedOrder(prepared);
    await session(async (s) => {
      const risk: OrderRisk = o.riskFile
        ? JSON.parse(await fs.readFile(o.riskFile, "utf8"))
        : await s.orderRisk();
      buildSubmissionRequest(prepared, risk);
      const user = await s.user();
      if (user.exId !== prepared.accountId)
        throw new Error("Prepared order belongs to a different account");
      const payment = orderPayments(await s.wallet(risk)).find(
        (p) =>
          p.id === prepared.payment.id && p.tender === prepared.payment.tender,
      );
      if (!payment) throw new Error("Selected payment is no longer available");
      prepared.payment = payment;
      validatePreparedOrder(prepared);
      const request = buildSubmissionRequest(prepared, risk);
      // A durable order-ID journal prevents duplicate attempts across processes/file copies.
      const journal = `.starbucks/order-attempts/${request.variables.subInp.orderId}.json`;
      await fs.mkdir(".starbucks/order-attempts", {
        recursive: true,
        mode: 0o700,
      });
      const attempt = {
        state: "attempted",
        orderId: request.variables.subInp.orderId,
        storeNumber: prepared.cart.storeNumber,
      };
      try {
        await fs.writeFile(journal, JSON.stringify(attempt, null, 2), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(
            "Order submission already attempted. Check order status and history; do not retry.",
          );
        throw error;
      }
      const submitted = await s.submitOrder(request, { confirm: true });
      await writePrivate(journal, submitted);
      // Persist acceptance before attempting a follow-up read that can independently fail.
      await writePrivate(o.file, {
        ...prepared,
        state: "submitted",
        submitted,
      });
      try {
        print({
          ...submitted,
          status: await s.orderStatus(submitted.orderId, submitted.storeNumber),
          journal,
        });
      } catch {
        print({
          ...submitted,
          status: "unavailable",
          note: "Order accepted; check status again without resubmitting.",
          journal,
        });
      }
    }, true);
  });
await program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
