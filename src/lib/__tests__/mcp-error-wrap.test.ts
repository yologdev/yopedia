import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

vi.mock("../search", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../search")>();
  return {
    ...orig,
    fuzzySearchWikiContent: vi
      .fn()
      .mockRejectedValue(new Error("search index corrupted")),
  };
});

vi.mock("../wiki", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../wiki")>();
  return {
    ...orig,
    listWikiPages: vi
      .fn()
      .mockRejectedValue(new Error("filesystem read failed")),
    listReadableWikiPages: vi
      .fn()
      .mockRejectedValue(new Error("filesystem read failed")),
  };
});

import { createMcpServer } from "../../mcp";

describe("MCP error wrapping", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it("search_wiki returns isError when handler throws", async () => {
    const result = await client.callTool({
      name: "search_wiki",
      arguments: { query: "anything" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toBe("search index corrupted");
  });

  it("list_pages returns isError when handler throws", async () => {
    const result = await client.callTool({
      name: "list_pages",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toBe("filesystem read failed");
  });
});
