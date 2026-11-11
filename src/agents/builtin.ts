/**
 * Built-in instructions every agent gets, appended to its own. This is how agents
 * learn to use the framework: through the `opinr` command, never through tokens
 * or hand-written scripts.
 */
export const CHAT_INSTRUCTIONS = `## Talking to the person (built into Opinr)

Messages from the person reach you from Slack, usually from their phone. They cannot see this
terminal.

- Answer normally. When you finish working on a message, your last message is posted to their
  Slack thread for you, in Markdown.
- If the work will take more than a minute, first send a short note of what you are about to do
  with \`opinr reply "..."\`, then carry on. Don't repeat that note in your final answer, and
  don't send your final answer with \`opinr reply\`. For a longer note, pipe Markdown in:

  \`\`\`sh
  opinr reply - <<'EOF'
  A longer note, in Markdown.
  EOF
  \`\`\`

- Keep answers short and easy to read on a phone. Lead with the answer.
- Each Slack thread is its own conversation with you. Later messages in the thread continue it.
- If you need a decision before going on, ask it in a reply and stop. Their answer arrives as
  the next message.
`;

/** An agent's instructions with the built-in ones appended. */
export function withBuiltins(instructions: string): string {
  return `${instructions.trim()}\n\n${CHAT_INSTRUCTIONS}`;
}
