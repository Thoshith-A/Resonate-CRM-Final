import { describe, expect, it } from "vitest";
import { customerMergeVars, renderForCustomer, renderTemplate } from "./template";

describe("renderTemplate", () => {
  it("substitutes whitelisted merge fields (with optional spaces)", () => {
    const out = renderTemplate("Hi {{first_name}} from {{ city }}!", {
      first_name: "Aarav",
      city: "Mumbai",
    });
    expect(out).toBe("Hi Aarav from Mumbai!");
  });

  it("leaves unknown placeholders intact", () => {
    expect(renderTemplate("Hi {{first_name}} {{unknown}}", { first_name: "Aarav" })).toBe(
      "Hi Aarav {{unknown}}",
    );
  });

  it("replaces every occurrence", () => {
    expect(renderTemplate("{{city}}/{{city}}", { city: "Delhi" })).toBe("Delhi/Delhi");
  });
});

describe("customerMergeVars", () => {
  const NOW = new Date("2026-06-11T00:00:00.000Z");

  it("derives first name, days-ago, and rupee spend", () => {
    const vars = customerMergeVars(
      {
        name: "Aarav Sharma",
        city: "Mumbai",
        lastOrderAt: new Date("2026-03-13T00:00:00.000Z"), // 90 days before NOW
        totalSpend: 523400,
      },
      NOW,
    );
    expect(vars.first_name).toBe("Aarav");
    expect(vars.city).toBe("Mumbai");
    expect(vars.last_order_days_ago).toBe("90");
    expect(vars.total_spend_rupees).toBe("5,234");
  });

  it('uses "a while" when the customer has never ordered', () => {
    const vars = customerMergeVars(
      { name: "Meera", city: "Pune", lastOrderAt: null, totalSpend: 0 },
      NOW,
    );
    expect(vars.last_order_days_ago).toBe("a while");
    expect(vars.total_spend_rupees).toBe("0");
  });
});

describe("renderForCustomer", () => {
  it("renders a full personalized message", () => {
    const out = renderForCustomer(
      "Hey {{first_name}}, it's been {{last_order_days_ago}} days — your ₹{{total_spend_rupees}} says you love Brewline.",
      {
        name: "Diya Iyer",
        city: "Chennai",
        lastOrderAt: new Date("2026-05-12T00:00:00.000Z"),
        totalSpend: 1280000,
      },
      new Date("2026-06-11T00:00:00.000Z"),
    );
    expect(out).toBe(
      "Hey Diya, it's been 30 days — your ₹12,800 says you love Brewline.",
    );
  });
});
