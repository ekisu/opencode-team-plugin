import { expect, test } from "bun:test"
import team from "./index.ts"

type Mode = "queue" | "steer" | "interrupt" | "park"
type Send = (
  input: { to: string; text: string; mode: Mode },
  context: { sessionID: string },
) => Promise<unknown>

async function sendMessage(title: string, mode: Mode) {
  let send: Send | undefined
  const messages: unknown[] = []
  const interrupts: unknown[] = []
  const ctx = {
    location: { project: { id: "project" } },
    tool: {
      async transform(edit: (editor: unknown) => void) {
        edit({
          namespace() {},
          add(tool: { name: string; execute: Send }) {
            if (tool.name === "send") send = tool.execute
          },
        })
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return { id: sessionID, title, projectID: "project" }
      },
      async synthetic(input: unknown) { messages.push(input) },
      async interrupt(input: unknown) { interrupts.push(input) },
      async hook() {},
    },
  }
  await team.setup(ctx as unknown as Parameters<typeof team.setup>[0])
  if (!send) throw new Error("team_send was not registered")
  await send({ to: "ses_receiver", text: "Found the issue", mode }, { sessionID: "ses_sender" })
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

test("falls back to the sender ID when its title is empty", async () => {
  const { messages } = await sendMessage("", "queue")
  expect(messages[0]).toMatchObject({ description: "Message from ses_sender" })
})
