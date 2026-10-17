// Test fakes for send-notifications.

export type FetchCall = { url: string; headers: Record<string, string>; body: unknown };
export type FakeResponse = Response | Error | ((body: unknown) => Response);

/** A fake fetch answering with each response in turn (an Error is a network failure). */
export function fakeFetch(responses: FakeResponse[]) {
  const calls: FetchCall[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body });
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error('no more responses'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === 'function' ? next(body) : next);
  }) as typeof fetch;
  return { fn, calls };
}

/** Expo's answer to a send: an ok ticket per message, ids ticket-<token>. */
export const okTickets = (body: unknown) =>
  Response.json({ data: (body as { to: string }[]).map((m) => ({ status: 'ok', id: `ticket-${m.to}` })) });
