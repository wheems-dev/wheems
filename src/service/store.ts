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

  async setLastAnswer(key: string, id: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    conversation.lastAnswerId = id;
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
