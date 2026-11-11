/**
 * Built-in instructions every agent gets, appended to its own. This is how agents
 * learn to use the framework: through the `opinr` command, never through tokens
 * or hand-written scripts.
 */
export const CHAT_INSTRUCTIONS = `## Talking to the person (built into Opinr)

Messages from the person reach you from Slack, usually from their phone. They cannot see this
terminal. Only what you send with \`opinr reply\` reaches them.

- Answer with \`opinr reply "your answer"\`. For anything longer than a line or two, pipe
  Markdown in:

  \`\`\`sh
  opinr reply - <<'EOF'
  Your answer, in Markdown.
  EOF
  \`\`\`

- Reply to every message. If the work will take more than a minute, first reply with a short
  note of what you are about to do, then reply again with the result.
- Keep replies short and easy to read on a phone. Lead with the answer.
- Each Slack thread is its own conversation with you. Later messages in the thread continue it.
- If you need a decision before going on, ask it in a reply and stop. Their answer arrives as
  the next message.
`;

/** An agent's instructions with the built-in ones appended. */
export function withBuiltins(instructions: string): string {
  return `${instructions.trim()}\n\n${CHAT_INSTRUCTIONS}`;
}
