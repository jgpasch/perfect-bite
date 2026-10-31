// Run from this folder: deno test pinned-fetch.test.ts
// `_shared/` has no import map, so @std/assert is imported by its jsr: specifier.
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';

import { type Connect, createPinnedFetch, type PinnedConn, type PinnedRequestInit } from './pinned-fetch.ts';

const encoder = new TextEncoder();

type Dial = { address: string; port: number; tlsHostname: string | null };

/** A connection answering with `chunks` (an Error fails the read), recording what was written and whether it closed. */
function fakeConn(chunks: (string | Uint8Array | Error)[]) {
  const state = { written: '', closed: false };
  const queue = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
  const conn: PinnedConn = {
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();
        if (next instanceof Error) controller.error(next);
        else if (next) controller.enqueue(next);
        else controller.close();
      },
    }, { highWaterMark: 0 }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        state.written += new TextDecoder().decode(chunk);
      },
    }),
    close() {
      if (state.closed) throw new Error('closed twice');
      state.closed = true;
    },
  };
  return { conn, state };
}

/** A Connect that answers each dial from `answer` and records every dial. */
function fakeConnect(answer: (dial: Dial) => PinnedConn | Error) {
  const dials: Dial[] = [];
  const fn: Connect = (dial) => {
    dials.push(dial);
    const result = answer(dial);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { fn, dials };
}

function init(addresses: string[], signal = new AbortController().signal): PinnedRequestInit {
  return { addresses, signal, headers: { accept: 'text/html', 'user-agent': 'Test/1.0' } };
}

const OK = 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello';

Deno.test('pinned fetch connects to the given address, with TLS for the URL host, and sends one GET', async () => {
  const { conn, state } = fakeConn([OK]);
  const connect = fakeConnect(() => conn);
  const response = await createPinnedFetch(connect.fn)('https://kitchen.example/soup?x=1#top', init(['93.184.216.34']));
  assertEquals(connect.dials, [{ address: '93.184.216.34', port: 443, tlsHostname: 'kitchen.example' }]);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'text/html');
  assertEquals(await response.text(), 'hello');
  assertEquals(
    state.written,
    'GET /soup?x=1 HTTP/1.1\r\nHost: kitchen.example\r\naccept: text/html\r\nuser-agent: Test/1.0\r\n' +
      'Accept-Encoding: gzip, deflate\r\nConnection: close\r\n\r\n',
  );
  assert(state.closed);
});

Deno.test('pinned fetch uses plain TCP for http, the URL port, and the bracketless IPv6 host for TLS', async () => {
  const http = fakeConnect(() => fakeConn([OK]).conn);
  await createPinnedFetch(http.fn)('http://kitchen.example:8080/', init(['93.184.216.34']));
  assertEquals(http.dials, [{ address: '93.184.216.34', port: 8080, tlsHostname: null }]);

  const { conn, state } = fakeConn([OK]);
  const v6 = fakeConnect(() => conn);
  await createPinnedFetch(v6.fn)('https://[2606:4700::1111]/', init(['2606:4700::1111']));
  assertEquals(v6.dials, [{ address: '2606:4700::1111', port: 443, tlsHostname: '2606:4700::1111' }]);
  assert(state.written.includes('Host: [2606:4700::1111]\r\n'));
});

Deno.test('pinned fetch tries the next checked address when one fails to connect, and only those', async () => {
  const connect = fakeConnect((dial) => (dial.address === '93.184.216.34' ? new Error('refused') : fakeConn([OK]).conn));
  const response = await createPinnedFetch(connect.fn)('https://kitchen.example/', init(['93.184.216.34', '2606:4700::1111']));
  assertEquals(await response.text(), 'hello');
  assertEquals(connect.dials.map((d) => d.address), ['93.184.216.34', '2606:4700::1111']);

  const failing = fakeConnect((dial) => new Error(`refused ${dial.address}`));
  await assertRejects(() => createPinnedFetch(failing.fn)('https://kitchen.example/', init(['1.1.1.1', '8.8.8.8'])), Error, 'refused 8.8.8.8');
  await assertRejects(() => createPinnedFetch(failing.fn)('https://kitchen.example/', init([])), TypeError, 'No address');
});

Deno.test('pinned fetch decodes a chunked body split across reads, with extensions and trailers', async () => {
  const { conn, state } = fakeConn([
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhel',
    'lo\r\n7\r\n, world\r\n0\r\nX-Trailer: 1\r\n\r\n',
  ]);
  const response = await createPinnedFetch(fakeConnect(() => conn).fn)('https://kitchen.example/', init(['1.1.1.1']));
  assertEquals(await response.text(), 'hello, world');
  assert(state.closed);
});

Deno.test('pinned fetch reads a body without length to the end of the connection', async () => {
  const { conn } = fakeConn(['HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<p>a', 'b</p>']);
  const response = await createPinnedFetch(fakeConnect(() => conn).fn)('http://kitchen.example/', init(['1.1.1.1']));
  assertEquals(await response.text(), '<p>ab</p>');
});

