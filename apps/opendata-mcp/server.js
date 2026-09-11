import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// 백엔드 API 베이스 URL
const BACKEND_API_URL = "https://mcp.ezrnd.co.kr";

// 검색 도구 입력 스키마
const searchOpendataInputSchema = {
  query: z.string().min(1).describe("검색할 키워드"),
  page: z.number().int().min(1).default(1).describe("페이지 번호"),
  pageSize: z.number().int().min(1).max(100).default(10).describe("페이지 크기"),
};

// 문서 상세 조회 입력 스키마
const getDocumentDetailInputSchema = {
  listId: z.number().int().min(1).describe("문서 ID"),
};

// React 빌드 결과물 로드 (빌드 후에 생성됨)
let widgetHtml = "";
try {
  widgetHtml = readFileSync("public/index.html", "utf8");
} catch (error) {
  console.warn("Warning: public/index.html not found. Run 'npm run build' first.");
  widgetHtml = `<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenData Search</title>
  </head>
  <body>
    <div id="root">
      <p style="padding: 20px; text-align: center;">
        Please run <code>npm run build</code> to build the React app first.
      </p>
    </div>
  </body>
</html>`;
}

/**
 * 백엔드 API 호출 헬퍼 함수
 */
async function callBackendAPI(endpoint) {
  try {
    const response = await fetch(`${BACKEND_API_URL}${endpoint}`);
    if (!response.ok) {
      throw new Error(`Backend API error: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Backend API call failed:", error);
    throw error;
  }
}

/**
 * MCP 서버 생성
 */
function createOpendataServer() {
  const server = new McpServer({
    name: "opendata-mcp",
    version: "0.1.0",
  });

  // Widget Resource 등록
  server.registerResource(
    "opendata-widget",
    "ui://widget/opendata.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/opendata.html",
          mimeType: "text/html+skybridge",
          text: widgetHtml,
          _meta: {
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    })
  );

  // 검색 도구 등록
  server.registerTool(
    "search_opendata",
    {
      title: "공공데이터 검색",
      description: "한국 공공데이터포털에서 API와 파일 데이터를 검색합니다.",
      inputSchema: searchOpendataInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/opendata.html",
        "openai/toolInvocation/invoking": "공공데이터 검색 중...",
        "openai/toolInvocation/invoked": "검색 완료",
      },
    },
    async (args) => {
      const query = args?.query?.trim?.() ?? "";
      const page = args?.page ?? 1;
      const pageSize = args?.pageSize ?? 10;

      if (!query) {
        return {
          content: [{ type: "text", text: "검색어를 입력해주세요." }],
          structuredContent: { searchResults: null },
        };
      }

      try {
        // 백엔드 API 호출
        const endpoint = `/api/v1/search/title/std-docs?q=${encodeURIComponent(query)}&page=${page}&page_size=${pageSize}`;
        const data = await callBackendAPI(endpoint);

        return {
          content: [
            {
              type: "text",
              text: `"${query}" 검색 완료. 총 ${data.total}개의 결과를 찾았습니다. (페이지 ${data.page}/${Math.ceil(data.total / data.pageSize)})`,
            },
          ],
          structuredContent: {
            searchResults: data,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `검색 중 오류가 발생했습니다: ${error.message}`,
            },
          ],
          structuredContent: { searchResults: null },
        };
      }
    }
  );

  // 문서 상세 조회 도구 등록
  server.registerTool(
    "get_document_detail",
    {
      title: "문서 상세 조회",
      description: "특정 문서의 상세 정보를 조회합니다.",
      inputSchema: getDocumentDetailInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/opendata.html",
        "openai/toolInvocation/invoking": "문서 상세 정보 조회 중...",
        "openai/toolInvocation/invoked": "조회 완료",
      },
    },
    async (args) => {
      const listId = args?.listId;

      if (!listId) {
        return {
          content: [{ type: "text", text: "문서 ID를 입력해주세요." }],
          structuredContent: { documentDetail: null },
        };
      }

      try {
        // 백엔드 API 호출
        const endpoint = `/api/v1/document/std-docs/${listId}?include_recommendations=true`;
        const data = await callBackendAPI(endpoint);

        const title = data.listTitle || `문서 ${listId}`;
        const hasMarkdown = data.markdown && data.markdown.length > 0;

        return {
          content: [
            {
              type: "text",
              text: `"${title}" 문서 조회 완료.${hasMarkdown ? " 문서 내용을 확인하세요." : ""}`,
            },
          ],
          structuredContent: {
            documentDetail: data,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `문서 조회 중 오류가 발생했습니다: ${error.message}`,
            },
          ],
          structuredContent: { documentDetail: null },
        };
      }
    }
  );

  return server;
}

// 서버 설정
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  // CORS preflight 처리
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, accept",
      "Access-Control-Expose-Headers": "Mcp-Session-Id, Content-Type",
    });
    res.end();
    return;
  }

  // 헬스 체크
  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("OpenData MCP Server is running");
    return;
  }

  // MCP 요청 처리
  if (url.pathname === MCP_PATH) {
    // 요청 로깅 (디버깅용)
    console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Content-Type", "application/json");

    // GET 요청: 서버 정보 반환 (MCP 프로토콜)
    if (req.method === "GET") {
      const serverInfo = {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: "opendata-mcp",
            version: "0.1.0",
          },
        },
        id: 1,
      };
      res.writeHead(200);
      res.end(JSON.stringify(serverInfo));
      console.log(`[${new Date().toISOString()}] GET request handled`);
      return;
    }

    // POST 요청: MCP SDK로 처리
    if (req.method === "POST") {
      const server = createOpendataServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
        console.log(`[${new Date().toISOString()}] POST request handled`);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error.message,
            },
            id: null,
          }));
        }
      }
      return;
    }

    // DELETE 요청: 세션 종료 (stateless이므로 단순 성공 반환)
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        result: {},
        id: 1,
      }));
      console.log(`[${new Date().toISOString()}] DELETE request handled`);
      return;
    }
  }

  // 404 처리
  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  OpenData MCP Server                                      ║
╚═══════════════════════════════════════════════════════════╝

🚀 Server is running on: http://localhost:${port}${MCP_PATH}

📝 Available tools:
   - search_opendata: 공공데이터 검색
   - get_document_detail: 문서 상세 조회

🔧 Test with MCP Inspector:
   npx @modelcontextprotocol/inspector@latest \\
     --server-url http://localhost:${port}${MCP_PATH} \\
     --transport http

🌐 Expose to internet (for ChatGPT):
   ngrok http ${port}
   Then use: https://YOUR-NGROK-URL${MCP_PATH}

✅ Ready to connect to ChatGPT!
  `);
});
