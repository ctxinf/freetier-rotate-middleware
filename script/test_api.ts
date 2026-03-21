import "dotenv/config";

const apiKey = process.env.TEST_API_KEY;
if (!apiKey) {
  throw new Error("Missing TEST_API_KEY in .env");
}

const gatewayBaseUrl = (process.env.TEST_GATEWAY_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
const path = process.env.TEST_CHAT_PATH ?? "/v1/chat/completions";
const url = `${gatewayBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;

const model = process.env.TEST_MODEL ?? "group-free";
const userPrompt = process.argv.slice(2).join(" ").trim() || "你好，回我一个pong";

const payload = {
  model,
  stream: false,
  messages: [
    { role: "user", content: userPrompt }
  ]
};

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  },
  body: JSON.stringify(payload)
});

const responseText = await res.text();
if (!res.ok) {
  throw new Error(`Request failed (${res.status}): ${responseText}`);
}

try {
  const parsed = JSON.parse(responseText);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(parsed, null, 2));
} catch {
  // eslint-disable-next-line no-console
  console.log(responseText);
}
