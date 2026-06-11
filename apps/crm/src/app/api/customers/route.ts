import { NextResponse } from "next/server";
import { CustomerInputSchema } from "@resonate/shared";
import { fail, parseJson } from "@/server/api";
import { ingestCustomer } from "@/server/ingestion/ingestCustomer";
import { listCustomers } from "@/server/customers/listCustomers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") ?? undefined;
    const pageParam = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const pageSizeParam = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
    const result = await listCustomers({
      search,
      page: Number.isFinite(pageParam) ? pageParam : 1,
      pageSize: Number.isFinite(pageSizeParam) ? pageSizeParam : 25,
    });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = await parseJson(request, CustomerInputSchema);
    const customer = await ingestCustomer(input);
    return NextResponse.json(customer, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
