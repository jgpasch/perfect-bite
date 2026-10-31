// A fetch that connects to an address fetch-page already checked, instead of resolving the host
// again, so a DNS answer that changes after the check (rebinding) can't move the connection to a
// private address. The Edge runtime's `Deno.createHttpClient` can't pin an address (its proxy is a
// URL only), so this opens the TCP connection itself, starts TLS with the URL's host name (SNI and
// certificate check), and speaks HTTP/1.1: one GET, `Connection: close`, no redirects followed.
// The response body is Content-Length, chunked or read to close, and gzip/deflate is decoded.

export type PinnedConn = {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): void;
};

/** Opens a connection to exactly `address`; with `tlsHostname`, starts TLS for that name. */
export type Connect = (options: { address: string; port: number; tlsHostname: string | null }) => Promise<PinnedConn>;

export type PinnedRequestInit = RequestInit & {
  /** Addresses already checked for the URL's host, tried in order. The host is never resolved. */
  addresses: string[];
  signal: AbortSignal;
  headers: Record<string, string>;
};

/** Sends a GET to `url` over a connection to one of `init.addresses`. Redirects are returned, not followed. */
export type PinnedFetch = (url: string, init: PinnedRequestInit) => Promise<Response>;

const MAX_HEADER_BYTES = 64 * 1024;

export const connectDeno: Connect = async ({ address, port, tlsHostname }) => {
  const tcp = await Deno.connect({ hostname: address, port });
  if (tlsHostname === null) return tcp;
  try {
    return await Deno.startTls(tcp, { hostname: tlsHostname });
  } catch (error) {
    closeQuietly(tcp);
    throw error;
  }
};

function closeQuietly(conn: PinnedConn): void {
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}

/** Buffered reads off a connection: header lines, then body bytes. */
class ConnReader {
  private buffer = new Uint8Array(0);

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await this.reader.read();
    } catch (error) {
      // Many servers close after the response without a TLS close_notify. Browsers take that as
      // the end of the connection, and so does this: Content-Length and chunked bodies still fail
      // when it comes early.
      if (error instanceof Deno.errors.UnexpectedEof) return false;
      throw error;
    }
    const { done, value } = result;
    if (done) return false;
    const next = new Uint8Array(this.buffer.byteLength + value.byteLength);
    next.set(this.buffer);
    next.set(value, this.buffer.byteLength);
    this.buffer = next;
    return true;
  }

  /** One line without its CRLF (or bare LF), read as Latin-1. */
  async line(maxBytes: number): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf(0x0a);
      if (end !== -1) {
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        return new TextDecoder('latin1').decode(line).replace(/\r$/, '');
      }
      if (this.buffer.byteLength > maxBytes) throw new TypeError('Response header too large');
      if (!(await this.fill())) throw new TypeError('Connection closed before the response header ended');
    }
  }

  /** Up to `max` bytes, or null when the connection has closed. */
  async take(max: number): Promise<Uint8Array | null> {
    if (this.buffer.byteLength === 0 && !(await this.fill())) return null;
    const out = this.buffer.subarray(0, Math.min(max, this.buffer.byteLength));
    this.buffer = this.buffer.subarray(out.byteLength);
    return out;
  }
}

type Head = { status: number; headers: Headers };

