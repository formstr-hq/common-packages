import { afterEach, describe, expect, it } from 'vitest';
import {
  claimMailbox,
  createIdentity,
  type ClaimOutcome,
  type FetchJson,
  type PaymentWatcher,
  type WebSocketFactory,
} from '../src/index.js';

const INVOICE = 'lnbc210n1pn4wner...';
const PAYMENT_HASH = 'f'.repeat(64);
const AMOUNT = 21;

class FakeWs implements PaymentWatcher {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = 0;
  close(): void {
    this.closed++;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** FetchJson fake that answers availability probes, invoice POSTs and binding polls.
 * Call sequencing mirrors the real flow: the FIRST GET is the availability
 * probe (name free), later GETs are binding polls reporting `lines.names`. */
function fakeFetch(lines: {
  /** Names reported by binding polls (GETs after the POST). */
  names?: Record<string, string>;
  /** Response for the invoice POST. */
  post?: { ok: boolean; status: number; body: unknown };
  /** Throw on call n (1-based) — e.g. to simulate a flaky availability probe. */
  throwOn?: number;
  /** Capture of calls for assertions. */
  log?: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[];
}): FetchJson {
  let calls = 0;
  return async (url, init) => {
    calls++;
    lines.log?.push({ url, init });
    if (lines.throwOn === calls) throw new Error('network down');
    if (init?.method === 'POST') {
      return lines.post ?? { ok: true, status: 200, body: {} };
    }
    return { ok: true, status: 200, body: { names: calls > 1 ? (lines.names ?? {}) : {} } };
  };
}

async function claim(
  opts: Partial<Parameters<typeof claimMailbox>[1]> &
    { fetchJson?: FetchJson; secretKey?: Uint8Array } = {},
): Promise<{ outcome: ClaimOutcome; opts: Parameters<typeof claimMailbox>[1] }> {
  const { secretKey, ...rest } = opts;
  const sk = secretKey ?? createIdentity().secretKey;
  const full = {
    name: 'irona',
    payInvoice: async () => {}, // success no-op; failing-payer tests override
    WebSocket: null,
    timeoutMs: 30,
    pollIntervalMs: 0,
    // Real default delay (setTimeout 0): lets WS close timers interleave.
    ...rest,
  } as Parameters<typeof claimMailbox>[1];
  const outcome = await claimMailbox(sk, full);
  return { outcome, opts: full };
}

afterEach(() => {
  // Tests that swap in a fake global WebSocket must not leak it.
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

describe('claimMailbox — early exits', () => {
  it('name-taken: refuses before any invoice request or payment when the name is bound', async () => {
    let posted = false;
    let paid = false;
    const { outcome } = await claim({
      fetchJson: async (url, init) => {
        if (init?.method === 'POST') posted = true;
        return { ok: true, status: 200, body: { names: { irona: 'someone-else' } } };
      },
      payInvoice: async () => {
        paid = true;
      },
    });
    expect(outcome.status).toBe('name-taken');
    expect(posted).toBe(false);
    expect(paid).toBe(false);
  });

  it('proceeds when the availability probe returns non-ok or throws', async () => {
    const { outcome } = await claim({
      fetchJson: fakeFetch({ throwOn: 1, post: { ok: true, status: 200, body: {} } }),
    });
    expect(outcome.status).toBe('invoice-shape-unexpected');
  });

  it('invoice-request-failed: POST rejected with a status and body detail', async () => {
    const { outcome } = await claim({
      fetchJson: fakeFetch({ post: { ok: false, status: 402, body: 'payment required' } }),
    });
    expect(outcome).toEqual({
      status: 'invoice-request-failed',
      httpStatus: 402,
      detail: 'payment required',
    });
  });

  it('invoice-shape-unexpected: 200 without invoice/paymentHash fields', async () => {
    const { outcome } = await claim({
      fetchJson: fakeFetch({ post: { ok: true, status: 200, body: { hello: 1 } } }),
    });
    expect(outcome.status).toBe('invoice-shape-unexpected');
    expect(outcome as { detail: string }).toHaveProperty('detail', '{"hello":1}');
  });

  it('payment-failed: surfaces the payer error', async () => {
    const { outcome } = await claim({
      fetchJson: fakeFetch({
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH, amount: AMOUNT } },
      }),
      payInvoice: async () => {
        throw new Error('insufficient balance');
      },
    });
    expect(outcome).toEqual({ status: 'payment-failed', error: 'Error: insufficient balance' });
  });
});

describe('claimMailbox — happy paths', () => {
  it('claimed: pays, watches WS for paid, polls until the name binds to us', async () => {
    const id = createIdentity();
    const payerCalls: { invoice: string; amountSats: number | undefined }[] = [];
    const log: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    const ws = new FakeWs();
    const wsFactory: WebSocketFactory = (url) => {
      expect(url).toContain(`wss://api.formstr.app/ws?hash=${encodeURIComponent(PAYMENT_HASH)}`);
      queueMicrotask(() => {
        ws.emit('not json');
        ws.emit(JSON.stringify({ status: 'paid' }));
      });
      return ws;
    };
    const { outcome } = await claim({
      secretKey: id.secretKey,
      fetchJson: fakeFetch({
        names: { irona: id.pubkey },
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH, amount: AMOUNT } },
        log,
      }),
      payInvoice: async (invoice, amountSats) => {
        payerCalls.push({ invoice, amountSats });
        return { preimage: 'preimage-0123' };
      },
      WebSocket: wsFactory,
    });
    expect(payerCalls).toEqual([{ invoice: INVOICE, amountSats: AMOUNT }]);
    expect(outcome).toEqual({
      status: 'claimed',
      preimage: 'preimage-0123',
      nip05: 'irona@mailstr.app',
      pubkey: id.pubkey,
      npub: id.npub,
      paymentHash: PAYMENT_HASH,
      amountSats: AMOUNT,
    });
    // The invoice POST carried a NIP-98 Authorization header for that exact URL.
    const post = log.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('https://api.formstr.app/api/generate-invoice/mail');
    expect(post!.init!.headers!.Authorization.startsWith('Nostr ')).toBe(true);
    expect(post!.init!.body).toBe(
      JSON.stringify({ pubkey: id.pubkey, nip05: 'irona@mailstr.app', tierId: 'base' }),
    );
  });

  it('claimed: void-returning payer works (no preimage)', async () => {
    const id = createIdentity();
    const { outcome } = await claim({
      secretKey: id.secretKey,
      fetchJson: fakeFetch({
        names: { irona: id.pubkey },
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH } },
      }),
      payInvoice: async () => {},
    });
    expect(outcome.status).toBe('claimed');
    if (outcome.status === 'claimed') expect(outcome.preimage).toBeNull();
  });

  it('paid-binding-pending: WS confirmed payment and someone else holds the name', async () => {
    const ws = new FakeWs();
    const { outcome } = await claim({
      fetchJson: fakeFetch({
        names: { irona: 'not-us' },
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH } },
      }),
      WebSocket: () => {
        queueMicrotask(() => ws.emit(JSON.stringify({ status: 'paid' })));
        return ws;
      },
    });
    expect(outcome.status).toBe('paid-binding-pending');
  });

  it('payment-sent-binding-unverified: deadline passes with no binding and no WS', async () => {
    const { outcome } = await claim({
      fetchJson: fakeFetch({
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH, amount: AMOUNT } },
      }),
    });
    expect(outcome.status).toBe('payment-sent-binding-unverified');
  });

  it('falls back to polling when the WebSocket cannot even be constructed', async () => {
    const { outcome } = await claim({
      fetchJson: fakeFetch({
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH } },
      }),
      WebSocket: () => {
        throw new Error('no sockets here');
      },
    });
    expect(outcome.status).toBe('payment-sent-binding-unverified');
  });

  it('uses globalThis.WebSocket when available and injects no factory', async () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWs;
    const { outcome } = await claim({
      fetchJson: fakeFetch({
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH } },
      }),
      // Explicit undefined: override the helper's default null so the SDK's
      // default factory (globalThis.WebSocket lookup) is what runs.
      WebSocket: undefined,
      timeoutMs: 40,
    });
    // The default factory created a socket; it never said "paid", then timed out.
    expect(outcome.status).toBe('payment-sent-binding-unverified');
  });

  it('keeps polling when a binding check fails mid-way (flaky NIP-05 fetch)', async () => {
    const id = createIdentity();
    // calls: 1 avail GET, 2 invoice POST, 3 binding poll (throws), 4 binding → claimed.
    const { outcome } = await claim({
      secretKey: id.secretKey,
      fetchJson: fakeFetch({
        names: { irona: id.pubkey },
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH } },
        throwOn: 3,
      }),
      timeoutMs: 60,
    });
    expect(outcome.status).toBe('claimed');
  });

  it('closes the payment socket after wsTimeoutMs', async () => {
    const ws = new FakeWs();
    await claim({
      fetchJson: fakeFetch({
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH } },
      }),
      WebSocket: () => ws,
      wsTimeoutMs: 10,
      timeoutMs: 60,
    });
    expect(ws.closed).toBeGreaterThanOrEqual(1);
  });

  it('uses the default delay (not injected) with real timers', async () => {
    const { outcome } = await claim({
      fetchJson: fakeFetch({
        post: { ok: true, status: 200, body: { invoice: INVOICE, paymentHash: PAYMENT_HASH } },
      }),
      timeoutMs: 25,
    });
    expect(outcome.status).toBe('payment-sent-binding-unverified');
  });
});

describe('claimMailbox — event types', () => {
  it('all statuses exist and the outcome object is narrowable', () => {
    const statuses: ClaimOutcome['status'][] = [
      'name-taken',
      'invoice-request-failed',
      'invoice-shape-unexpected',
      'payment-failed',
      'claimed',
      'paid-binding-pending',
      'payment-sent-binding-unverified',
    ];
    expect(statuses).toHaveLength(7);
  });
});