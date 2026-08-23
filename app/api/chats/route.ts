import { createChat, listChats } from "@/lib/chat-store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const chats = await listChats({
    query: url.searchParams.get("q") || "",
    status: url.searchParams.get("status") || "active",
    limit: Number(url.searchParams.get("limit")) || 100,
  });
  return Response.json({ chats }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let firstMessage = "";
  try {
    const input = await request.json() as { first_message?: unknown };
    firstMessage = typeof input.first_message === "string" ? input.first_message : "";
  } catch {
    // An empty body creates a blank chat.
  }
  return Response.json({ chat: await createChat(firstMessage) }, { status: 201 });
}