async function readHead(reader: ConnReader): Promise<Head> {
  for (;;) {
    const statusLine = await reader.line(MAX_HEADER_BYTES);
    const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
    if (!match) throw new TypeError('Not an HTTP/1.1 response');
    const status = Number(match[1]);
    const headers = new Headers();
    let size = statusLine.length;
    for (;;) {
      const line = await reader.line(MAX_HEADER_BYTES);
      size += line.length;
      if (size > MAX_HEADER_BYTES) throw new TypeError('Response header too large');
      if (line === '') break;
      const colon = line.indexOf(':');
      if (colon <= 0) throw new TypeError('Malformed response header');
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    // 1xx answers (100 Continue, 103 Early Hints) come before the real one.
    if (status >= 200) return { status, headers };
  }
}

/** The body's bytes as the response frames them, without the framing. */
function bodySource(reader: ConnReader, head: Head): () => Promise<Uint8Array | null> {
  const encoding = head.headers.get('transfer-encoding')?.toLowerCase() ?? '';
  if (encoding.split(',').map((part) => part.trim()).includes('chunked')) {
    let left = 0;
    let finished = false;
    return async () => {
      if (finished) return null;
      if (left === 0) {
        const size = parseInt((await reader.line(MAX_HEADER_BYTES)).split(';')[0].trim(), 16);
        if (!Number.isFinite(size) || size < 0) throw new TypeError('Malformed chunk size');
        if (size === 0) {
          while ((await reader.line(MAX_HEADER_BYTES)) !== '') {
            // Trailers are ignored.
          }
          finished = true;
          return null;
        }
        left = size;
      }
      const chunk = await reader.take(left);
      if (!chunk) throw new TypeError('Connection closed in the middle of a chunk');
      left -= chunk.byteLength;
      if (left === 0) await reader.line(MAX_HEADER_BYTES); // the CRLF after the chunk
      return chunk;
    };
  }
  const length = head.headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/.test(length.trim())) throw new TypeError('Malformed Content-Length');
    let left = Number(length.trim());
    return async () => {
      if (left === 0) return null;
      const chunk = await reader.take(left);
      if (!chunk) throw new TypeError('Connection closed before Content-Length bytes');
      left -= chunk.byteLength;
      return chunk;
    };
  }
  return () => reader.take(64 * 1024);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted', 'AbortError');
}

/** A PinnedFetch over `connect`. Each request gets its own connection, closed with the body. */
export function createPinnedFetch(connect: Connect = connectDeno): PinnedFetch {
  return async (url, init) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new TypeError(`${target.protocol} is not http(s)`);
    const { signal } = init;
    if (signal.aborted) throw abortError(signal);
    const https = target.protocol === 'https:';
    const port = target.port ? Number(target.port) : https ? 443 : 80;
    const tlsHostname = https ? target.hostname.replace(/^\[|\]$/g, '') : null;

    let conn: PinnedConn | null = null;
    let lastError: unknown = new TypeError('No address to connect to');
    for (const address of init.addresses) {
      try {
        conn = await connect({ address, port, tlsHostname });
        break;
      } catch (error) {
        lastError = error;
      }
      if (signal.aborted) break;
    }
    if (!conn) throw signal.aborted ? abortError(signal) : lastError;
    const open = conn;
    const close = () => closeQuietly(open);
    if (signal.aborted) {
      close();
      throw abortError(signal);
    }
    signal.addEventListener('abort', close, { once: true });

    try {
      const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`];
      for (const [name, value] of Object.entries(init.headers)) {
        if (/[\r\n]/.test(name + value)) throw new TypeError('Header with a line break');
        lines.push(`${name}: ${value}`);
      }
      lines.push('Accept-Encoding: gzip, deflate', 'Connection: close', '', '');
      const writer = open.writable.getWriter();
      await writer.write(new TextEncoder().encode(lines.join('\r\n')));
      writer.releaseLock();

      const reader = new ConnReader(open.readable.getReader());
      const head = await readHead(reader);
      const nullBody = head.status === 204 || head.status === 205 || head.status === 304;
      const next = bodySource(reader, head);
      let body: ReadableStream<Uint8Array> | null = null;
      if (nullBody) {
        close();
      } else {
        body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await next();
              if (chunk) {
                controller.enqueue(chunk);
              } else {
                controller.close();
                close();
              }
            } catch (error) {
              controller.error(error);
              close();
            }
          },
          cancel: close,
        }, { highWaterMark: 0 });
        const contentEncoding = head.headers.get('content-encoding')?.trim().toLowerCase();
        if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip' || contentEncoding === 'deflate') {
          const decompress = new DecompressionStream(contentEncoding === 'deflate' ? 'deflate' : 'gzip');
          body = body.pipeThrough(decompress as unknown as TransformStream<Uint8Array, Uint8Array>);
        }
      }
      return new Response(body, { status: head.status, headers: head.headers });
    } catch (error) {
      close();
      signal.removeEventListener('abort', close);
      throw signal.aborted ? abortError(signal) : error;
    }
  };
}
