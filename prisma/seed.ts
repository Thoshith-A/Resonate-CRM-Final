import { resolve } from "node:path";
import { faker } from "@faker-js/faker";
import { PrismaClient, OrderSource, type Prisma } from "@prisma/client";

// Load apps/crm/.env only when DATABASE_URL isn't already provided by the
// shell (so a Neon URL passed in for deploy seeding wins).
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(resolve("apps/crm/.env"));
  } catch {
    // No .env file — rely on the ambient environment.
  }
}

const prisma = new PrismaClient();

// ── Deterministic shaping ───────────────────────────────────────────────
const SEED = 20260611;
const CUSTOMER_COUNT = 8000;
const NOW = new Date("2026-06-11T00:00:00.000Z");
const DAY = 86_400_000;

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Arjun", "Ishaan", "Kabir", "Reyansh", "Vihaan",
  "Krishna", "Rohan", "Ananya", "Diya", "Aadhya", "Saanvi", "Aarohi", "Anika",
  "Navya", "Myra", "Sara", "Pari", "Riya", "Kiara", "Meera", "Tara",
  "Ayaan", "Dhruv", "Karthik", "Nikhil", "Rahul", "Siddharth", "Varun", "Yash",
  "Priya", "Neha", "Sneha", "Pooja", "Divya", "Shreya", "Nisha", "Ritika",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Iyer", "Nair", "Menon", "Reddy", "Rao",
  "Patel", "Shah", "Mehta", "Desai", "Joshi", "Kulkarni", "Deshpande", "Pillai",
  "Banerjee", "Chatterjee", "Das", "Bose", "Khanna", "Kapoor", "Malhotra", "Chopra",
  "Singh", "Chauhan", "Naidu", "Pawar", "Bhat", "Saxena",
];
// Cities weighted by repetition (Mumbai/Delhi/Bangalore lead).
const CITIES = [
  "Mumbai", "Mumbai", "Mumbai", "Mumbai",
  "Delhi", "Delhi", "Delhi",
  "Bangalore", "Bangalore", "Bangalore",
  "Pune", "Pune",
  "Hyderabad", "Hyderabad",
  "Chennai", "Kolkata", "Ahmedabad", "Jaipur", "Surat", "Lucknow",
];

type Category = "beans" | "equipment" | "subscription";
type Sku = { name: string; category: Category; min: number; max: number };
// Prices in paise.
const SKUS: Sku[] = [
  { name: "Single-Origin Arabica 250g", category: "beans", min: 45000, max: 90000 },
  { name: "Estate Reserve Beans 500g", category: "beans", min: 90000, max: 160000 },
  { name: "Decaf Swiss Water 250g", category: "beans", min: 50000, max: 85000 },
  { name: "Espresso Blend 1kg", category: "beans", min: 140000, max: 220000 },
  { name: "Pour-Over Kit", category: "equipment", min: 180000, max: 320000 },
  { name: "Conical Burr Grinder", category: "equipment", min: 350000, max: 600000 },
  { name: "AeroPress Go", category: "equipment", min: 300000, max: 450000 },
  { name: "Gooseneck Kettle", category: "equipment", min: 250000, max: 480000 },
  { name: "Monthly Beans Subscription", category: "subscription", min: 80000, max: 140000 },
  { name: "Equipment Care Subscription", category: "subscription", min: 120000, max: 200000 },
];

type Archetype = "vip" | "lapsed_vip" | "lapsed" | "one_time" | "regular";

/** Pick an archetype with the SPEC's deliberate base shape. */
function pickArchetype(): Archetype {
  const roll = faker.number.float({ min: 0, max: 1 });
  if (roll < 0.08) return "vip"; // active high-value
  if (roll < 0.12) return "lapsed_vip"; // high spenders gone quiet (the money moment)
  if (roll < 0.38) return "lapsed"; // ~26% lapsed (plus lapsed_vip => ~30% total)
  if (roll < 0.53) return "one_time"; // ~15%
  return "regular";
}

type OrderPlan = { count: number; recencyDays: [number, number]; premium: boolean };

function planFor(archetype: Archetype): OrderPlan {
  switch (archetype) {
    case "vip":
      return { count: faker.number.int({ min: 5, max: 12 }), recencyDays: [1, 55], premium: true };
    case "lapsed_vip":
      return { count: faker.number.int({ min: 5, max: 11 }), recencyDays: [95, 260], premium: true };
    case "lapsed":
      return { count: faker.number.int({ min: 1, max: 6 }), recencyDays: [95, 420], premium: false };
    case "one_time":
      return { count: 1, recencyDays: [10, 500], premium: false };
    case "regular":
      return { count: faker.number.int({ min: 1, max: 6 }), recencyDays: [1, 80], premium: false };
  }
}

function tagsFor(archetype: Archetype): string[] {
  const tags: string[] = [];
  if (archetype === "vip" || archetype === "lapsed_vip") {
    if (faker.datatype.boolean(0.7)) tags.push("subscriber");
    if (faker.datatype.boolean(0.2)) tags.push("wholesale");
  }
  if (faker.datatype.boolean(0.15)) tags.push("gifted");
  return tags;
}

