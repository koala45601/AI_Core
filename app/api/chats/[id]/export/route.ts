import { getChat, listChatMessages } from "@/lib/chat-store";

function safeName(value: string) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]+/gu, "-").trim().slice(0, 60) || "alpha-chat";
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const chat = await getChat(id);
  if (!chat) return Response.json({ error: "ไม่พบแชต" }, { status: 404 });
  const messages = await listChatMessages(id);
  const format = new URL(request.url).searchParams.get("format") === "json" ? "json" : "markdown";
  const filename = safeName(chat.title);
  if (format === "json") {
    return new Response(JSON.stringify({ chat, messages }, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.json` },
    });
  }
  const markdown = [`# ${chat.title}`, "", ...messages.flatMap((message) => [
    `## ${message.role === "user" ? "คุณ" : "อัลฟ่า"}`,
    "",
    message.content,
    "",
    ...(message.metadata.sources?.length ? ["แหล่งข้อมูล:", ...message.metadata.sources.map((source) => `- [${source.title}](${source.url})`), ""] : []),
  ])].join("\n");
  return new Response(markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.md` },
  });
}
