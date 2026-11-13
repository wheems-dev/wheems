import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const conversationSchema = z.object({
  workspace: z.string(),
  connection: z.string(),
  channel: z.string(),
  /** The thread's id in the channel: the message that started it. */
  thread: z.string(),
  /** The engine's id for the conversation, so an ended session can be resumed. */
  sessionId: z.string(),
  /** The runtime session's name. */
  sessionName: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  /**
   * The engine's id for the last answer posted. Empty when none has been posted yet in a
   * conversation that started here; missing when it is not known.
   */
  lastAnswerId: z.string().optional(),
  /** The engine's own id for the conversation, for engines that choose their own ids. */
  engineSessionId: z.string().optional(),
  /** When the current engine session started, and the tag on its first message, to find its id. */
  startedAt: z.string().optional(),
  launchTag: z.string().optional(),
  /**
   * When the runtime had launched the session's program: messages typed into an engine that
   * reports no status wait until it has had its start-up time from here.
   */
  launchedAt: z.string().optional(),
  /**
   * How many messages are waiting for their answers. While any are, the session is never
   * stopped, and after a restart the service follows it until they are all answered.
   */
  pending: z.number().int().nonnegative().optional(),
  /** When the agent last wrote a note, or was asked for one. Work after it has no note yet. */
  notedAt: z.string().optional(),
  /** Wheems asked for a note and its answer, which is never posted, may not be skipped yet. */
  noting: z.boolean().optional(),
});

export type Conversation = z.infer<typeof conversationSchema>;

/** Remembers each conversation (one per chat thread) in a small JSON file. */
export class ConversationStore {
  private readonly file: string;
  private conversations = new Map<string, Conversation>();
  /** One load, shared by every caller, so no read can replace a newer write. */
  private loading: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async get(key: string): Promise<Conversation | undefined> {
    await this.load();
    return this.conversations.get(key);
  }

  async all(): Promise<[string, Conversation][]> {
    await this.load();
    return [...this.conversations.entries()];
  }

  async set(key: string, conversation: Conversation): Promise<void> {
    await this.load();
    this.conversations.set(key, conversation);
    await this.save();
  }

  async setEngineSession(key: string, id: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.engineSessionId = id;
    await this.save();
  }

  /**
   * Answers were posted: moves the answer position on and takes them off the waiting count,
   * in one write, so a restart never sees one without the other.
   */
  async answered(key: string, lastAnswerId: string, count: number): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.lastAnswerId = lastAnswerId;
    conversation.pending = Math.max(0, (conversation.pending ?? 0) - count);
    await this.save();
  }

  /** One more message waits for its answer. */
  async addPending(key: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.pending = (conversation.pending ?? 0) + 1;
    await this.save();
  }

  async setPending(key: string, pending: number): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation || (conversation.pending ?? 0) === pending) return;
    conversation.pending = pending;
    await this.save();
  }

  async setLastAnswer(key: string, id: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.lastAnswerId = id;
    await this.save();
  }

  /** A note was written, or asked for: the work up to now is covered. */
  async setNoted(key: string, at: Date): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.notedAt = at.toISOString();
    await this.save();
  }

  /** Marks a note turn in progress, or (with no id) over; with an id, also moves the answer position past it. */
  async setNoting(key: string, noting: boolean, lastAnswerId?: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    if (noting) conversation.noting = true;
    else delete conversation.noting;
    if (lastAnswerId !== undefined) conversation.lastAnswerId = lastAnswerId;
    await this.save();
  }

  async touch(key: string, at: Date): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.lastActiveAt = at.toISOString();
    await this.save();
  }

  private load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const parsed = z.record(z.string(), conversationSchema).parse(raw);
      this.conversations = new Map(Object.entries(parsed));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Writes are queued, and each writes a temporary file then renames it into place. */
  private save(): Promise<void> {
    const snapshot = `${JSON.stringify(Object.fromEntries(this.conversations), null, 2)}\n`;
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writing;
  }
}