function makeOrderItems(premium: boolean): { items: Prisma.InputJsonValue; amount: number } {
  const count = faker.number.int({ min: 1, max: 3 });
  const items: { name: string; category: Category; qty: number; price: number }[] = [];
  let amount = 0;
  for (let i = 0; i < count; i += 1) {
    const pool = premium
      ? SKUS
      : SKUS.filter((s) => s.category !== "equipment" || faker.datatype.boolean(0.3));
    const sku = faker.helpers.arrayElement(pool.length ? pool : SKUS);
    const qty = faker.number.int({ min: 1, max: sku.category === "equipment" ? 1 : 3 });
    const price = faker.number.int({ min: sku.min, max: sku.max });
    items.push({ name: sku.name, category: sku.category, qty, price });
    amount += qty * price;
  }
  return { items: items as unknown as Prisma.InputJsonValue, amount };
}

/** Seasonal bump: orders cluster toward Indian festive months (Oct–Dec). */
function placedAtWithin(recencyDays: [number, number]): Date {
  const base = faker.number.int({ min: recencyDays[0], max: recencyDays[1] });
  const date = new Date(NOW.getTime() - base * DAY);
  const month = date.getUTCMonth();
  // Nudge a slice of orders into the festive window for visible seasonality.
  if ((month === 0 || month === 5) && faker.datatype.boolean(0.35)) {
    return new Date(date.getTime() - faker.number.int({ min: 80, max: 150 }) * DAY);
  }
  return date;
}

async function main(): Promise<void> {
  faker.seed(SEED);
  console.log("Resetting tables…");
  await prisma.receiptEvent.deleteMany();
  await prisma.communicationLog.deleteMany();
  await prisma.order.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.segment.deleteMany();
  await prisma.customer.deleteMany();

  const customers: Prisma.CustomerCreateManyInput[] = [];
  const orders: Prisma.OrderCreateManyInput[] = [];

  for (let i = 0; i < CUSTOMER_COUNT; i += 1) {
    const id = faker.string.uuid();
    const first = faker.helpers.arrayElement(FIRST_NAMES);
    const last = faker.helpers.arrayElement(LAST_NAMES);
    const city = faker.helpers.arrayElement(CITIES);
    const handle = `${first}.${last}${faker.number.int({ min: 1, max: 999 })}`.toLowerCase();
    const archetype = pickArchetype();
    const plan = planFor(archetype);

    let totalSpend = 0;
    let firstOrderAt: Date | null = null;
    let lastOrderAt: Date | null = null;

    for (let o = 0; o < plan.count; o += 1) {
      const placedAt = placedAtWithin(plan.recencyDays);
      const { items, amount } = makeOrderItems(plan.premium);
      orders.push({
        id: faker.string.uuid(),
        customerId: id,
        amount,
        currency: "INR",
        items,
        placedAt,
        source: OrderSource.ORGANIC,
      });
      totalSpend += amount;
      if (!firstOrderAt || placedAt < firstOrderAt) firstOrderAt = placedAt;
      if (!lastOrderAt || placedAt > lastOrderAt) lastOrderAt = placedAt;
    }

    const createdAt = firstOrderAt
      ? new Date(firstOrderAt.getTime() - faker.number.int({ min: 0, max: 30 }) * DAY)
      : new Date(NOW.getTime() - faker.number.int({ min: 1, max: 540 }) * DAY);

    customers.push({
      id,
      externalId: `brewline-${i + 1}`,
      name: `${first} ${last}`,
      email: `${handle}@${faker.helpers.arrayElement(["gmail.com", "outlook.com", "yahoo.in", "proton.me"])}`,
      phone: `+9198${faker.string.numeric(8)}`,
      city,
      tags: tagsFor(archetype),
      totalSpend,
      orderCount: plan.count,
      avgOrderValue: plan.count > 0 ? Math.round(totalSpend / plan.count) : 0,
      firstOrderAt,
      lastOrderAt,
      createdAt,
    });
  }

  console.log(`Inserting ${customers.length} customers…`);
  for (let i = 0; i < customers.length; i += 1000) {
    await prisma.customer.createMany({ data: customers.slice(i, i + 1000) });
  }

  console.log(`Inserting ${orders.length} orders…`);
  for (let i = 0; i < orders.length; i += 5000) {
    await prisma.order.createMany({ data: orders.slice(i, i + 5000) });
  }

  const lapsedHighSpenders = customers.filter(
    (c) =>
      c.totalSpend >= 500000 &&
      c.lastOrderAt instanceof Date &&
      NOW.getTime() - c.lastOrderAt.getTime() > 90 * DAY,
  ).length;

  console.log("Seed complete.");
  console.log(`  customers: ${customers.length}`);
  console.log(`  orders:    ${orders.length}`);
  console.log(`  "high spenders gone quiet" (>₹5,000 & 90d+ silent): ${lapsedHighSpenders}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
