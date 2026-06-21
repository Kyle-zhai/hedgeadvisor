import { afterEach, describe, expect, test, vi } from "vitest";
import { buildSemanticScorer, type NormalizedMarket } from "@/lib/relate";

const oldQwenKey = process.env.QWEN_API_KEY;
const oldGatewayKey = process.env.AI_GATEWAY_API_KEY;
const oldEmbeddingSwitch = process.env.HEDGE_ENABLE_SEMANTIC_EMBEDDINGS;

afterEach(() => {
  if (oldQwenKey === undefined) delete process.env.QWEN_API_KEY;
  else process.env.QWEN_API_KEY = oldQwenKey;
  if (oldGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = oldGatewayKey;
  if (oldEmbeddingSwitch === undefined) delete process.env.HEDGE_ENABLE_SEMANTIC_EMBEDDINGS;
  else process.env.HEDGE_ENABLE_SEMANTIC_EMBEDDINGS = oldEmbeddingSwitch;
  vi.unstubAllGlobals();
});

function market(id: string, title: string, category: string): NormalizedMarket {
  return {
    id, venue: "polymarket", eventKey: id, mutuallyExclusiveEvent: false, title,
    marketTitle: title, description: title, resolutionCriteria: title, probYes: 0.5,
    category, eventFamily: category, predicate: "mechanism", liquidityOk: true,
    endDateMs: null, url: "https://example.com", entityTokens: [], yesTokenId: `${id}:y`,
    noTokenId: `${id}:n`, feeRate: 0.03, feeExponent: 1, feeTakerOnly: true,
  };
}

describe("Qwen semantic recall", () => {
  test("can be disabled independently while the Qwen relation key remains configured", async () => {
    process.env.QWEN_API_KEY = "test-key";
    process.env.HEDGE_ENABLE_SEMANTIC_EMBEDDINGS = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await buildSemanticScorer([market("off", "test", "test")])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses the Qwen-compatible embeddings endpoint when no AI gateway key exists", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.QWEN_API_KEY = "test-key";
    delete process.env.HEDGE_ENABLE_SEMANTIC_EMBEDDINGS;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [0.9, 0.1] },
      { index: 2, embedding: [0, 1] },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const markets = [
      market("embed:anchor", "national team wins a title", "sports"),
      market("embed:related", "coach employment ends", "employment"),
      market("embed:other", "monthly inflation print", "economics"),
    ];
    const score = await buildSemanticScorer(markets);
    expect(score).not.toBeNull();
    expect(score!(markets[0], markets[1])).toBeGreaterThan(score!(markets[0], markets[2]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/embeddings");
  });
});
