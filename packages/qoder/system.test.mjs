// The words a coding plan's gateway turns a chat away for are put in other
// words in the system prompt (FLAGGED), and a system prompt Qoder refused
// the request for is read to the model as the first thing the user says, in
// <instructions> tags, with Qoder's own system line alone in the system's
// place (systemAsUser). WorkBuddy's plugin does the same for its own
// channel check (magpie #182, #279, #291).
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const { QODER_SYS, decodeBody, modelInfo, qoderBody, requestRefused, systemAsUser, systemKey, unflagged } = _internal

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const MODEL = modelInfo({ key: "efficient", display_name: "Efficient", enable: true })
const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const LISTING = { chat: [{ key: "efficient", display_name: "Efficient", enable: true }] }
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200, statusCode: "OK" })}\n\n`
const ANSWER =
  line({ choices: [{ delta: { content: "Hi" }, index: 0 }], object: "chat.completion.chunk" }) +
  line({ choices: [{ delta: { content: "" }, finish_reason: "stop", index: 0 }], object: "chat.completion.chunk" }) +
  line("[DONE]")
const sseAnswer = () => new Response(ANSWER, { headers: { "Content-Type": "text/event-stream" } })
// Qoder refusing the request itself: code 406, sensitive content
const REFUSED = () => json({ code: "406", message: "sensitive content" }, 400)

// the loader's fetch against the listing and the answers Qoder gives, one
// per chat request; bodies are the chats as they went on the wire
async function chatting(answers) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  const bodies = []
  let n = 0
  globalThis.fetch = async (url, init = {}) => {
    if (new URL(String(url)).pathname.endsWith("/model/list")) return json(LISTING)
    if (init?.body) bodies.push(JSON.parse(decodeBody(init.body)))
    return answers[n++] ?? json({}, 404)
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { fetch: (await hooks.auth.loader(async () => auth)).fetch, bodies }
}

const ask = (messages) => ({ method: "POST", body: JSON.stringify({ model: "efficient", messages }) })

test("each flagged phrase is put in other words, whatever its case", () => {
  expect(unflagged("You are Claude Code, Anthropic's official CLI for Claude.")).toBe("You are Claude Code, Anthropic's CLI for Claude.")
  expect(unflagged("Main branch (you will usually use this for PRs): main")).toBe("Main branch (usually the base for PRs): main")
  expect(unflagged("MAIN BRANCH (YOU WILL USUALLY USE THIS FOR PRS): main")).toBe("Main branch (usually the base for PRs): main")
  const codex = "Codex CLI is an open source project led by OpenAI."
  expect(unflagged(codex)).toBe("The Codex CLI is an open source project led by OpenAI.")
  expect(unflagged("The Codex CLI is an open source project led by OpenAI.")).toBe("The Codex CLI is an open source project led by OpenAI.")
  expect(unflagged(unflagged(codex))).toBe(unflagged(codex))
  expect(unflagged("You are an AI agent powered by DeepSeek Harness. Be brief.")).toBe("You are an AI agent that helps the user with programming tasks. Be brief.")
  expect(unflagged("YOU ARE AN AI AGENT POWERED BY DEEPSEEK HARNESS")).toBe("You are an AI agent that helps the user with programming tasks.")
  expect(unflagged("x-anthropic-billing-header: cc_version=2.1.280.31f; cc_entrypoint=sdk-cli;\nhello")).toBe("hello")
  expect(unflagged("nothing to see")).toBe("nothing to see")
})

test("Qoder's own system line comes before the client's, with the flagged words reworded", () => {
  const body = qoderBody({ messages: [
    { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
    { role: "user", content: "hi" },
  ] }, MODEL)
  expect(body.system[0].text).toBe(`${QODER_SYS}\n\nYou are an AI agent that helps the user with programming tasks.`)
  // the chat's first message is the system's, as Qoder's client sends it
  expect(body.messages[0]).toEqual({ role: "system", content: body.system })
})

test("a developer message is the system prompt too", () => {
  const body = qoderBody({ messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }] }, MODEL)
  expect(body.system[0].text).toBe(`${QODER_SYS}\n\nbe brief`)
})

test("a system prompt of the billing header alone leaves Qoder's own line", () => {
  const body = qoderBody({ messages: [
    { role: "system", content: "x-anthropic-billing-header: cc_version=2.1.280.31f; cc_entrypoint=sdk-cli;" },
    { role: "user", content: "hi" },
  ] }, MODEL)
  expect(body.system).toEqual([{ type: "text", text: QODER_SYS }])
})

test("systemKey is the client's system prompt, \"\" when it has none of its own", () => {
  expect(systemKey({ messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] })).toBe("be brief")
  expect(systemKey({ messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }] })).toBe("be brief")
  expect(systemKey({ messages: [{ role: "user", content: "hi" }] })).toBe("")
  expect(systemKey({})).toBe("")
})

test("the system prompt goes as the first thing the user says, in instructions tags", () => {
  const chat = { messages: [
    { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "and now?" },
  ] }
  const moved = systemAsUser(chat)
  expect(moved.messages).toEqual([
    { role: "user", content: "<instructions>\nYou are an AI agent that helps the user with programming tasks.\n</instructions>\n\nhi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "and now?" },
  ])
  // the chat it was made from is left as it came
  expect(chat.messages[0]).toEqual({ role: "system", content: "You are an AI agent powered by DeepSeek Harness." })
  // Qoder's own line is alone in the system's place
  expect(qoderBody(moved, MODEL).system).toEqual([{ type: "text", text: QODER_SYS }])
})

test("the instructions go before the parts of the user's own message", () => {
  const moved = systemAsUser({ messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:," } }] },
  ] })
  expect(moved.messages[0]).toEqual({ role: "user", content: [
    { type: "text", text: "<instructions>\nbe brief\n</instructions>" },
    { type: "text", text: "hi" },
    { type: "image_url", image_url: { url: "data:," } },
  ] })
})

test("a chat with no user message gets the instructions as one", () => {
  expect(systemAsUser({ messages: [{ role: "system", content: "be brief" }] }).messages).toEqual([
    { role: "user", content: "<instructions>\nbe brief\n</instructions>" },
  ])
})

test("a system message later in the chat becomes the user's where it stands", () => {
  const moved = systemAsUser({ messages: [
    { role: "user", content: "hi" },
    { role: "system", content: "be brief" },
    { role: "user", content: "and now?" },
  ] })
  expect(moved.messages).toEqual([
    { role: "user", content: "hi" },
    { role: "user", content: "be brief" },
    { role: "user", content: "and now?" },
  ])
})

test("a chat with no system prompt of its own has nothing to move", () => {
  expect(systemAsUser({ messages: [{ role: "user", content: "hi" }] })).toBeNull()
  expect(systemAsUser({ messages: [{ role: "system", content: "" }, { role: "user", content: "hi" }] })).toBeNull()
  expect(systemAsUser({})).toBeNull()
})

test("requestRefused is the code Qoder refused the request itself with", () => {
  for (const code of ["406", "416", "430", "80411", "80412", "100400", "100401", "100403"])
    expect(requestRefused(JSON.stringify({ code, message: "no" }))).toBe(code)
  for (const code of ["105", "10605", "110", "122"]) expect(requestRefused(JSON.stringify({ code, message: "no" }))).toBe("")
  expect(requestRefused("not json")).toBe("")
  expect(requestRefused("")).toBe("")
})

test("a chat Qoder refuses the request for is sent again with the prompt as the user's words", async () => {
  const { fetch, bodies } = await chatting([REFUSED(), sseAnswer()])
  const res = await fetch(API_CHAT, ask([
    { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
    { role: "user", content: "hi" },
  ]))
  expect(res.status).toBe(200)
  expect(bodies).toHaveLength(2)
  // the first carries the prompt in the system's place, reworded
  expect(bodies[0].system[0].text).toBe(`${QODER_SYS}\n\nYou are an AI agent that helps the user with programming tasks.`)
  // the second has Qoder's own line alone there, and the prompt as the user's
  expect(bodies[1].system).toEqual([{ type: "text", text: QODER_SYS }])
  expect(bodies[1].messages[1].role).toBe("user")
  expect(bodies[1].messages[1].content.map((b) => b.text).join("")).toBe(
    "<instructions>\nYou are an AI agent that helps the user with programming tasks.\n</instructions>\n\nhi",
  )
})

test("the next chat with the prompt Qoder refused is sent as the user's words at once", async () => {
  const { fetch, bodies } = await chatting([REFUSED(), sseAnswer(), sseAnswer()])
  const said = ask([
    { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
    { role: "user", content: "hi" },
  ])
  expect((await fetch(API_CHAT, said)).status).toBe(200) // refused once, then moved
  expect((await fetch(API_CHAT, said)).status).toBe(200) // moved at once
  expect(bodies).toHaveLength(3)
  expect(bodies[2].system).toEqual([{ type: "text", text: QODER_SYS }])
})

test("a refusal of the moved chat is answered as Qoder's own words", async () => {
  const { fetch, bodies } = await chatting([REFUSED(), REFUSED()])
  const res = await fetch(API_CHAT, ask([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("Qoder refused the request (406)")
  expect(bodies).toHaveLength(2)
})

test("a refusal that isn't the request's own leaves the chat as it came", async () => {
  // the plan's credits used up: moving the prompt wouldn't help, so the
  // answer stays the one Qoder gave
  const { fetch, bodies } = await chatting([json({ code: "110", message: "credits used up" }, 403)])
  const res = await fetch(API_CHAT, ask([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]))
  expect(res.status).toBe(429)
  expect(bodies).toHaveLength(1)
  expect(bodies[0].system[0].text).toBe(`${QODER_SYS}\n\nbe brief`)
})

test("a chat Qoder answers is sent as it came", async () => {
  const { fetch, bodies } = await chatting([sseAnswer()])
  const res = await fetch(API_CHAT, ask([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]))
  expect(res.status).toBe(200)
  expect(bodies).toHaveLength(1)
  expect(bodies[0].system[0].text).toBe(`${QODER_SYS}\n\nbe brief`)
})

test("a chat with no system prompt of its own is refused as it came", async () => {
  const { fetch, bodies } = await chatting([REFUSED()])
  const res = await fetch(API_CHAT, ask([{ role: "user", content: "hi" }]))
  expect(res.status).toBe(400)
  expect(bodies).toHaveLength(1)
})
