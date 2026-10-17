// Expo Push (spec 4.13): sends messages and reads receipts over HTTP. Expo talks to APNs for us.

export const SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** Expo takes at most 100 messages per send request and 1,000 ids per receipts request. */
export const SEND_CHUNK = 100;
export const RECEIPTS_CHUNK = 1000;

/** Tries per request, for 429, 5xx and network errors; waits 1 s, then 2 s between them. */
export const MAX_TRIES = 3;
export const BASE_DELAY_MS = 1000;

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  /** iOS: groups a list's pushes in Notification Center. */
  threadId?: string;
};

export type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string; expoPushToken?: string } };

export type PushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message?: string; details?: { error?: string } };

export type ExpoClient = {
  /** One ticket per message, in the same order. Throws when a chunk still fails after its tries. */
  send(messages: ExpoMessage[]): Promise<PushTicket[]>;
  /** Receipts by ticket id; ids Expo has no receipt for yet are missing. */
  getReceipts(ids: string[]): Promise<Record<string, PushReceipt>>;
};

export class ExpoPushError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = 'ExpoPushError';
  }
}

export type ExpoClientOptions = {
  fetch?: typeof fetch;
  /** EXPO_ACCESS_TOKEN (enhanced push security). Unset = no Authorization header. */
  accessToken?: string;
  sleep?: (ms: number) => Promise<void>;
};

export function createExpoClient(options: ExpoClientOptions = {}): ExpoClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  async function post(url: string, body: unknown): Promise<unknown> {
    let lastError: ExpoPushError = new ExpoPushError(null, 'not sent');
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      if (attempt > 1) await sleep(BASE_DELAY_MS * 2 ** (attempt - 2));
      let res: Response;
      try {
        res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (err) {
        lastError = new ExpoPushError(null, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as { data?: unknown; errors?: unknown };
        if (json.data === undefined) throw new ExpoPushError(res.status, `Expo answered without data: ${JSON.stringify(json.errors ?? json)}`);
        return json.data;
      }
      await res.body?.cancel();
      lastError = new ExpoPushError(res.status, `Expo answered ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw lastError;
    }
    throw lastError;
  }

  return {
    async send(messages) {
      const tickets: PushTicket[] = [];
      for (let i = 0; i < messages.length; i += SEND_CHUNK) {
        const chunk = messages.slice(i, i + SEND_CHUNK);
        const data = await post(SEND_URL, chunk);
        if (!Array.isArray(data) || data.length !== chunk.length) {
          throw new ExpoPushError(200, `Expo returned ${Array.isArray(data) ? data.length : 'no'} tickets for ${chunk.length} messages`);
        }
        tickets.push(...(data as PushTicket[]));
      }
      return tickets;
    },
    async getReceipts(ids) {
      const receipts: Record<string, PushReceipt> = {};
      for (let i = 0; i < ids.length; i += RECEIPTS_CHUNK) {
        const data = await post(RECEIPTS_URL, { ids: ids.slice(i, i + RECEIPTS_CHUNK) });
        Object.assign(receipts, data as Record<string, PushReceipt>);
      }
      return receipts;
    },
  };
}
