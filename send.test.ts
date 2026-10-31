import { expect, test } from "bun:test"
import team from "./index.ts"

type Mode = "queue" | "steer" | "interrupt" | "park" | "note"
type Execute = (
  input: Record<string, unknown>,
  context: { sessionID: string },
) => Promise<{ content: string }>
type ContextEvent = { sessionID: string; system: Array<{ type: "text"; text: string }> }

type Session = { id: string; title: string; projectID: string; parentID?: string }

async function setup(options: {
  title?: string
  sessions?: Session[]
  instructions?: "ok" | "fail"
} = {}) {
  const tools: Record<string, Execute> = {}
  const messages: unknown[] = []
  const interrupts: unknown[] = []
  const storage = new Map<string, unknown>()
  const entries = new Map<string, Map<string, unknown>>()
  const puts: unknown[] = []
  let contextHook: ((event: ContextEvent) => Promise<void> | void) | undefined
  const sessions = new Map((options.sessions ?? []).map((session) => [session.id, session]))
  const ctx = {
    location: { project: { id: "project" } },
    tool: {
      async transform(edit: (editor: unknown) => void) {
        edit({
          namespace() {},
          add(tool: { name: string; execute: Execute }) {
            tools[tool.name] = tool.execute
          },
        })
      },
    },
    storage: {
      async get(key: string) { return storage.get(key) },
      async set(key: string, value: unknown) { storage.set(key, value) },
      async remove(key: string) { storage.delete(key) },
      async scan({ prefix }: { prefix: string }) {
        return {
          entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
        }
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return sessions.get(sessionID) ?? { id: sessionID, title: options.title ?? "", projectID: "project" }
      },
      async synthetic(input: unknown) { messages.push(input) },
      async interrupt(input: unknown) { interrupts.push(input) },
      instructions: {
        entry: {
          async list({ sessionID }: { sessionID: string }) {
            if (options.instructions === "fail") throw new Error("no instruction entries")
            return [...(entries.get(sessionID) ?? [])].map(([key, value]) => ({ key, value }))
          },
          async put(input: { sessionID: string; key: string; value: unknown }) {
            puts.push(input)
            const map = entries.get(input.sessionID) ?? new Map()
            map.set(input.key, input.value)
            entries.set(input.sessionID, map)
          },
        },
      },
      async hook(name: string, fn: (event: ContextEvent) => Promise<void> | void) {
        if (name === "context") contextHook = fn
      },
    },
  }
  await team.setup(ctx as unknown as Parameters<typeof team.setup>[0])
  if (!tools.send || !contextHook) throw new Error("team plugin did not register")
  return { tools, messages, interrupts, storage, entries, puts, context: contextHook }
}

async function sendMessage(title: string, mode?: Mode) {
  const { tools, messages, interrupts } = await setup({ title })
  await tools.send!({ to: "ses_receiver", text: "Found the issue", ...(mode ? { mode } : {}) }, { sessionID: "ses_sender" })
  return { messages, interrupts }
}

for (const mode of ["queue", "steer", "interrupt", "park"] as const) {
  test(`${mode}: describes the sender without changing delivery or attribution`, async () => {
    const { messages, interrupts } = await sendMessage("API reviewer", mode)
    expect(messages).toEqual([{
      sessionID: "ses_receiver",
      text: "[agent-message from ses_sender]\nFound the issue",
      description: "Message from API reviewer",
      delivery: mode === "steer" ? "steer" : "queue",
      resume: mode === "park" ? false : undefined,
      metadata: { from: "ses_sender" },
    }])
    expect(interrupts).toEqual(mode === "interrupt"
      ? [{ sessionID: "ses_receiver", resume: false }]
      : [])
  })
}

test("steers when no mode is given", async () => {
  const { messages } = await sendMessage("API reviewer")
  expect(messages[0]).toMatchObject({ delivery: "steer", resume: undefined })
})

test("falls back to the sender ID when its title is empty", async () => {
  const { messages } = await sendMessage("", "queue")
  expect(messages[0]).toMatchObject({ description: "Message from ses_sender" })
})

const family: Session[] = [
  { id: "ses_parent", title: "Coordinator", projectID: "project" },
  { id: "ses_child", title: "Builder", projectID: "project", parentID: "ses_parent" },
]

test("note: stores a progress note under the parent and delivers nothing", async () => {
  const { tools, messages, storage } = await setup({ sessions: family })
  const result = await tools.send!({ to: "parent", text: "  build at 40%\n  linking ", mode: "note" }, { sessionID: "ses_child" })
  expect(result.content).toContain("note saved")
  expect(messages).toEqual([])
  expect(storage.get("note/ses_parent/ses_child")).toMatchObject({ text: "build at 40% linking" })
})

test("note: throttles a second note within 10 s and keeps the first", async () => {
  const { tools, storage } = await setup({ sessions: family })
  await tools.send!({ to: "parent", text: "first", mode: "note" }, { sessionID: "ses_child" })
  const second = await tools.send!({ to: "parent", text: "second", mode: "note" }, { sessionID: "ses_child" })
  expect(second.content).toContain("note not saved")
  expect(storage.get("note/ses_parent/ses_child")).toMatchObject({ text: "first" })
})

test("note: only goes to the parent", async () => {
  const { tools } = await setup({ sessions: family })
  await expect(tools.send!({ to: "ses_parent", text: "x", mode: "note" }, { sessionID: "ses_child" })).rejects.toThrow("only goes to 'parent'")
  await expect(tools.send!({ to: "parent", text: "x", mode: "note" }, { sessionID: "ses_parent" })).rejects.toThrow("no parent")
})

test("protocol: puts the instruction entry once and covers the first step with a system part", async () => {
  const { context, puts } = await setup()
  const first: ContextEvent = { sessionID: "ses_a", system: [] }
  await context(first)
  expect(puts).toEqual([{ sessionID: "ses_a", key: "team.protocol", value: expect.stringContaining("ses_a") }])
  expect(first.system).toHaveLength(1)
  expect(first.system[0]!.text).toContain("never send acknowledgements")

  const second: ContextEvent = { sessionID: "ses_a", system: [] }
  await context(second)
  expect(puts).toHaveLength(1)
  expect(second.system).toEqual([])
})

test("protocol: an entry already stored (e.g. before a restart) is neither put nor repeated", async () => {
  const first = await setup()
  await first.context({ sessionID: "ses_a", system: [] })
  const stored = first.entries

  const restarted = await setup()
  for (const [sessionID, map] of stored) restarted.entries.set(sessionID, map)
  const event: ContextEvent = { sessionID: "ses_a", system: [] }
  await restarted.context(event)
  expect(restarted.puts).toEqual([])
  expect(event.system).toEqual([])
})

test("protocol: nothing to add when the baseline already carries the entry", async () => {
  const { context, puts } = await setup()
  const event: ContextEvent = { sessionID: "ses_a", system: [{ type: "text", text: '<context key="team.protocol">\n…\n</context>' }] }
  await context(event)
  expect(puts).toEqual([])
  expect(event.system).toHaveLength(1)
})

test("protocol: falls back to a system part on every call without instruction entries", async () => {
  const { context } = await setup({ instructions: "fail" })
  for (let i = 0; i < 2; i++) {
    const event: ContextEvent = { sessionID: "ses_a", system: [] }
    await context(event)
    expect(event.system).toHaveLength(1)
  }
})