Deno.test('pinned fetch takes a TLS close without close_notify as the end of the connection', async () => {
  const eof = () => new Deno.errors.UnexpectedEof('peer closed connection without sending TLS close_notify');
  const toClose = fakeConn(['HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<p>a', 'b</p>', eof()]);
  const response = await createPinnedFetch(fakeConnect(() => toClose.conn).fn)('https://kitchen.example/', init(['1.1.1.1']));
  assertEquals(await response.text(), '<p>ab</p>');
  assert(toClose.state.closed);

  const short = fakeConn(['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc', eof()]);
  const cut = await createPinnedFetch(fakeConnect(() => short.conn).fn)('https://k.example/', init(['1.1.1.1']));
  await assertRejects(() => cut.text(), TypeError, 'before Content-Length');

  const reset = fakeConn(['HTTP/1.1 200 OK\r\n\r\nab', new Deno.errors.ConnectionReset('reset')]);
  const failed = await createPinnedFetch(fakeConnect(() => reset.conn).fn)('https://k.example/', init(['1.1.1.1']));
  await assertRejects(() => failed.text(), Deno.errors.ConnectionReset);
});

Deno.test('pinned fetch stops at Content-Length and fails when the connection ends short', async () => {
  const extra = fakeConn(['HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef']);
  assertEquals(await (await createPinnedFetch(fakeConnect(() => extra.conn).fn)('http://k.example/', init(['1.1.1.1']))).text(), 'abc');

  const short = fakeConn(['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc']);
  const response = await createPinnedFetch(fakeConnect(() => short.conn).fn)('http://k.example/', init(['1.1.1.1']));
  await assertRejects(() => response.text(), TypeError, 'before Content-Length');
  assert(short.state.closed);
});

Deno.test('pinned fetch decodes a gzip body', async () => {
  const gz = new Uint8Array(await new Response(new Blob(['<p>Crème</p>']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const { conn } = fakeConn([`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.byteLength}\r\n\r\n`, gz]);
  const response = await createPinnedFetch(fakeConnect(() => conn).fn)('https://k.example/', init(['1.1.1.1']));
  assertEquals(await response.text(), '<p>Crème</p>');
});

Deno.test('pinned fetch skips 1xx answers, returns redirects unfollowed, and gives 204 no body', async () => {
  const early = fakeConn(['HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\n', OK]);
  const first = await createPinnedFetch(fakeConnect(() => early.conn).fn)('https://k.example/', init(['1.1.1.1']));
  assertEquals([first.status, await first.text()], [200, 'hello']);

  const moved = fakeConn(['HTTP/1.1 302 Found\r\nLocation: http://10.0.0.1/\r\nContent-Length: 0\r\n\r\n']);
  const connect = fakeConnect(() => moved.conn);
  const redirect = await createPinnedFetch(connect.fn)('https://k.example/', init(['1.1.1.1']));
  assertEquals([redirect.status, redirect.headers.get('location')], [302, 'http://10.0.0.1/']);
  assertEquals(connect.dials.length, 1);

  const empty = fakeConn(['HTTP/1.1 204 No Content\r\n\r\n']);
  const none = await createPinnedFetch(fakeConnect(() => empty.conn).fn)('https://k.example/', init(['1.1.1.1']));
  assertEquals([none.status, none.body], [204, null]);
  assert(empty.state.closed);
});

Deno.test('pinned fetch closes the connection when the body is cancelled', async () => {
  const { conn, state } = fakeConn(['HTTP/1.1 200 OK\r\n\r\nfirst', 'second']);
  const response = await createPinnedFetch(fakeConnect(() => conn).fn)('https://k.example/', init(['1.1.1.1']));
  await response.body!.cancel();
  assert(state.closed);
});

Deno.test('pinned fetch refuses a malformed response and closes the connection', async () => {
  for (const answer of ['SSH-2.0-OpenSSH\r\n', 'HTTP/1.1 200 OK\r\nno colon here\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: x\r\n\r\n', 'HTTP/1.1 200']) {
    const { conn, state } = fakeConn([answer]);
    await assertRejects(() => createPinnedFetch(fakeConnect(() => conn).fn)('https://k.example/', init(['1.1.1.1'])), TypeError);
    assert(state.closed, answer);
  }
  const huge = fakeConn([`HTTP/1.1 200 OK\r\nX-Big: ${'a'.repeat(70 * 1024)}\r\n\r\n`]);
  await assertRejects(() => createPinnedFetch(fakeConnect(() => huge.conn).fn)('https://k.example/', init(['1.1.1.1'])), TypeError, 'too large');
});

Deno.test('pinned fetch refuses a header value with a line break, before sending anything', async () => {
  const { conn, state } = fakeConn([OK]);
  const bad = { ...init(['1.1.1.1']), headers: { 'user-agent': 'x\r\nHost: evil' } };
  await assertRejects(() => createPinnedFetch(fakeConnect(() => conn).fn)('https://k.example/', bad), TypeError, 'line break');
  assertEquals(state.written, '');
  assert(state.closed);
});

Deno.test('pinned fetch does not connect when already aborted, and closes the connection on abort', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const connect = fakeConnect(() => fakeConn([OK]).conn);
  await assertRejects(() => createPinnedFetch(connect.fn)('https://k.example/', init(['1.1.1.1'], controller.signal)), Error, 'stop');
  assertEquals(connect.dials, []);

  const later = new AbortController();
  const { conn, state } = fakeConn(['HTTP/1.1 200 OK\r\n\r\nstart']);
  const response = await createPinnedFetch(fakeConnect(() => conn).fn)('https://k.example/', init(['1.1.1.1'], later.signal));
  later.abort();
  assert(state.closed);
  await response.body!.cancel();
});
