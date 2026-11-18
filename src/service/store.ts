import type {
  ChatAuthor,
  ChatTurn,
  Conversation,
  Handover,
  HandoverAuthor,
  StateStore,
} from '../state/store.js';

export type { Conversation } from '../state/store.js';

/**
 * Remembers each conversation (one per chat thread) in the session store. SQLite is
 * synchronous and only the service writes to the store, so every read sees every earlier
 * write, and each change is one transaction.
 */
/* eslint-disable @typescript-eslint/require-await -- async to keep the interface the
   conversation manager uses, and to turn SQLite's errors into rejected promises. */
export class ConversationStore {
  constructor(private readonly state: StateStore) {}

  async get(key: string): Promise<Conversation | undefined> {
    return this.state.conversation(key);
  }

  async all(): Promise<[string, Conversation][]> {
    return this.state.conversations();
  }

  async set(key: string, conversation: Conversation): Promise<void> {
    this.state.saveConversation(key, conversation);
  }

  /** Records the person's first message as what the thread session was asked. */
  async recordAsk(sessionId: string, ask: string): Promise<void> {
    this.state.recordAsk(sessionId, ask);
  }

  /** Records a turn said in a conversation's thread, when its session is known. */
  async recordChat(key: string, author: ChatAuthor, text: string, at: Date): Promise<void> {
    const conversation = this.state.conversation(key);
    if (!conversation) return;
    this.state
      .workspace(conversation.workspace)
      .addChat({ session: conversation.sessionId, author, text, at: at.toISOString() });
  }

  async setEngineSession(key: string, id: string): Promise<void> {
    this.state.updateThreadSession(key, { engineSessionId: id });
  }

  /**
   * Answers were posted: moves the answer position on and takes them off the waiting count,
   * in one write, so a restart never sees one without the other.
   */
  async answered(key: string, lastAnswerId: string, count: number): Promise<void> {
    this.state.updateThread(key, { lastAnswerId, answered: count });
  }

  /** One more message waits for its answer. */
  async addPending(key: string): Promise<void> {
    this.state.updateThread(key, { addPending: true });
  }

  async setPending(key: string, pending: number): Promise<void> {
    if ((this.state.conversation(key)?.pending ?? 0) === pending) return;
    this.state.updateThread(key, { pending });
  }

  async setLastAnswer(key: string, id: string): Promise<void> {
    this.state.updateThread(key, { lastAnswerId: id });
  }

  /** A note was written, or asked for: the work up to now is covered. */
  async setNoted(key: string, at: Date): Promise<void> {
    this.state.updateThread(key, { notedAt: at.toISOString() });
  }

  /** Marks a note turn in progress, or (with no id) over; with an id, also moves the answer position past it. */
  async setNoting(key: string, noting: boolean, lastAnswerId?: string): Promise<void> {
    this.state.updateThread(key, {
      noting,
      ...(lastAnswerId !== undefined && { lastAnswerId }),
    });
  }

  async touch(key: string, at: Date): Promise<void> {
    this.state.updateThreadSession(key, { lastActiveAt: at.toISOString() });
  }

  /**
   * Sets a thread up to start afresh at its next message: from a handover, or with only its ask.
   * Returns the handover's id.
   */
  async restart(
    key: string,
    handover: {
      text: string;
      author: HandoverAuthor;
      fromEngine: string | null;
      fromModel: string | null;
      at: Date;
    } | null,
  ): Promise<string | null> {
    return this.state.restartThread(
      key,
      handover === null ? null : { ...handover, at: handover.at.toISOString() },
    );
  }

  async handover(id: string): Promise<Handover | undefined> {
    return this.state.handover(id);
  }

  /** The thread's next session has started from its handover, or afresh. */
  async startedAfresh(key: string, to: { engine: string; model: string; at: Date }): Promise<void> {
    this.state.startedAfresh(key, { ...to, at: to.at.toISOString() });
  }

  /** The thread's ask and its latest turns in chat, oldest first, for a handover Wheems writes. */
  async record(key: string, turns: number): Promise<{ ask: string | null; chat: ChatTurn[] }> {
    const conversation = this.state.conversation(key);
    if (!conversation) return { ask: null, chat: [] };
    const sessions = this.state.workspace(conversation.workspace);
    return {
      ask: sessions.session(conversation.sessionId)?.ask ?? null,
      chat: sessions.chat(conversation.sessionId, turns).reverse(),
    };
  }
}
/* eslint-enable @typescript-eslint/require-await */
