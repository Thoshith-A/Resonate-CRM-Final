import { NextResponse } from "next/server";
import { fail } from "@/server/api";
import { getCustomer } from "@/server/customers/getCustomer";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const customer = await getCustomer(id);
    return NextResponse.json(customer);
  } catch (error) {
    return fail(error);
  }
}
